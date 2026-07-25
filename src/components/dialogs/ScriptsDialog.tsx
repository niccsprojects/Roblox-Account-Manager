import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useStore } from "../../store";
import { useModalClose } from "../../hooks/useModalClose";
import { useConfirm, usePrompt } from "../../hooks/usePrompt";
import { useTr } from "../../i18n/text";
import {
  SCRIPT_SECURITY_LIMITS,
  assertScriptPermission,
  buildScriptSettingsSection,
  getScriptSecuritySignature,
  normalizeScriptHttpUrl,
  normalizeWebSocketUrl,
  sanitizeScriptSourceForSave,
  truncateForLog,
  utf8ByteLength,
} from "../../scripting/security";
import { createScriptWorker } from "../../scripting/workerSource";
import { Select } from "../ui/Select";
import { MenuItemView, MenuLevel } from "../menus/MenuItemView";
import type { MenuItem } from "../menus/MenuItemView";
import type {
  ManagedScript,
  ScriptLogEntry,
  ScriptLogLevel,
  ScriptPermissions,
  ScriptRuntimeState,
  ScriptUiElement,
  ScriptWindowSnapshot,
  WorkerIncomingMessage,
} from "../../scripting/types";

type ScriptTabId = "editor" | "ui" | "logs" | "api";

interface ScriptsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface SavePickerWritable {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
}

interface SavePickerHandle {
  createWritable: () => Promise<SavePickerWritable>;
}

interface SavePickerApi {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SavePickerHandle>;
}

interface WorkerRuntime {
  worker: Worker;
  runtimeId: string;
  pending: Map<
    string,
    {
      action: string;
      startedAtMs: number;
      abortControllers: Set<AbortController>;
    }
  >;
  sockets: Map<string, WebSocket>;
}

interface ScriptContextMenuState {
  scriptId: string;
  x: number;
  y: number;
}

const ALLOWED_HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const SCRIPT_INVOKE_COMMANDS = [
  "get_accounts",
  "update_account",
  "add_account",
  "remove_account",
  "validate_cookie",
  "launch_roblox",
  "launch_multiple",
  "cmd_kill_roblox",
  "cmd_kill_all_roblox",
  "get_presence",
  "start_botting_mode",
  "stop_botting_mode",
  "get_botting_mode_status",
  "add_botting_accounts",
  "set_botting_player_accounts",
  "botting_account_action",
  "start_afk_mode",
  "stop_afk_mode",
  "get_afk_mode_status",
  "afk_trigger_now",
  "start_generator",
  "stop_generator",
  "get_generator_status",
  "generator_test_key",
  "start_web_server",
  "stop_web_server",
  "start_nexus_server",
  "stop_nexus_server",
  "nexus_send_command",
  "get_theme",
] as const;

const ALLOWED_INVOKE_COMMANDS = new Set<string>(SCRIPT_INVOKE_COMMANDS);

const WS_CLOSE_REASON_MAX_CHARS = 123;

const DEFAULT_SCRIPT_SOURCE = `
ram.info("Script loaded");

ram.on("window:update", (snapshot) => {
  const online = Object.values(snapshot.presenceByUserId || {}).filter((state) => state >= 1).length;
  ram.ui.set([
    { id: "status", type: "badge", text: "Online: " + online, tone: online > 0 ? "success" : "warn" },
    { id: "refresh", type: "button", label: "Refresh Snapshot", text: "Refresh Snapshot" },
    { id: "note", type: "textarea", label: "Notes", placeholder: "Write script notes...", rows: 4 },
  ]);
});

ram.ui.on(async (event) => {
  if (event.id === "refresh" && event.action === "click") {
    const snapshot = await ram.window.snapshot();
    ram.info("Selected users:", snapshot.selectedUserIds);
  }
});

const snapshot = await ram.window.snapshot();
ram.info("Loaded", snapshot.accounts.length, "accounts");
`;

const DISCORD_BRIDGE_TEMPLATE = `
const endpoint = await ram.settings.get("endpoint", "http://127.0.0.1:3847/ram/bridge");
const wsEndpoint = await ram.settings.get("wsEndpoint", "");
const authToken = await ram.settings.get("token", "");
const intervalMs = Number(await ram.settings.get("intervalMs", 5000));
let wsConnectionId = "";

ram.info("Discord bridge started", endpoint);

if (wsEndpoint) {
  try {
    const ws = await ram.ws.connect({ url: wsEndpoint, allowPrivateNetwork: true });
    wsConnectionId = ws.connectionId;
    ram.info("Connected to websocket bridge", wsConnectionId);
  } catch (error) {
    ram.warn("WebSocket bridge unavailable, falling back to HTTP polling", error);
  }
}

ram.ws.on(async (event) => {
  if (!wsConnectionId || event.connectionId !== wsConnectionId) return;
  if (event.event !== "message") return;

  const payload = event.json;
  if (!payload || !Array.isArray(payload.actions)) return;

  for (const action of payload.actions) {
    if (action.type === "launch" && typeof action.userId === "number") {
      await ram.invoke("launch_roblox", {
        userId: action.userId,
        placeId: Number(action.placeId || 0),
        jobId: String(action.jobId || ""),
        launchData: String(action.launchData || ""),
        followUser: false,
        joinVip: false,
        linkCode: "",
        shuffleJob: false,
      });
    }

    if (action.type === "close" && typeof action.userId === "number") {
      await ram.invoke("cmd_kill_roblox", { userId: action.userId });
    }
  }
});

async function postStatus() {
  const snapshot = await ram.window.snapshot();
  const payload = {
    sentAt: Date.now(),
    accounts: snapshot.accounts,
    selectedUserIds: snapshot.selectedUserIds,
    presenceByUserId: snapshot.presenceByUserId,
    launchedUserIds: snapshot.launchedUserIds,
  };

  const response = await ram.http.request({
    url: endpoint + "/status",
    method: "POST",
    allowPrivateNetwork: true,
    headers: {
      "content-type": "application/json",
      ...(authToken ? { authorization: "Bearer " + authToken } : {}),
    },
    body: payload,
    timeoutMs: 8000,
  });

  if (!response.ok) {
    ram.warn("Status push failed", response.status, response.text);
    return;
  }

  if (response.json && Array.isArray(response.json.actions)) {
    for (const action of response.json.actions) {
      if (action.type === "launch" && typeof action.userId === "number") {
        await ram.invoke("launch_roblox", {
          userId: action.userId,
          placeId: Number(action.placeId || 0),
          jobId: String(action.jobId || ""),
          launchData: String(action.launchData || ""),
          followUser: false,
          joinVip: false,
          linkCode: "",
          shuffleJob: false,
        });
      }

      if (action.type === "close" && typeof action.userId === "number") {
        await ram.invoke("cmd_kill_roblox", { userId: action.userId });
      }
    }
  }

  if (wsConnectionId) {
    await ram.ws.send(wsConnectionId, {
      type: "status",
      payload,
    });
  }
}

while (true) {
  try {
    await postStatus();
  } catch (error) {
    ram.error("Bridge error", error);
  }
  await ram.sleep(intervalMs);
}
`;

const HUB_LINK_TEMPLATE = `
const DEVICE_ID_KEY = "deviceId";

function asText(value, fallback) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

function asBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function asInt(value, fallback, min, max) {
  const raw = value === null || value === undefined ? "" : value;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return null;
  }
}

function trimTrailingSlash(url) {
  let s = String(url || "");
  while (s.length > 0 && s.charAt(s.length - 1) === "/") {
    s = s.slice(0, s.length - 1);
  }
  return s;
}

function deriveWsUrl(hubUrl) {
  const base = trimTrailingSlash(hubUrl);
  if (base.indexOf("https://") === 0) return "wss://" + base.slice(8) + "/agent";
  if (base.indexOf("http://") === 0) return "ws://" + base.slice(7) + "/agent";
  return base + "/agent";
}

function normalizeAction(value) {
  const v = asText(value, "");
  if (!v) return "";
  const lower = v.charAt(0).toLowerCase() + v.slice(1);
  const allowed = ["disconnect", "close", "closeDisconnect", "restartClient", "restartLoop"];
  return allowed.includes(lower) ? lower : "";
}

const state = {
  hubUrl: "",
  wsUrl: "",
  deviceId: "",
  deviceToken: "",
  instanceId: "",
  pairingCode: "",
  publishIntervalMs: 4000,
  enabled: true,
  pauseActions: false,
  wsConnectionId: "",
  wsState: "DISCONNECTED",
  wsHelloSent: false,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  reconnectAttempt: 0,
  nextAttemptAtMs: 0,
  lastPublishAtMs: 0,
  lastError: "",
};

const handledCommandIds = new Map();

async function loadConfig() {
  state.hubUrl = trimTrailingSlash(asText(await ram.settings.get("hubUrl", ""), ""));
  state.wsUrl = asText(await ram.settings.get("wsUrl", ""), "");
  state.deviceId = asText(await ram.settings.get(DEVICE_ID_KEY, ""), "");
  state.deviceToken = asText(await ram.settings.get("deviceToken", ""), "");
  state.instanceId = asText(await ram.settings.get("instanceId", ""), "");
  state.publishIntervalMs = asInt(await ram.settings.get("publishIntervalMs", "4000"), 4000, 1000, 60000);
  state.enabled = asBool(await ram.settings.get("enabled", "true"), true);
  state.pauseActions = asBool(await ram.settings.get("pauseActions", "false"), false);
  if (!state.deviceId) {
    state.deviceId = "dev-" + ram.randomId();
    await ram.settings.set(DEVICE_ID_KEY, state.deviceId);
  }
  if (!state.wsUrl && state.hubUrl) {
    state.wsUrl = deriveWsUrl(state.hubUrl);
  }
}

function connTone() {
  if (state.wsState === "OPEN") return "success";
  if (state.wsState === "ERROR") return "error";
  return "warn";
}

function lastPublishText() {
  if (!state.lastPublishAtMs) return "Last push: never";
  return "Last push: " + new Date(state.lastPublishAtMs).toLocaleTimeString();
}

function lastErrorText() {
  return state.lastError ? "Last error: " + state.lastError : "Last error: none";
}

function renderUi() {
  const paired = !!state.deviceToken;
  const items = [
    { id: "conn", type: "badge", text: "Hub: " + state.wsState, tone: connTone() },
    { id: "instance", type: "badge", text: "Instance: " + (state.instanceId || "unpaired"), tone: "accent" },
    { id: "last_publish", type: "badge", text: lastPublishText(), tone: "default" },
    { id: "last_error", type: "badge", text: lastErrorText(), tone: state.lastError ? "error" : "default" },
    { id: "divider_1", type: "divider" },
  ];
  if (!paired) {
    items.push({ id: "hub_url", type: "text", label: "Hub URL", value: state.hubUrl, placeholder: "https://your-hub.up.railway.app" });
    items.push({ id: "pairing_code", type: "text", label: "Pairing code", value: state.pairingCode, placeholder: "ABCD-EFGH" });
    items.push({ id: "pair", type: "button", text: "Pair with hub" });
  } else {
    items.push({ id: "pause_actions", type: "toggle", label: "Pause remote actions", value: state.pauseActions });
    items.push({ id: "reconnect", type: "button", text: "Reconnect" });
    items.push({ id: "unpair", type: "button", text: "Unpair" });
  }
  ram.ui.set(items);
}

function patchUi() {
  ram.ui.patch("conn", { text: "Hub: " + state.wsState, tone: connTone() });
  ram.ui.patch("instance", { text: "Instance: " + (state.instanceId || "unpaired") });
  ram.ui.patch("last_publish", { text: lastPublishText() });
  ram.ui.patch("last_error", { text: lastErrorText(), tone: state.lastError ? "error" : "default" });
}

function setLastError(error) {
  state.lastError = typeof error === "string" ? error : String(error);
  ram.error(state.lastError);
  patchUi();
}

function rememberCommand(id) {
  if (!id) return;
  handledCommandIds.set(id, Date.now());
  if (handledCommandIds.size > 5000) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const entry of handledCommandIds.entries()) {
      if (entry[1] < cutoff) handledCommandIds.delete(entry[0]);
    }
  }
}

async function sendWs(payload) {
  if (!state.wsConnectionId || state.wsState !== "OPEN") return false;
  try {
    await ram.ws.send(state.wsConnectionId, payload);
    return true;
  } catch (error) {
    scheduleReconnect(String(error));
    return false;
  }
}

async function sendHello() {
  if (state.wsHelloSent) return;
  if (!state.wsConnectionId || state.wsState !== "OPEN") return;
  const ok = await sendWs({
    type: "hello",
    deviceToken: state.deviceToken,
    deviceId: state.deviceId,
    instanceId: state.instanceId,
    ramVersion: "4",
    capabilities: ["status", "commands"],
  });
  if (ok) state.wsHelloSent = true;
}

function scheduleReconnect(reason) {
  state.wsConnectionId = "";
  state.wsState = "DISCONNECTED";
  state.wsHelloSent = false;
  state.reconnectAttempt += 1;
  const raw = Math.min(state.reconnectMaxMs, state.reconnectBaseMs * Math.pow(2, state.reconnectAttempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(1000, Math.max(100, raw * 0.2)));
  state.nextAttemptAtMs = Date.now() + raw + jitter;
  if (reason) ram.warn("Hub reconnect scheduled", reason);
  patchUi();
}

async function connectIfNeeded() {
  if (!state.enabled) return;
  if (!state.deviceToken || !state.wsUrl) return;
  if (state.wsConnectionId) return;
  if (Date.now() < state.nextAttemptAtMs) return;
  try {
    state.wsState = "CONNECTING";
    patchUi();
    const result = await ram.ws.connect({ url: state.wsUrl });
    state.wsConnectionId = String(result.connectionId || "");
    state.wsState = asText(result.state, "CONNECTING").toUpperCase();
    state.wsHelloSent = false;
    await sendHello();
    patchUi();
  } catch (error) {
    scheduleReconnect(String(error));
  }
}

async function moveToGroup(userId, group) {
  const accounts = await ram.invoke("get_accounts", {});
  const list = Array.isArray(accounts) ? accounts : [];
  let found = null;
  for (const acc of list) {
    if (Number(acc.UserID) === Number(userId)) {
      found = acc;
      break;
    }
  }
  if (!found) throw new Error("account not found: " + userId);
  found.Group = group;
  await ram.invoke("update_account", { account: found });
}

async function runCommand(name, args) {
  const a = args && typeof args === "object" ? args : {};
  if (name === "list_accounts") {
    const accounts = await ram.invoke("get_accounts", {});
    return { accounts };
  }
  if (name === "add_account_cookie") {
    const cookie = asText(a.cookie, "");
    if (!cookie) throw new Error("missing cookie");
    const info = await ram.invoke("validate_cookie", { cookie });
    const userId = Number(info && info.user_id) || 0;
    const username = asText(info && info.name, "");
    await ram.invoke("add_account", {
      securityToken: cookie,
      username,
      userId,
      password: a.password ? String(a.password) : null,
    });
    if (a.group) {
      await moveToGroup(userId, String(a.group));
    }
    return { userId, username };
  }
  if (name === "remove_account") {
    const removed = await ram.invoke("remove_account", { userId: Number(a.userId) });
    return { removed };
  }
  if (name === "move_to_group") {
    const ids = Array.isArray(a.userIds) ? a.userIds : (a.userId !== undefined ? [a.userId] : []);
    for (const id of ids) await moveToGroup(Number(id), String(a.group || ""));
    return { moved: ids.length };
  }
  if (name === "start_generator") {
    return await ram.invoke("start_generator", {
      provider: asText(a.provider, "BloxGen"),
      endpoint: asText(a.endpoint, ""),
      apiKey: asText(a.apiKey, ""),
      accountType: asText(a.accountType, ""),
      extraDelaySeconds: asInt(a.extraDelaySeconds, 1, 0, 3600),
      targetGroup: asText(a.targetGroup, ""),
      maxAccounts: asInt(a.maxAccounts, 0, 0, 1000000),
    });
  }
  if (name === "stop_generator") {
    await ram.invoke("stop_generator", {});
    return { ok: true };
  }
  if (name === "generator_test_key") {
    const balance = await ram.invoke("generator_test_key", {
      provider: asText(a.provider, "BloxGen"),
      endpoint: asText(a.endpoint, ""),
      apiKey: asText(a.apiKey, ""),
    });
    return { balance };
  }
  if (name === "start_botting") {
    return await ram.invoke("start_botting_mode", {
      userIds: Array.isArray(a.userIds) ? a.userIds.map(Number) : [],
      placeId: Number(a.placeId) || 0,
      jobId: asText(a.jobId, ""),
      launchData: asText(a.launchData, ""),
      playerUserIds: Array.isArray(a.playerUserIds) ? a.playerUserIds.map(Number) : [],
      intervalMinutes: asInt(a.intervalMinutes, 30, 1, 1000000),
      launchDelaySeconds: asInt(a.launchDelaySeconds, 10, 0, 1000000),
      playerGraceMinutes: asInt(a.playerGraceMinutes, 10, 0, 1000000),
    });
  }
  if (name === "stop_botting") {
    await ram.invoke("stop_botting_mode", { closeBotAccounts: asBool(a.closeBotAccounts, false) });
    return { ok: true };
  }
  if (name === "add_botting_accounts") {
    return await ram.invoke("add_botting_accounts", {
      userIds: Array.isArray(a.userIds) ? a.userIds.map(Number) : [],
    });
  }
  if (name === "set_botting_players") {
    const ids = Array.isArray(a.userIds) ? a.userIds : (Array.isArray(a.playerUserIds) ? a.playerUserIds : []);
    return await ram.invoke("set_botting_player_accounts", { playerUserIds: ids.map(Number) });
  }
  if (name === "botting_account_action") {
    const action = normalizeAction(a.action);
    if (!action) throw new Error("invalid action");
    return await ram.invoke("botting_account_action", { userId: Number(a.userId), action });
  }
  if (name === "ping") {
    return { pong: true };
  }
  throw new Error("unsupported command: " + name);
}

async function handleCommand(msg) {
  const id = asText(msg.id, "");
  const name = asText(msg.name, "");
  if (id && handledCommandIds.has(id)) return;
  if (state.pauseActions) {
    await sendWs({ type: "result", id, ok: false, error: "actions paused" });
    return;
  }
  try {
    const result = await runCommand(name, msg.args);
    if (id) rememberCommand(id);
    await sendWs({ type: "result", id, ok: true, result });
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    await sendWs({ type: "result", id, ok: false, error: message });
  }
  await publishStatus("command", true);
}

async function handleServerMessage(msg) {
  const type = asText(msg.type, "");
  if (type === "helloAck") {
    if (msg.ok === false) {
      setLastError("pairing rejected: " + asText(msg.error, "unknown"));
      await unpair();
      return;
    }
    if (msg.instanceId) {
      state.instanceId = String(msg.instanceId);
      await ram.settings.set("instanceId", state.instanceId);
    }
    patchUi();
    return;
  }
  if (type === "ping") {
    await sendWs({ type: "pong", t: Date.now() });
    return;
  }
  if (type === "command") {
    await handleCommand(msg);
    return;
  }
}

async function publishStatus(trigger, full) {
  if (!state.wsConnectionId || state.wsState !== "OPEN") return;
  const snap = await ram.window.snapshot();
  const presence = snap.presenceByUserId || {};
  const launched = Array.isArray(snap.launchedUserIds) ? snap.launchedUserIds : [];
  const accounts = (snap.accounts || []).map((acc) => {
    const p = Number(presence[String(acc.userId)] || 0);
    return {
      userId: acc.userId,
      username: acc.username,
      alias: acc.alias,
      group: acc.group,
      valid: acc.valid,
      lastUse: acc.lastUse,
      presence: p,
      online: p >= 1,
      launched: launched.includes(acc.userId),
    };
  });
  const sent = await sendWs({
    type: "status",
    full: full === true,
    trigger,
    ts: Date.now(),
    instanceId: state.instanceId,
    placeId: snap.placeId,
    jobId: snap.jobId,
    botting: snap.botting || null,
    generator: snap.generator || null,
    accounts,
  });
  if (sent) {
    state.lastPublishAtMs = Date.now();
    state.lastError = "";
    patchUi();
  }
}

async function pair() {
  if (!state.hubUrl) {
    setLastError("set the hub URL first");
    return;
  }
  if (!state.pairingCode) {
    setLastError("enter a pairing code");
    return;
  }
  try {
    const response = await ram.http.request({
      url: state.hubUrl + "/agent/pair",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: {
        code: state.pairingCode,
        deviceId: state.deviceId,
        deviceName: "RAM",
        ramVersion: "4",
      },
      timeoutMs: 15000,
    });
    const data = response.json || parseJson(response.text);
    if (!response.ok || !data || !data.deviceToken) {
      const reason = data && data.error ? data.error : String(response.status);
      setLastError("pairing failed: " + reason);
      return;
    }
    state.deviceToken = String(data.deviceToken);
    state.instanceId = String(data.instanceId || "");
    state.wsUrl = asText(data.wsUrl, deriveWsUrl(state.hubUrl));
    await ram.settings.set("deviceToken", state.deviceToken);
    await ram.settings.set("instanceId", state.instanceId);
    await ram.settings.set("wsUrl", state.wsUrl);
    state.pairingCode = "";
    state.lastError = "";
    ram.info("Paired with hub", state.instanceId);
    renderUi();
  } catch (error) {
    setLastError("pairing error: " + String(error));
  }
}

async function unpair() {
  state.deviceToken = "";
  state.instanceId = "";
  await ram.settings.set("deviceToken", "");
  await ram.settings.set("instanceId", "");
  if (state.wsConnectionId) {
    try {
      await ram.ws.close(state.wsConnectionId, { code: 1000, reason: "unpair" });
    } catch (error) {
    }
  }
  state.wsConnectionId = "";
  state.wsState = "DISCONNECTED";
  renderUi();
}

ram.ws.on(async (evt) => {
  if (!evt || typeof evt !== "object") return;
  if (evt.connectionId && state.wsConnectionId && evt.connectionId !== state.wsConnectionId) return;
  if (evt.event === "open") {
    state.wsState = "OPEN";
    state.reconnectAttempt = 0;
    state.nextAttemptAtMs = 0;
    await sendHello();
    await publishStatus("open", true);
    patchUi();
    return;
  }
  if (evt.event === "error") {
    state.wsState = "ERROR";
    patchUi();
    return;
  }
  if (evt.event === "close") {
    state.wsHelloSent = false;
    scheduleReconnect((String(evt.code || "") + " " + String(evt.reason || "")).trim());
    return;
  }
  if (evt.event === "message") {
    const msg = evt.json || parseJson(evt.text);
    if (!msg || typeof msg !== "object") return;
    await handleServerMessage(msg);
  }
});

ram.ui.on(async (evt) => {
  if (!evt || typeof evt !== "object") return;
  if (evt.id === "hub_url" && evt.action === "change") {
    state.hubUrl = trimTrailingSlash(asText(evt.value, ""));
    await ram.settings.set("hubUrl", state.hubUrl);
    return;
  }
  if (evt.id === "pairing_code" && evt.action === "change") {
    state.pairingCode = asText(evt.value, "");
    return;
  }
  if (evt.id === "pair" && evt.action === "click") {
    await pair();
    return;
  }
  if (evt.id === "unpair" && evt.action === "click") {
    await unpair();
    return;
  }
  if (evt.id === "pause_actions" && evt.action === "change") {
    state.pauseActions = asBool(evt.value, state.pauseActions);
    await ram.settings.set("pauseActions", state.pauseActions ? "true" : "false");
    return;
  }
  if (evt.id === "reconnect" && evt.action === "click") {
    if (state.wsConnectionId) {
      try {
        await ram.ws.close(state.wsConnectionId, { code: 1000, reason: "manual" });
      } catch (error) {
      }
    }
    state.wsConnectionId = "";
    state.nextAttemptAtMs = 0;
    state.reconnectAttempt = 0;
    await connectIfNeeded();
    patchUi();
  }
});

await loadConfig();
renderUi();
ram.info("Hub Link started", { instanceId: state.instanceId, wsUrl: state.wsUrl });

while (true) {
  try {
    await connectIfNeeded();
    await publishStatus("interval", false);
  } catch (error) {
    setLastError(error);
  }
  await ram.sleep(state.publishIntervalMs);
}
`;

function nowMs(): number {
  return Date.now();
}

function buildId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

function defaultPermissions(): ScriptPermissions {
  return {
    allowInvoke: false,
    allowHttp: false,
    allowWebSocket: false,
    allowWindow: false,
    allowModal: false,
    allowSettings: false,
    allowUi: false,
  };
}

function allPermissions(): ScriptPermissions {
  return {
    allowInvoke: true,
    allowHttp: true,
    allowWebSocket: true,
    allowWindow: true,
    allowModal: true,
    allowSettings: true,
    allowUi: true,
  };
}

function trimToLength(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(0, maxChars);
}

function coerceScriptSource(source: unknown): string {
  return typeof source === "string" ? source : String(source || "");
}

function ensureScriptSourceSize(source: string): void {
  const bytes = utf8ByteLength(source);
  if (bytes > SCRIPT_SECURITY_LIMITS.maxScriptSourceBytes) {
    throw new Error(
      `Script source exceeds ${SCRIPT_SECURITY_LIMITS.maxScriptSourceBytes} bytes and was blocked`
    );
  }
}

function normalizeScript(input: ManagedScript): ManagedScript {
  const id = trimToLength(String(input.id || ""), SCRIPT_SECURITY_LIMITS.maxScriptIdChars);
  const normalizedName = trimToLength(
    String(input.name || "Unnamed Script"),
    SCRIPT_SECURITY_LIMITS.maxScriptNameChars
  );
  const source = coerceScriptSource(input.source);
  return {
    id,
    name: normalizedName || "Unnamed Script",
    description: trimToLength(
      String(input.description || ""),
      SCRIPT_SECURITY_LIMITS.maxScriptDescriptionChars
    ),
    language: String(input.language || "javascript"),
    source,
    enabled: Boolean(input.enabled),
    trusted: Boolean(input.trusted),
    autoStart: Boolean(input.autoStart),
    permissions: {
      ...defaultPermissions(),
      ...(input.permissions || {}),
    },
    createdAtMs: Number(input.createdAtMs || nowMs()),
    updatedAtMs: Number(input.updatedAtMs || nowMs()),
  };
}

function createScript(
  name: string,
  description: string,
  source: string,
  overrides?: Partial<Pick<ManagedScript, "trusted" | "autoStart" | "permissions">>
): ManagedScript {
  const ts = nowMs();
  const normalizedName = trimToLength(name, SCRIPT_SECURITY_LIMITS.maxScriptNameChars) || "New Script";
  const normalizedDescription = trimToLength(
    description,
    SCRIPT_SECURITY_LIMITS.maxScriptDescriptionChars
  );
  return {
    id: buildId("script"),
    name: normalizedName,
    description: normalizedDescription,
    language: "javascript",
    source,
    enabled: true,
    trusted: overrides?.trusted ?? false,
    autoStart: overrides?.autoStart ?? false,
    permissions: overrides?.permissions ?? defaultPermissions(),
    createdAtMs: ts,
    updatedAtMs: ts,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function safeMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function wsStateLabel(state: number): string {
  if (state === WebSocket.CONNECTING) return "CONNECTING";
  if (state === WebSocket.OPEN) return "OPEN";
  if (state === WebSocket.CLOSING) return "CLOSING";
  if (state === WebSocket.CLOSED) return "CLOSED";
  return String(state);
}

function normalizeLimitedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    return undefined;
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeUiId(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(text)) {
    return null;
  }
  return text;
}

function clampFiniteNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
}

function truncateTextByBytes(input: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(input);
  if (bytes.length <= maxBytes) {
    return { text: input, truncated: false };
  }
  const sliced = bytes.slice(0, maxBytes);
  const decoded = new TextDecoder().decode(sliced);
  return { text: decoded, truncated: true };
}

async function wsMessageToPayload(
  data: unknown
): Promise<{ text: string | null; json: unknown | null; truncated: boolean }> {
  const maxBytes = SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes;

  if (typeof data === "string") {
    const normalized = truncateTextByBytes(data, maxBytes);
    if (normalized.text.trim().length === 0) {
      return { text: normalized.text, json: null, truncated: normalized.truncated };
    }
    if (normalized.truncated) {
      return { text: normalized.text, json: null, truncated: true };
    }
    try {
      return { text: normalized.text, json: JSON.parse(normalized.text), truncated: false };
    } catch {
      return { text: normalized.text, json: null, truncated: false };
    }
  }

  if (data instanceof Blob) {
    const blob = data.size > maxBytes ? data.slice(0, maxBytes) : data;
    const text = await blob.text();
    const truncated = data.size > maxBytes;
    if (text.trim().length === 0) {
      return { text, json: null, truncated };
    }
    if (truncated) {
      return { text, json: null, truncated: true };
    }
    try {
      return { text, json: JSON.parse(text), truncated: false };
    } catch {
      return { text, json: null, truncated: false };
    }
  }

  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    const limited = bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;
    const text = new TextDecoder().decode(limited);
    const truncated = bytes.length > maxBytes;
    if (text.trim().length === 0) {
      return { text, json: null, truncated };
    }
    if (truncated) {
      return { text, json: null, truncated: true };
    }
    try {
      return { text, json: JSON.parse(text), truncated: false };
    } catch {
      return { text, json: null, truncated: false };
    }
  }

  return {
    text: null,
    json: null,
    truncated: false,
  };
}

function normalizeUiElements(input: unknown): ScriptUiElement[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const elements: ScriptUiElement[] = [];
  const seenIds = new Set<string>();
  const maxElements = SCRIPT_SECURITY_LIMITS.maxUiElements;

  for (const entry of input) {
    if (elements.length >= maxElements) {
      break;
    }

    const row = asRecord(entry);
    const id = normalizeUiId(row.id);
    const type = String(row.type || "").trim().toLowerCase();
    if (!id || !type || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    const normalized: ScriptUiElement = {
      id,
      type:
        type === "button" ||
        type === "text" ||
        type === "number" ||
        type === "toggle" ||
        type === "select" ||
        type === "textarea" ||
        type === "badge" ||
        type === "divider"
          ? type
          : "text",
      label: normalizeLimitedString(row.label, SCRIPT_SECURITY_LIMITS.maxUiTextChars),
      text: normalizeLimitedString(row.text, SCRIPT_SECURITY_LIMITS.maxUiTextChars),
      value:
        typeof row.value === "string"
          ? normalizeLimitedString(row.value, SCRIPT_SECURITY_LIMITS.maxUiTextChars)
          : typeof row.value === "number" && Number.isFinite(row.value)
            ? row.value
            : typeof row.value === "boolean"
              ? row.value
              : undefined,
      placeholder: normalizeLimitedString(row.placeholder, SCRIPT_SECURITY_LIMITS.maxUiTextChars),
      min: clampFiniteNumber(row.min, -1_000_000_000, 1_000_000_000),
      max: clampFiniteNumber(row.max, -1_000_000_000, 1_000_000_000),
      step: clampFiniteNumber(row.step, 0.000001, 1_000_000),
      rows: clampFiniteNumber(row.rows, 1, 24),
      width: clampFiniteNumber(row.width, 80, 1400),
      disabled: Boolean(row.disabled),
      tone:
        row.tone === "success" ||
        row.tone === "warn" ||
        row.tone === "error" ||
        row.tone === "accent"
          ? row.tone
          : "default",
      options: Array.isArray(row.options)
        ? row.options
            .slice(0, SCRIPT_SECURITY_LIMITS.maxUiOptionsPerElement)
            .map((option) => {
              const valueRow = asRecord(option);
              const label = normalizeLimitedString(
                valueRow.label ?? valueRow.value,
                SCRIPT_SECURITY_LIMITS.maxUiTextChars
              );
              const value = normalizeLimitedString(
                valueRow.value ?? valueRow.label,
                SCRIPT_SECURITY_LIMITS.maxUiTextChars
              );
              if (!label || !value) {
                return null;
              }
              return { label, value };
            })
            .filter((option): option is { label: string; value: string } => option !== null)
        : undefined,
    };

    elements.push(normalized);
  }

  return elements;
}

function applyUiPatch(elements: ScriptUiElement[], id: string, patch: unknown): ScriptUiElement[] {
  const delta = asRecord(patch);
  return elements.map((item) => {
    if (item.id !== id) {
      return item;
    }
    const next = { ...item };
    const label = normalizeLimitedString(delta.label, SCRIPT_SECURITY_LIMITS.maxUiTextChars);
    const text = normalizeLimitedString(delta.text, SCRIPT_SECURITY_LIMITS.maxUiTextChars);
    const placeholder = normalizeLimitedString(
      delta.placeholder,
      SCRIPT_SECURITY_LIMITS.maxUiTextChars
    );

    if (label !== undefined) next.label = label;
    if (text !== undefined) next.text = text;
    if (
      typeof delta.value === "string" ||
      typeof delta.value === "number" ||
      typeof delta.value === "boolean"
    ) {
      next.value =
        typeof delta.value === "string"
          ? normalizeLimitedString(delta.value, SCRIPT_SECURITY_LIMITS.maxUiTextChars)
          : delta.value;
    }
    if (placeholder !== undefined) next.placeholder = placeholder;

    const min = clampFiniteNumber(delta.min, -1_000_000_000, 1_000_000_000);
    const max = clampFiniteNumber(delta.max, -1_000_000_000, 1_000_000_000);
    const step = clampFiniteNumber(delta.step, 0.000001, 1_000_000);
    const rows = clampFiniteNumber(delta.rows, 1, 24);
    const width = clampFiniteNumber(delta.width, 80, 1400);

    if (min !== undefined) next.min = min;
    if (max !== undefined) next.max = max;
    if (step !== undefined) next.step = step;
    if (rows !== undefined) next.rows = rows;
    if (width !== undefined) next.width = width;

    if (typeof delta.disabled === "boolean") next.disabled = delta.disabled;
    if (
      delta.tone === "default" ||
      delta.tone === "success" ||
      delta.tone === "warn" ||
      delta.tone === "error" ||
      delta.tone === "accent"
    ) {
      next.tone = delta.tone;
    }
    if (Array.isArray(delta.options)) {
      next.options = normalizeUiElements([{ id: "x", type: "select", options: delta.options }])[0]?.options;
    }
    return next;
  });
}

function createInitialRuntime(): ScriptRuntimeState {
  return {
    status: "idle",
    startedAtMs: null,
    stoppedAtMs: null,
    lastError: null,
    uiElements: [],
  };
}

export function ScriptsDialog({ open, onClose }: ScriptsDialogProps) {
  const store = useStore();
  const t = useTr();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const { visible, closing, handleClose } = useModalClose(open, onClose);

  const [scripts, setScripts] = useState<ManagedScript[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<ScriptTabId>("editor");
  const [query, setQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const [draft, setDraft] = useState<ManagedScript | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [logsByScript, setLogsByScript] = useState<Record<string, ScriptLogEntry[]>>({});
  const [runtimeByScript, setRuntimeByScript] = useState<Record<string, ScriptRuntimeState>>({});
  const [logQuery, setLogQuery] = useState("");
  const [logLevel, setLogLevel] = useState<ScriptLogLevel | "all">("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [apiSearch, setApiSearch] = useState("");
  const [showUnsafe, setShowUnsafe] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [scriptContextMenu, setScriptContextMenu] = useState<ScriptContextMenuState | null>(null);
  const [scriptContextPos, setScriptContextPos] = useState<{ left: number; top: number } | null>(null);

  const scriptsRef = useRef<ManagedScript[]>([]);
  const workersRef = useRef<Map<string, WorkerRuntime>>(new Map());
  const selectedRef = useRef<string | null>(null);
  const autoStartDoneRef = useRef(false);
  const scriptSecurityRef = useRef<Record<string, string>>({});
  const importRef = useRef<HTMLInputElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const scriptContextRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const latestLogIdRef = useRef<string | null>(null);
  const snapshotRef = useRef<ScriptWindowSnapshot>({
    ts: 0,
    placeId: "",
    jobId: "",
    launchData: "",
    selectedUserIds: [],
    accounts: [],
    presenceByUserId: {},
    launchedUserIds: [],
    botting: null,
    generator: null,
    settings: null,
  });

  useEffect(() => {
    scriptsRef.current = scripts;
  }, [scripts]);

  const selectedScript = useMemo(() => {
    if (!selectedId) return null;
    return scripts.find((script) => script.id === selectedId) || null;
  }, [scripts, selectedId]);

  const contextScript = useMemo(() => {
    if (!scriptContextMenu) return null;
    return scripts.find((script) => script.id === scriptContextMenu.scriptId) || null;
  }, [scripts, scriptContextMenu]);

  const contextScriptRuntime = useMemo(() => {
    if (!contextScript) return createInitialRuntime();
    return runtimeByScript[contextScript.id] || createInitialRuntime();
  }, [contextScript, runtimeByScript]);

  function closeScriptContextMenu() {
    setScriptContextMenu(null);
    setScriptContextPos(null);
  }

  const scriptWindowSnapshot = useMemo<ScriptWindowSnapshot>(() => {
    return {
      ts: Date.now(),
      placeId: store.placeId,
      jobId: store.jobId,
      launchData: store.launchData,
      selectedUserIds: [...store.selectedIds],
      accounts: store.accounts.map((account) => ({
        userId: account.UserID,
        username: account.Username,
        alias: account.Alias,
        group: account.Group,
        valid: account.Valid,
        lastUse: account.LastUse,
        lastAttemptedRefresh: account.LastAttemptedRefresh,
      })),
      presenceByUserId: Object.fromEntries(
        [...store.presenceByUserId.entries()].map(([key, value]) => [String(key), value])
      ),
      launchedUserIds: [...store.launchedByProgram],
      botting: store.bottingStatus,
      generator: store.generatorStatus,
      settings: store.settings,
    };
  }, [
    store.placeId,
    store.jobId,
    store.launchData,
    store.selectedIds,
    store.accounts,
    store.presenceByUserId,
    store.launchedByProgram,
    store.bottingStatus,
    store.generatorStatus,
    store.settings,
  ]);

  function appendLog(scriptId: string, level: ScriptLogLevel, source: "script" | "host", message: string) {
    const normalizedMessage = truncateForLog(message);
    const entry: ScriptLogEntry = {
      id: buildId("log"),
      at: Date.now(),
      level,
      source,
      message: normalizedMessage,
    };
    setLogsByScript((prev) => {
      const next = [...(prev[scriptId] || []), entry];
      if (next.length > 800) {
        next.splice(0, next.length - 800);
      }
      return {
        ...prev,
        [scriptId]: next,
      };
    });
  }

  function updateRuntime(scriptId: string, patch: Partial<ScriptRuntimeState>) {
    setRuntimeByScript((prev) => {
      const existing = prev[scriptId] || createInitialRuntime();
      return {
        ...prev,
        [scriptId]: {
          ...existing,
          ...patch,
        },
      };
    });
  }

  function postWorkerEvent(scriptId: string, event: string, payload: unknown) {
    const runtime = workersRef.current.get(scriptId);
    if (!runtime) return;
    runtime.worker.postMessage({ type: "host-event", event, payload });
  }

  function postEventToAll(event: string, payload: unknown) {
    for (const script of workersRef.current.keys()) {
      postWorkerEvent(script, event, payload);
    }
  }

  function stopScript(scriptId: string, note = true) {
    const runtime = workersRef.current.get(scriptId);
    if (!runtime) return;

    for (const pending of runtime.pending.values()) {
      for (const controller of pending.abortControllers) {
        try {
          controller.abort();
        } catch {
        }
      }
    }
    runtime.pending.clear();

    for (const socket of runtime.sockets.values()) {
      try {
        socket.close(1000, "script stopped");
      } catch {
      }
    }
    runtime.sockets.clear();

    runtime.worker.postMessage({ type: "stop" });
    runtime.worker.terminate();
    workersRef.current.delete(scriptId);

    if (note) {
      appendLog(scriptId, "info", "host", "Script stopped");
    }
    updateRuntime(scriptId, {
      status: "stopped",
      stoppedAtMs: Date.now(),
      uiElements: [],
    });
  }

  function findScript(scriptId: string): ManagedScript {
    const script = scriptsRef.current.find((item) => item.id === scriptId);
    if (!script) {
      throw new Error("Script does not exist");
    }
    return script;
  }

  function requireActiveRequest(scriptId: string, runtimeId: string, requestId: string): WorkerRuntime {
    const runtime = workersRef.current.get(scriptId);
    if (!runtime || runtime.runtimeId !== runtimeId) {
      throw new Error("Script runtime is not active");
    }
    if (!runtime.pending.has(requestId)) {
      throw new Error("Script request was cancelled");
    }
    return runtime;
  }

  function requirePermissionForRequest(
    scriptId: string,
    runtimeId: string,
    requestId: string,
    permission: keyof ScriptPermissions,
    action: string,
    trustRequired: boolean
  ): ManagedScript {
    requireActiveRequest(scriptId, runtimeId, requestId);
    const script = findScript(scriptId);
    assertScriptPermission(script, permission, action, trustRequired);
    return script;
  }

  function attachAbortController(scriptId: string, runtimeId: string, requestId: string, controller: AbortController) {
    const runtime = requireActiveRequest(scriptId, runtimeId, requestId);
    const pending = runtime.pending.get(requestId);
    if (!pending) {
      throw new Error("Script request was cancelled");
    }
    pending.abortControllers.add(controller);
  }

  function detachAbortController(scriptId: string, runtimeId: string, requestId: string, controller: AbortController) {
    const runtime = workersRef.current.get(scriptId);
    if (!runtime || runtime.runtimeId !== runtimeId) {
      return;
    }
    runtime.pending.get(requestId)?.abortControllers.delete(controller);
  }

  function normalizeSettingsKey(input: unknown): string {
    const key = typeof input === "string" ? input.trim() : "";
    if (!key) {
      throw new Error("Missing settings key");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(key)) {
      throw new Error("Settings key contains unsupported characters");
    }
    if (key.length > SCRIPT_SECURITY_LIMITS.maxSettingsKeyChars) {
      throw new Error("Settings key is too long");
    }
    return key;
  }

  async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
    const declaredLength = Number(response.headers.get("content-length") || "");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`HTTP response exceeds ${maxBytes} bytes`);
    }

    if (!response.body) {
      return "";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (!chunk.value) {
        continue;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
        }
        throw new Error(`HTTP response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }

    text += decoder.decode();
    return text;
  }

  async function handleWorkerRequest(
    scriptId: string,
    runtimeId: string,
    requestId: string,
    action: string,
    payload: unknown
  ): Promise<unknown> {
    const data = asRecord(payload);

    if (action === "invoke") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowInvoke", "invoke", true);
      const command = String(data.command || "").trim();
      if (!command) {
        throw new Error("Missing invoke command");
      }
      if (!ALLOWED_INVOKE_COMMANDS.has(command)) {
        throw new Error(`Invoke command is not allowed: ${command}`);
      }
      const args = asRecord(data.args);
      requireActiveRequest(scriptId, runtimeId, requestId);
      const result = await invoke(command, args);
      requireActiveRequest(scriptId, runtimeId, requestId);
      return result;
    }

    if (action === "http.request") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowHttp", "http.request", true);
      const allowPrivateNetwork = data.allowPrivateNetwork === true;
      const url = normalizeScriptHttpUrl(String(data.url || ""), allowPrivateNetwork);

      const method = String(data.method || "GET").toUpperCase();
      if (!ALLOWED_HTTP_METHODS.has(method)) {
        throw new Error(`HTTP method is not allowed: ${method}`);
      }

      const timeoutRaw = Number(data.timeoutMs ?? 10_000);
      const timeoutMs = Number.isFinite(timeoutRaw)
        ? Math.min(
            SCRIPT_SECURITY_LIMITS.maxHttpTimeoutMs,
            Math.max(500, Math.floor(timeoutRaw))
          )
        : 10_000;

      const headersRaw = asRecord(data.headers);
      const headerEntries = Object.entries(headersRaw);
      if (headerEntries.length > SCRIPT_SECURITY_LIMITS.maxHttpHeaders) {
        throw new Error("Too many HTTP headers");
      }

      const headers = new Headers();
      for (const [keyRaw, valueRaw] of headerEntries) {
        const key = String(keyRaw || "").trim();
        if (!key) {
          continue;
        }
        if (key.length > SCRIPT_SECURITY_LIMITS.maxHttpHeaderNameChars) {
          throw new Error(`HTTP header name is too long: ${key}`);
        }
        const value = String(valueRaw ?? "");
        if (value.length > SCRIPT_SECURITY_LIMITS.maxHttpHeaderValueChars) {
          throw new Error(`HTTP header value is too long for: ${key}`);
        }
        headers.set(key, value);
      }

      let body: BodyInit | undefined;
      if (data.body !== undefined && data.body !== null) {
        if (method === "GET" || method === "HEAD") {
          throw new Error(`HTTP ${method} requests cannot include a body`);
        }

        if (typeof data.body === "string") {
          if (utf8ByteLength(data.body) > SCRIPT_SECURITY_LIMITS.maxHttpBodyBytes) {
            throw new Error(`HTTP body exceeds ${SCRIPT_SECURITY_LIMITS.maxHttpBodyBytes} bytes`);
          }
          body = data.body;
        } else {
          let jsonBody = "";
          try {
            jsonBody = JSON.stringify(data.body);
          } catch {
            throw new Error("HTTP body is not JSON serializable");
          }
          if (utf8ByteLength(jsonBody) > SCRIPT_SECURITY_LIMITS.maxHttpBodyBytes) {
            throw new Error(`HTTP body exceeds ${SCRIPT_SECURITY_LIMITS.maxHttpBodyBytes} bytes`);
          }
          body = jsonBody;
          if (!headers.has("content-type")) {
            headers.set("content-type", "application/json");
          }
        }
      }

      const controller = new AbortController();
      let timedOut = false;
      attachAbortController(scriptId, runtimeId, requestId, controller);
      const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        requirePermissionForRequest(scriptId, runtimeId, requestId, "allowHttp", "http.request", true);
        const response = await fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });

        requireActiveRequest(scriptId, runtimeId, requestId);
        const text = await readResponseTextLimited(response, SCRIPT_SECURITY_LIMITS.maxHttpResponseBytes);
        requireActiveRequest(scriptId, runtimeId, requestId);

        let json: unknown = null;
        if (text.trim().length > 0) {
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
        }

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: Object.fromEntries(response.headers.entries()),
          text,
          json,
        };
      } catch (error) {
        if (timedOut) {
          throw new Error("HTTP request timed out");
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error("Script request was cancelled");
        }
        throw error;
      } finally {
        window.clearTimeout(timer);
        detachAbortController(scriptId, runtimeId, requestId, controller);
      }
    }

    if (action === "ws.connect") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowWebSocket", "ws.connect", true);
      const runtime = requireActiveRequest(scriptId, runtimeId, requestId);
      if (runtime.sockets.size >= SCRIPT_SECURITY_LIMITS.maxWebSocketConnections) {
        throw new Error(
          `WebSocket limit reached (${SCRIPT_SECURITY_LIMITS.maxWebSocketConnections})`
        );
      }

      const allowPrivateNetwork = data.allowPrivateNetwork === true;
      const url = normalizeWebSocketUrl(String(data.url || ""), allowPrivateNetwork);
      const requestedId = String(data.connectionId || "").trim();
      const connectionId = requestedId || buildId("ws");
      if (!/^[A-Za-z0-9._:-]{1,96}$/.test(connectionId)) {
        throw new Error("WebSocket connectionId contains unsupported characters");
      }
      if (connectionId.length > SCRIPT_SECURITY_LIMITS.maxWebSocketConnectionIdChars) {
        throw new Error("WebSocket connectionId is too long");
      }

      if (runtime.sockets.has(connectionId)) {
        throw new Error(`WebSocket connection already exists: ${connectionId}`);
      }

      const protocolsInput = data.protocols;
      let protocols: string[] | undefined;
      if (Array.isArray(protocolsInput)) {
        protocols = protocolsInput
          .map((entry) => String(entry || "").trim())
          .filter((entry) => entry.length > 0);
      } else if (typeof protocolsInput === "string" && protocolsInput.trim().length > 0) {
        protocols = [protocolsInput.trim()];
      }

      if (protocols && protocols.length > SCRIPT_SECURITY_LIMITS.maxWebSocketProtocols) {
        throw new Error("Too many WebSocket protocols");
      }
      if (
        protocols &&
        protocols.some((entry) => entry.length > SCRIPT_SECURITY_LIMITS.maxWebSocketProtocolChars)
      ) {
        throw new Error("WebSocket protocol value is too long");
      }

      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowWebSocket", "ws.connect", true);
      const socket = protocols && protocols.length > 0 ? new WebSocket(url, protocols) : new WebSocket(url);
      runtime.sockets.set(connectionId, socket);

      const runtimeFingerprint = runtime.runtimeId;
      const runtimeStillActive = () => {
        const current = workersRef.current.get(scriptId);
        return current?.runtimeId === runtimeFingerprint;
      };

      socket.onopen = () => {
        if (!runtimeStillActive()) {
          return;
        }
        appendLog(scriptId, "info", "host", `WS open ${connectionId} -> ${url}`);
        postWorkerEvent(scriptId, "ws", {
          event: "open",
          connectionId,
          url,
          state: wsStateLabel(socket.readyState),
        });
      };

      socket.onerror = () => {
        if (!runtimeStillActive()) {
          return;
        }
        appendLog(scriptId, "warn", "host", `WS error ${connectionId}`);
        postWorkerEvent(scriptId, "ws", {
          event: "error",
          connectionId,
          url,
          state: wsStateLabel(socket.readyState),
        });
      };

      socket.onclose = (event) => {
        const current = workersRef.current.get(scriptId);
        if (current?.runtimeId === runtimeFingerprint) {
          current.sockets.delete(connectionId);
        }

        if (!runtimeStillActive()) {
          return;
        }

        appendLog(
          scriptId,
          "info",
          "host",
          `WS close ${connectionId} (code=${event.code}${event.reason ? `, reason=${event.reason}` : ""})`
        );
        postWorkerEvent(scriptId, "ws", {
          event: "close",
          connectionId,
          url,
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          state: wsStateLabel(socket.readyState),
        });
      };

      socket.onmessage = async (event) => {
        if (!runtimeStillActive()) {
          return;
        }
        const payloadData = await wsMessageToPayload(event.data);
        if (payloadData.truncated) {
          appendLog(
            scriptId,
            "warn",
            "host",
            `WS message on ${connectionId} exceeded ${SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes} bytes and was truncated`
          );
        }
        const dataType =
          typeof event.data === "string"
            ? "text"
            : event.data instanceof Blob
              ? "blob"
              : event.data instanceof ArrayBuffer
                ? "arrayBuffer"
                : typeof event.data;
        postWorkerEvent(scriptId, "ws", {
          event: "message",
          connectionId,
          url,
          dataType,
          text: payloadData.text,
          json: payloadData.json,
          truncated: payloadData.truncated,
          state: wsStateLabel(socket.readyState),
        });
      };

      return {
        connectionId,
        url,
        state: wsStateLabel(socket.readyState),
      };
    }

    if (action === "ws.send") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowWebSocket", "ws.send", true);
      const runtime = requireActiveRequest(scriptId, runtimeId, requestId);

      const connectionId = String(data.connectionId || "").trim();
      if (!connectionId) {
        throw new Error("Missing WebSocket connectionId");
      }

      const socket = runtime.sockets.get(connectionId);
      if (!socket) {
        throw new Error(`WebSocket connection not found: ${connectionId}`);
      }

      if (socket.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            cleanup();
            reject(new Error(`WebSocket ${connectionId} did not open in time`));
          }, 5000);

          const onOpen = () => {
            cleanup();
            resolve();
          };

          const onClose = () => {
            cleanup();
            reject(new Error(`WebSocket ${connectionId} closed before open`));
          };

          const onError = () => {
            cleanup();
            reject(new Error(`WebSocket ${connectionId} failed while connecting`));
          };

          const cleanup = () => {
            window.clearTimeout(timeout);
            socket.removeEventListener("open", onOpen);
            socket.removeEventListener("close", onClose);
            socket.removeEventListener("error", onError);
          };

          socket.addEventListener("open", onOpen, { once: true });
          socket.addEventListener("close", onClose, { once: true });
          socket.addEventListener("error", onError, { once: true });
        });
      }

      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowWebSocket", "ws.send", true);
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error(`WebSocket ${connectionId} is ${wsStateLabel(socket.readyState)}`);
      }

      const frame = data.data;
      if (typeof frame === "string") {
        if (utf8ByteLength(frame) > SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes) {
          throw new Error(
            `WebSocket payload exceeds ${SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes} bytes`
          );
        }
        socket.send(frame);
      } else if (frame instanceof ArrayBuffer) {
        if (frame.byteLength > SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes) {
          throw new Error(
            `WebSocket payload exceeds ${SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes} bytes`
          );
        }
        socket.send(frame);
      } else if (ArrayBuffer.isView(frame)) {
        if (frame.byteLength > SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes) {
          throw new Error(
            `WebSocket payload exceeds ${SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes} bytes`
          );
        }
        socket.send(frame);
      } else {
        let encoded = "";
        try {
          encoded = JSON.stringify(frame ?? null);
        } catch {
          throw new Error("WebSocket payload is not serializable");
        }
        if (utf8ByteLength(encoded) > SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes) {
          throw new Error(
            `WebSocket payload exceeds ${SCRIPT_SECURITY_LIMITS.maxWebSocketMessageBytes} bytes`
          );
        }
        socket.send(encoded);
      }

      return {
        connectionId,
        state: wsStateLabel(socket.readyState),
      };
    }

    if (action === "ws.close") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowWebSocket", "ws.close", true);
      const runtime = requireActiveRequest(scriptId, runtimeId, requestId);

      const connectionId = String(data.connectionId || "").trim();
      const code = typeof data.code === "number" && Number.isInteger(data.code) ? data.code : undefined;
      const reason = typeof data.reason === "string" ? data.reason : undefined;

      if (reason && reason.length > WS_CLOSE_REASON_MAX_CHARS) {
        throw new Error(`WebSocket close reason exceeds ${WS_CLOSE_REASON_MAX_CHARS} characters`);
      }
      if (code !== undefined && (code < 1000 || code > 4999)) {
        throw new Error("WebSocket close code must be between 1000 and 4999");
      }

      if (connectionId) {
        const socket = runtime.sockets.get(connectionId);
        if (!socket) {
          throw new Error(`WebSocket connection not found: ${connectionId}`);
        }
        socket.close(code, reason);
        return true;
      }

      for (const socket of runtime.sockets.values()) {
        socket.close(code, reason);
      }
      return true;
    }

    if (action === "ws.list") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowWebSocket", "ws.list", false);
      const runtime = requireActiveRequest(scriptId, runtimeId, requestId);
      return [...runtime.sockets.entries()].map(([connectionId, socket]) => ({
        connectionId,
        url: socket.url,
        state: wsStateLabel(socket.readyState),
      }));
    }

    if (action === "window.snapshot") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowWindow", "window.snapshot", false);
      return snapshotRef.current;
    }

    if (action === "window.accounts") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowWindow", "window.accounts", false);
      return snapshotRef.current.accounts;
    }

    if (action === "window.selected") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowWindow", "window.selected", false);
      return snapshotRef.current.selectedUserIds;
    }

    if (action === "settings.get") {
      const script = requirePermissionForRequest(
        scriptId,
        runtimeId,
        requestId,
        "allowSettings",
        "settings.get",
        false
      );
      const key = normalizeSettingsKey(data.key);
      const section = buildScriptSettingsSection(script.id);
      requireActiveRequest(scriptId, runtimeId, requestId);
      const value = await invoke<string | null>("get_setting", {
        section,
        key,
      });
      requireActiveRequest(scriptId, runtimeId, requestId);
      return value === null ? data.defaultValue ?? null : value;
    }

    if (action === "settings.set") {
      const script = requirePermissionForRequest(
        scriptId,
        runtimeId,
        requestId,
        "allowSettings",
        "settings.set",
        true
      );
      const key = normalizeSettingsKey(data.key);
      const value = String(data.value ?? "");
      if (utf8ByteLength(value) > SCRIPT_SECURITY_LIMITS.maxSettingsValueChars) {
        throw new Error(`Settings value exceeds ${SCRIPT_SECURITY_LIMITS.maxSettingsValueChars} bytes`);
      }
      const section = buildScriptSettingsSection(script.id);
      requireActiveRequest(scriptId, runtimeId, requestId);
      await invoke("update_setting", {
        section,
        key,
        value,
      });
      requireActiveRequest(scriptId, runtimeId, requestId);
      return true;
    }

    if (action === "settings.all") {
      const script = requirePermissionForRequest(
        scriptId,
        runtimeId,
        requestId,
        "allowSettings",
        "settings.all",
        false
      );
      const section = buildScriptSettingsSection(script.id);
      requireActiveRequest(scriptId, runtimeId, requestId);
      const all = await invoke<Record<string, Record<string, string>>>("get_all_settings");
      requireActiveRequest(scriptId, runtimeId, requestId);
      return all[section] || {};
    }

    if (action === "modal.alert") {
      const script = requirePermissionForRequest(
        scriptId,
        runtimeId,
        requestId,
        "allowModal",
        "modal.alert",
        false
      );
      const title = truncateForLog(typeof data.title === "string" ? data.title : script.name, 240);
      const message = truncateForLog(
        typeof data.message === "string" ? data.message : safeMessage(payload),
        2000
      );
      return confirm(`${title}\n\n${message}`, false);
    }

    if (action === "modal.confirm") {
      const script = requirePermissionForRequest(
        scriptId,
        runtimeId,
        requestId,
        "allowModal",
        "modal.confirm",
        false
      );
      const title = truncateForLog(typeof data.title === "string" ? data.title : script.name, 240);
      const message = truncateForLog(
        typeof data.message === "string" ? data.message : "Continue?",
        2000
      );
      return confirm(`${title}\n\n${message}`, false);
    }

    if (action === "modal.prompt") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowModal", "modal.prompt", false);
      const message = truncateForLog(
        typeof data.message === "string" ? data.message : "Input",
        2000
      );
      const defaultValue = truncateForLog(
        typeof data.defaultValue === "string" ? data.defaultValue : "",
        2000
      );
      return prompt(message, defaultValue);
    }

    if (action === "modal.json") {
      const script = requirePermissionForRequest(
        scriptId,
        runtimeId,
        requestId,
        "allowModal",
        "modal.json",
        false
      );
      const title = truncateForLog(
        typeof data.title === "string" ? data.title : `${script.name} Data`,
        240
      );
      const json = truncateForLog(JSON.stringify(data.data ?? payload, null, 2), 12_000);
      store.showModal(title, json);
      return true;
    }

    if (action === "ui.set") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowUi", "ui.set", false);
      const elements = normalizeUiElements(data.elements);
      updateRuntime(scriptId, { uiElements: elements });
      return true;
    }

    if (action === "ui.patch") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowUi", "ui.patch", false);
      const id = normalizeUiId(data.id);
      if (!id) throw new Error("Missing or invalid UI element id");

      const patchBytes = utf8ByteLength(safeMessage(data.patch));
      if (patchBytes > SCRIPT_SECURITY_LIMITS.maxUiPatchBytes) {
        throw new Error(`UI patch exceeds ${SCRIPT_SECURITY_LIMITS.maxUiPatchBytes} bytes`);
      }

      setRuntimeByScript((prev) => {
        const current = prev[scriptId] || createInitialRuntime();
        return {
          ...prev,
          [scriptId]: {
            ...current,
            uiElements: applyUiPatch(current.uiElements, id, data.patch),
          },
        };
      });
      return true;
    }

    if (action === "ui.clear") {
      requirePermissionForRequest(scriptId, runtimeId, requestId, "allowUi", "ui.clear", false);
      updateRuntime(scriptId, { uiElements: [] });
      return true;
    }

    throw new Error(`Unknown action: ${action}`);
  }

  function handleWorkerMessage(scriptId: string, messageRaw: unknown) {
    const message = messageRaw as WorkerIncomingMessage & Record<string, unknown>;

    if (message.type === "host-log") {
      appendLog(scriptId, message.level || "info", "script", String(message.message || ""));
      return;
    }

    if (message.type === "script-finished") {
      appendLog(scriptId, "info", "host", "Script finished");
      stopScript(scriptId, false);
      updateRuntime(scriptId, {
        status: "stopped",
        stoppedAtMs: Date.now(),
      });
      return;
    }

    if (message.type === "script-error") {
      const errorText = String(message.error || "Unknown script error");
      appendLog(scriptId, "error", "host", errorText);
      stopScript(scriptId, false);
      updateRuntime(scriptId, {
        status: "error",
        stoppedAtMs: Date.now(),
        lastError: errorText,
      });
      return;
    }

    if (message.type === "host-request") {
      const runtime = workersRef.current.get(scriptId);
      if (!runtime) return;
      const requestId = String(message.requestId || "");
      const action = String(message.action || "");

      if (!requestId || !action) {
        return;
      }

      if (runtime.pending.has(requestId)) {
        runtime.worker.postMessage({
          type: "host-response",
          requestId,
          ok: false,
          error: `Duplicate host request id: ${requestId}`,
        });
        return;
      }

      if (runtime.pending.size >= SCRIPT_SECURITY_LIMITS.maxPendingHostRequests) {
        runtime.worker.postMessage({
          type: "host-response",
          requestId,
          ok: false,
          error: `Too many pending host requests (max ${SCRIPT_SECURITY_LIMITS.maxPendingHostRequests})`,
        });
        return;
      }

      const runtimeId = runtime.runtimeId;
      runtime.pending.set(requestId, {
        action,
        startedAtMs: Date.now(),
        abortControllers: new Set(),
      });

      handleWorkerRequest(scriptId, runtimeId, requestId, action, message.payload)
        .then((result) => {
          const current = workersRef.current.get(scriptId);
          if (!current || current.runtimeId !== runtimeId || !current.pending.has(requestId)) {
            return;
          }
          current.worker.postMessage({
            type: "host-response",
            requestId,
            ok: true,
            result,
          });
        })
        .catch((error) => {
          const current = workersRef.current.get(scriptId);
          if (!current || current.runtimeId !== runtimeId || !current.pending.has(requestId)) {
            return;
          }
          const errorText = safeMessage(error);
          appendLog(scriptId, "warn", "host", `${action} -> ${errorText}`);
          current.worker.postMessage({
            type: "host-response",
            requestId,
            ok: false,
            error: errorText,
          });
        })
        .finally(() => {
          const current = workersRef.current.get(scriptId);
          if (current && current.runtimeId === runtimeId) {
            current.pending.delete(requestId);
          }
        });
    }
  }

  function startScript(scriptId: string) {
    const script = scriptsRef.current.find((item) => item.id === scriptId);
    if (!script) return;
    if (!script.enabled) {
      appendLog(scriptId, "warn", "host", "Cannot start disabled script");
      return;
    }

    const source = sanitizeScriptSourceForSave(script.source);
    try {
      ensureScriptSourceSize(source);
    } catch (error) {
      const message = safeMessage(error);
      appendLog(scriptId, "error", "host", message);
      updateRuntime(scriptId, {
        status: "error",
        lastError: message,
        stoppedAtMs: Date.now(),
      });
      return;
    }

    stopScript(scriptId, false);
    const worker = createScriptWorker();
    const runtime: WorkerRuntime = {
      worker,
      runtimeId: buildId("runtime"),
      pending: new Map(),
      sockets: new Map(),
    };
    workersRef.current.set(scriptId, runtime);

    worker.onmessage = (event) => {
      handleWorkerMessage(scriptId, event.data);
    };

    worker.onerror = (event) => {
      const text = event.message || "Worker crashed";
      appendLog(scriptId, "error", "host", text);
      stopScript(scriptId, false);
      updateRuntime(scriptId, {
        status: "error",
        lastError: text,
        stoppedAtMs: Date.now(),
      });
    };

    appendLog(scriptId, "info", "host", `Starting ${script.name}`);
    updateRuntime(scriptId, {
      status: "running",
      startedAtMs: Date.now(),
      stoppedAtMs: null,
      lastError: null,
      uiElements: [],
    });

    worker.postMessage({
      type: "start",
      code: source,
      metadata: {
        id: script.id,
        name: script.name,
        trusted: script.trusted,
        permissions: script.permissions,
      },
    });

    worker.postMessage({
      type: "host-event",
      event: "window:update",
      payload: snapshotRef.current,
    });
  }

  async function loadScripts() {
    try {
      const fetched = await invoke<ManagedScript[]>("get_scripts");
      const normalized = fetched.map(normalizeScript);
      setScripts(normalized);
      if (!selectedRef.current && normalized.length > 0) {
        selectedRef.current = normalized[0].id;
        setSelectedId(normalized[0].id);
      }
    } catch (error) {
      store.setError(String(error));
    } finally {
      setLoaded(true);
    }
  }

  async function persistScript(script: ManagedScript): Promise<ManagedScript | null> {
    try {
      const prepared: ManagedScript = {
        ...script,
        id: trimToLength(String(script.id || ""), SCRIPT_SECURITY_LIMITS.maxScriptIdChars),
        name:
          trimToLength(String(script.name || ""), SCRIPT_SECURITY_LIMITS.maxScriptNameChars) ||
          "Unnamed Script",
        description: trimToLength(
          String(script.description || ""),
          SCRIPT_SECURITY_LIMITS.maxScriptDescriptionChars
        ),
        language: "javascript",
        source: sanitizeScriptSourceForSave(coerceScriptSource(script.source)),
        permissions: {
          ...defaultPermissions(),
          ...(script.permissions || {}),
        },
      };

      if (!prepared.id) {
        throw new Error("Script id is required");
      }
      if (!prepared.name.trim()) {
        throw new Error("Script name is required");
      }
      ensureScriptSourceSize(prepared.source);

      const saved = await invoke<ManagedScript>("save_script", { script: prepared });
      const normalized = normalizeScript(saved);
      const existing = scriptsRef.current.find((item) => item.id === normalized.id) || null;
      const prevSignature = existing ? getScriptSecuritySignature(existing) : null;
      const nextSignature = getScriptSecuritySignature(normalized);

      if (prevSignature && prevSignature !== nextSignature && workersRef.current.has(normalized.id)) {
        appendLog(normalized.id, "warn", "host", "Script trust/permissions changed, stopping runtime");
        stopScript(normalized.id, false);
      }

      setScripts((prev) => {
        const scriptExists = prev.some((item) => item.id === normalized.id);
        if (!scriptExists) {
          return [...prev, normalized].sort((a, b) => a.name.localeCompare(b.name));
        }
        return prev
          .map((item) => (item.id === normalized.id ? normalized : item))
          .sort((a, b) => a.name.localeCompare(b.name));
      });
      return normalized;
    } catch (error) {
      store.setError(String(error));
      return null;
    }
  }

  useEffect(() => {
    loadScripts();
    return () => {
      for (const id of [...workersRef.current.keys()]) {
        stopScript(id, false);
      }
    };
  }, []);

  useEffect(() => {
    snapshotRef.current = scriptWindowSnapshot;
    postEventToAll("window:update", scriptWindowSnapshot);
  }, [scriptWindowSnapshot]);

  useEffect(() => {
    if (!loaded || autoStartDoneRef.current) {
      return;
    }
    autoStartDoneRef.current = true;
    for (const script of scriptsRef.current) {
      if (script.enabled && script.autoStart) {
        startScript(script.id);
      }
    }
  }, [loaded, scripts]);

  useEffect(() => {
    if (!loaded) return;

    for (const script of scripts) {
      if (!script.enabled) {
        stopScript(script.id, false);
      }
    }

    for (const id of [...workersRef.current.keys()]) {
      if (!scripts.some((item) => item.id === id)) {
        stopScript(id, false);
      }
    }
  }, [loaded, scripts]);

  useEffect(() => {
    if (!loaded) return;

    const nextSecurity: Record<string, string> = {};

    for (const script of scripts) {
      const signature = getScriptSecuritySignature(script);
      const prevSignature = scriptSecurityRef.current[script.id];
      nextSecurity[script.id] = signature;

      if (prevSignature && prevSignature !== signature && workersRef.current.has(script.id)) {
        appendLog(script.id, "warn", "host", "Script trust/permissions changed, stopping runtime");
        stopScript(script.id, false);
      }
    }

    scriptSecurityRef.current = nextSecurity;
  }, [loaded, scripts]);

  useEffect(() => {
    if (!selectedScript) {
      setDraft(null);
      setDraftDirty(false);
      selectedRef.current = null;
      return;
    }

    if (selectedRef.current !== selectedScript.id) {
      selectedRef.current = selectedScript.id;
      setDraft({ ...selectedScript });
      setDraftDirty(false);
      return;
    }

    if (!draftDirty) {
      setDraft({ ...selectedScript });
    }
  }, [selectedScript, draftDirty]);

  useEffect(() => {
    if (!visible) {
      setNewMenuOpen(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!newMenuOpen) return;

    function handleMouseDown(event: MouseEvent) {
      if (newMenuRef.current && !newMenuRef.current.contains(event.target as Node)) {
        setNewMenuOpen(false);
      }
    }

    function handleEsc(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setNewMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [newMenuOpen]);

  useEffect(() => {
    if (!scriptContextMenu) return;

    function handleMouseDown(event: MouseEvent) {
      if (scriptContextRef.current && !scriptContextRef.current.contains(event.target as Node)) {
        closeScriptContextMenu();
      }
    }

    function handleEsc(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeScriptContextMenu();
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [scriptContextMenu]);

  useLayoutEffect(() => {
    if (!scriptContextMenu) return;
    const el = scriptContextRef.current;
    if (!el) return;

    const pad = 8;
    const width = el.offsetWidth || 220;
    const height = el.offsetHeight || 260;
    const left = Math.max(pad, Math.min(scriptContextMenu.x, window.innerWidth - width - pad));
    const top = Math.max(pad, Math.min(scriptContextMenu.y, window.innerHeight - height - pad));
    setScriptContextPos({ left, top });
  }, [scriptContextMenu, contextScriptRuntime.status]);

  const filteredScripts = useMemo(() => {
    const lower = query.trim().toLowerCase();
    const all = scripts.filter((script) => {
      const runtime = runtimeByScript[script.id];
      if (runningOnly && runtime?.status !== "running") {
        return false;
      }
      if (!lower) return true;
      return (
        script.name.toLowerCase().includes(lower) ||
        script.description.toLowerCase().includes(lower)
      );
    });
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }, [scripts, runtimeByScript, query, runningOnly]);

  const selectedRuntime = selectedId ? runtimeByScript[selectedId] : null;
  const selectedLogs = selectedId ? logsByScript[selectedId] || [] : [];
  const selectedUi = selectedRuntime?.uiElements || [];
  const [stickLogsToBottom, setStickLogsToBottom] = useState(true);

  const visibleLogs = useMemo(() => {
    const lower = logQuery.trim().toLowerCase();
    return selectedLogs.filter((log) => {
      if (logLevel !== "all" && log.level !== logLevel) {
        return false;
      }
      if (!lower) return true;
      return log.message.toLowerCase().includes(lower);
    });
  }, [selectedLogs, logLevel, logQuery]);

  function isNearLogBottom(element: HTMLDivElement): boolean {
    const delta = element.scrollHeight - element.scrollTop - element.clientHeight;
    return delta <= 28;
  }

  function scrollLogsToBottom(behavior: ScrollBehavior) {
    const element = logsContainerRef.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior,
    });
  }

  function handleLogsScroll() {
    const element = logsContainerRef.current;
    if (!element) return;
    setStickLogsToBottom(isNearLogBottom(element));
  }

  useEffect(() => {
    if (tab !== "logs") return;
    latestLogIdRef.current = null;
    setStickLogsToBottom(true);
    window.requestAnimationFrame(() => {
      scrollLogsToBottom("auto");
    });
  }, [selectedId, tab]);

  useEffect(() => {
    if (tab !== "logs") return;
    if (!stickLogsToBottom) return;
    if (visibleLogs.length === 0) return;

    const latestId = visibleLogs[visibleLogs.length - 1]?.id || null;
    if (!latestId || latestLogIdRef.current === latestId) {
      return;
    }

    latestLogIdRef.current = latestId;
    window.requestAnimationFrame(() => {
      scrollLogsToBottom("smooth");
    });
  }, [visibleLogs, tab, stickLogsToBottom]);

  const commandList = useMemo(() => {
    const q = apiSearch.trim().toLowerCase();
    if (!q) return [...SCRIPT_INVOKE_COMMANDS];
    return SCRIPT_INVOKE_COMMANDS.filter((command) => command.toLowerCase().includes(q));
  }, [apiSearch]);

  async function handleCreate(kind: "blank" | "monitor" | "discord" | "hub") {
    const name =
      (await prompt(
        "Script name",
        kind === "hub"
          ? "Hub Link"
          : kind === "discord"
            ? "Discord Bridge"
            : kind === "monitor"
              ? "Window Monitor"
              : "New Script"
      )) || "";

    const trimmed = name.trim();
    if (!trimmed) return;

    const script =
      kind === "hub"
        ? createScript(
            trimmed,
            "Link this RAM to a remote hub for web and Discord control.",
            HUB_LINK_TEMPLATE,
            { trusted: true, autoStart: true, permissions: allPermissions() }
          )
        : kind === "discord"
          ? createScript(trimmed, "Send account presence to a local Discord bot bridge.", DISCORD_BRIDGE_TEMPLATE)
          : kind === "monitor"
            ? createScript(trimmed, "Watch app state, react to UI actions, and call commands.", DEFAULT_SCRIPT_SOURCE)
            : createScript(trimmed, "", "ram.info(\"Hello from script\");\n");

    const saved = await persistScript(script);
    if (!saved) return;
    setSelectedId(saved.id);
    setDraft({ ...saved });
    setDraftDirty(false);
  }

  async function handleSaveDraft() {
    if (!draft) return;
    setBusyId(draft.id);
    const next: ManagedScript = {
      ...draft,
      source: sanitizeScriptSourceForSave(draft.source),
      updatedAtMs: Date.now(),
    };

    const saved = await persistScript(next);
    setBusyId(null);
    if (!saved) return;
    setDraft({ ...saved });
    setDraftDirty(false);
    appendLog(saved.id, "info", "host", "Script saved");
    store.addToast(t("Script saved"));
  }

  async function handleDeleteScript(scriptId: string) {
    const item = scripts.find((script) => script.id === scriptId);
    if (!item) return;

    const approved = await confirm(`Delete script \"${item.name}\"?`, true);
    if (!approved) return;

    stopScript(scriptId, false);

    try {
      await invoke<boolean>("delete_script", { scriptId });
      setScripts((prev) => prev.filter((script) => script.id !== scriptId));
      setLogsByScript((prev) => {
        const next = { ...prev };
        delete next[scriptId];
        return next;
      });
      setRuntimeByScript((prev) => {
        const next = { ...prev };
        delete next[scriptId];
        return next;
      });
      if (selectedId === scriptId) {
        const remaining = scripts.filter((script) => script.id !== scriptId);
        setSelectedId(remaining[0]?.id || null);
      }
    } catch (error) {
      store.setError(String(error));
    }
  }

  async function handleTrustToggle(script: ManagedScript, nextTrusted: boolean) {
    if (nextTrusted) {
      const approved = await confirm(
        "Trusting a script allows command calls, HTTP access, and settings writes. Continue?",
        true
      );
      if (!approved) return;
    }
    const next = { ...script, trusted: nextTrusted, updatedAtMs: Date.now() };
    const saved = await persistScript(next);
    if (!saved) return;
    if (draft?.id === saved.id) {
      setDraft(saved);
      setDraftDirty(false);
    }
    appendLog(saved.id, "info", "host", nextTrusted ? "Trusted mode enabled" : "Trusted mode disabled");
  }

  async function handleToggleEnabled(script: ManagedScript, enabled: boolean) {
    const next = { ...script, enabled, updatedAtMs: Date.now() };
    const saved = await persistScript(next);
    if (!saved) return;
    if (!enabled) {
      stopScript(saved.id, true);
    }
  }

  function updateDraft(updater: (prev: ManagedScript) => ManagedScript) {
    setDraft((prev) => {
      if (!prev) return prev;
      return updater(prev);
    });
    setDraftDirty(true);
  }

  async function handleRunScript(scriptId: string) {
    const script = scripts.find((item) => item.id === scriptId);
    if (!script) return;
    if (!script.enabled) {
      store.addToast(t("Enable the script before running"));
      return;
    }
    startScript(scriptId);
  }

  function handleRestartScript(scriptId: string) {
    stopScript(scriptId, false);
    startScript(scriptId);
  }

  function handleUiEvent(scriptId: string, payload: Record<string, unknown>) {
    postWorkerEvent(scriptId, "ui", payload);
  }

  async function handleImportScript(file: File) {
    try {
      const text = await file.text();
      const name = file.name.replace(/\.[^.]+$/, "") || "Imported Script";
      const script = createScript(name, "Imported from file", sanitizeScriptSourceForSave(text));
      const saved = await persistScript(script);
      if (!saved) return;
      setSelectedId(saved.id);
      setDraft(saved);
      setDraftDirty(false);
    } catch (error) {
      store.setError(String(error));
    }
  }

  async function handleExportScript(script: ManagedScript) {
    const fileName = `${script.name.replace(/[^a-zA-Z0-9-_]/g, "_") || "script"}.js`;
    const savePickerApi = window as Window & SavePickerApi;

    if (typeof savePickerApi.showSaveFilePicker === "function") {
      try {
        const handle = await savePickerApi.showSaveFilePicker({
          suggestedName: fileName,
          types: [
            {
              description: "JavaScript",
              accept: {
                "text/javascript": [".js"],
              },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(script.source);
        await writable.close();
        store.addToast(t("Script exported"));
        return;
      } catch (error) {
        const msg = String(error || "");
        if (msg.toLowerCase().includes("abort")) {
          return;
        }
      }
    }

    try {
      const blob = new Blob([script.source], { type: "text/javascript;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      store.addToast(t("Script export started"));
      return;
    } catch {
    }

    try {
      await navigator.clipboard.writeText(script.source);
      store.addToast(t("Export fallback: source copied to clipboard"));
      store.showModal(`${script.name} Export`, script.source);
    } catch (error) {
      store.setError(String(error));
    }
  }

  async function handleDuplicateScript(script: ManagedScript) {
    const duplicated: ManagedScript = {
      ...script,
      id: buildId("script"),
      name: `${script.name} Copy`,
      trusted: false,
      enabled: false,
      autoStart: false,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };
    const saved = await persistScript(duplicated);
    if (!saved) return;
    setSelectedId(saved.id);
    setDraft({ ...saved });
    setDraftDirty(false);
    appendLog(saved.id, "info", "host", "Script duplicated");
  }

  async function handleCopyApiSnippet() {
const snippet = `
await ram.invoke("get_accounts", {});
const snapshot = await ram.window.snapshot();
const response = await ram.http.request({ url: "http://127.0.0.1:3847/health", allowPrivateNetwork: true });
const socket = await ram.ws.connect({ url: "ws://127.0.0.1:3847/ram", allowPrivateNetwork: true });
await ram.ws.send(socket.connectionId, { type: "ping" });
await ram.settings.set("endpoint", "http://127.0.0.1:3847/ram/bridge");
`;
    await navigator.clipboard.writeText(snippet.trim());
    store.addToast(t("Snippet copied"));
  }

  function renderStatusChip(script: ManagedScript) {
    const runtime = runtimeByScript[script.id] || createInitialRuntime();
    const status = runtime.status;
    const className =
      status === "running"
        ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
        : status === "error"
          ? "border-red-500/30 bg-red-500/15 text-red-300"
          : "theme-border bg-zinc-800/40 text-zinc-400";
    return (
      <span className={`px-1.5 py-0.5 text-[10px] rounded-md border ${className}`}>
        {status.toUpperCase()}
      </span>
    );
  }

  const scriptContextItems: MenuItem[] = contextScript
    ? [
        {
          label: contextScriptRuntime.status === "running" ? "Stop" : "Run",
          action: () => {
            if (contextScriptRuntime.status === "running") {
              stopScript(contextScript.id, true);
            } else {
              void handleRunScript(contextScript.id);
            }
          },
        },
        {
          label: "Restart",
          action: () => {
            handleRestartScript(contextScript.id);
          },
        },
        { separator: true, label: "" },
        {
          label: contextScript.enabled ? "Disable" : "Enable",
          action: () => {
            void handleToggleEnabled(contextScript, !contextScript.enabled);
          },
        },
        {
          label: contextScript.trusted ? "Untrust Script" : "Trust Script",
          action: () => {
            void handleTrustToggle(contextScript, !contextScript.trusted);
          },
        },
        { separator: true, label: "" },
        {
          label: "Duplicate",
          action: () => {
            void handleDuplicateScript(contextScript);
          },
        },
        {
          label: "Export",
          action: () => {
            void handleExportScript(contextScript);
          },
        },
        {
          label: "Delete",
          className: "text-red-400",
          action: () => {
            void handleDeleteScript(contextScript.id);
          },
        },
      ]
    : [];

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-[70] flex items-center justify-center bg-black/65 backdrop-blur-sm ${
        closing ? "animate-fade-out" : "animate-fade-in"
      }`}
      onClick={handleClose}
    >
      <div
        className={`theme-modal-scope theme-panel theme-border w-[1100px] h-[720px] max-w-[calc(100vw-20px)] max-h-[calc(100vh-20px)] rounded-2xl border shadow-2xl overflow-hidden flex flex-col ${
          closing ? "animate-scale-out" : "animate-scale-in"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 py-3 border-b theme-border flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-zinc-100">{t("Scripts")}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleClose}
              className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex">
          <aside className="w-[320px] border-r theme-border flex flex-col min-h-0">
            <div className="p-3 border-b theme-border flex items-center gap-2">
              <div className="relative flex-1">
                <Search
                  size={13}
                  strokeWidth={1.9}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600"
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-zinc-800/50 border border-zinc-700/60 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
                  placeholder={t("Search scripts")}
                />
              </div>
              <button
                onClick={() => setRunningOnly((prev) => !prev)}
                className={`px-2 py-1.5 rounded-lg border text-[11px] transition-colors ${
                  runningOnly
                    ? "bg-sky-500/15 border-sky-500/35 text-sky-300"
                    : "bg-zinc-800/40 border-zinc-700/60 text-zinc-400"
                }`}
              >
                {t("Running")}
              </button>
            </div>

            <div className="px-3 py-2 border-b theme-border flex items-center gap-1.5">
              <div ref={newMenuRef} className="relative">
                <button
                  onClick={() => setNewMenuOpen((prev) => !prev)}
                  className={`px-2.5 py-1 rounded-md border text-[11px] transition-all duration-200 ${
                    newMenuOpen
                      ? "bg-sky-500/18 border-sky-500/35 text-sky-300 shadow-[0_0_0_1px_rgba(56,189,248,0.2)]"
                      : "bg-zinc-800/40 border-zinc-700/60 text-zinc-300 hover:bg-zinc-700/50 hover:-translate-y-[1px]"
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Plus size={11} strokeWidth={2} />
                    {t("New")}
                    <ChevronDown
                      size={11}
                      strokeWidth={2}
                      className={`transition-transform duration-200 ${newMenuOpen ? "rotate-180" : ""}`}
                    />
                  </span>
                </button>

                {newMenuOpen && (
                  <div className="theme-modal-scope theme-panel theme-border absolute left-0 top-full mt-1.5 w-[230px] rounded-xl border border-zinc-700/60 bg-zinc-900/96 shadow-2xl overflow-hidden origin-top-left animate-scale-in">
                    <button
                      onClick={() => {
                        setNewMenuOpen(false);
                        void handleCreate("blank");
                      }}
                      className="w-full text-left px-3 py-2 text-[12px] text-zinc-200 hover:bg-zinc-800/75 transition-all duration-200"
                    >
                      <span className="inline-flex items-center gap-2">
                        <Plus size={12} strokeWidth={2} className="text-sky-300" />
                        {t("New Script")}
                      </span>
                    </button>

                    <div className="mx-2 my-1 border-t border-zinc-700/70" />

                    <button
                      onClick={() => {
                        setNewMenuOpen(false);
                        void handleCreate("monitor");
                      }}
                      className="w-full text-left px-3 py-2 text-[12px] text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/70 transition-all duration-200"
                    >
                      {t("Window Monitor Template")}
                    </button>

                    <button
                      onClick={() => {
                        setNewMenuOpen(false);
                        void handleCreate("discord");
                      }}
                      className="w-full text-left px-3 py-2 text-[12px] text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/70 transition-all duration-200"
                    >
                      {t("Discord Bridge Template")}
                    </button>

                    <button
                      onClick={() => {
                        setNewMenuOpen(false);
                        void handleCreate("hub");
                      }}
                      className="w-full text-left px-3 py-2 text-[12px] text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/70 transition-all duration-200"
                    >
                      {t("Hub Link Template")}
                    </button>
                  </div>
                )}
              </div>

              <button
                onClick={() => importRef.current?.click()}
                className="px-2 py-1 rounded-md bg-zinc-800/40 border border-zinc-700/60 text-[11px] text-zinc-300 hover:bg-zinc-700/50 hover:-translate-y-[1px] transition-all duration-200"
              >
                <span className="inline-flex items-center gap-1">
                  <Upload size={11} strokeWidth={2} />
                  {t("Import")}
                </span>
              </button>
              <input
                ref={importRef}
                type="file"
                accept=".js,.txt,.ram-script"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  void handleImportScript(file);
                }}
              />
              <span className="ml-auto text-[11px] text-zinc-600">
                {filteredScripts.length} {t("items")}
              </span>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              {filteredScripts.map((script) => {
                const runtime = runtimeByScript[script.id] || createInitialRuntime();
                const selected = selectedId === script.id;
                return (
                  <button
                    key={script.id}
                    onClick={() => setSelectedId(script.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setSelectedId(script.id);
                      setScriptContextPos(null);
                      setScriptContextMenu({
                        scriptId: script.id,
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                    className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/50 transition-all duration-200 ${
                      selected ? "bg-zinc-800/70" : "hover:bg-zinc-800/35 hover:translate-x-[1px]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-zinc-200 font-medium truncate">{script.name}</span>
                      {script.trusted ? (
                        <ShieldCheck size={13} strokeWidth={1.8} className="text-emerald-300 shrink-0" />
                      ) : (
                        <ShieldAlert size={13} strokeWidth={1.8} className="text-amber-300 shrink-0" />
                      )}
                      <span className="ml-auto">{renderStatusChip(script)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[10px] ${
                          script.enabled
                            ? "border-emerald-500/25 text-emerald-300 bg-emerald-500/10"
                            : "border-zinc-700 text-zinc-500"
                        }`}
                      >
                        {script.enabled ? t("enabled") : t("disabled")}
                      </span>
                      {runtime.lastError ? (
                        <span className="px-1.5 py-0.5 rounded border text-[10px] border-red-500/30 bg-red-500/12 text-red-300 truncate">
                          {t("error")}
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
              {filteredScripts.length === 0 && (
                <div className="px-4 py-8 text-center text-[12px] text-zinc-500">
                  {loaded ? t("No scripts found") : t("Loading scripts...")}
                </div>
              )}
            </div>
          </aside>

          <section className="flex-1 min-w-0 flex flex-col">
            {!selectedScript || !draft ? (
              <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
                {t("Select a script or create a new one")}
              </div>
            ) : (
              <>
                <div className="px-4 py-3 border-b theme-border flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <input
                      value={draft.name}
                      onChange={(event) =>
                        updateDraft((prev) => ({ ...prev, name: event.target.value }))
                      }
                      className="w-full bg-transparent text-[15px] font-semibold text-zinc-100 outline-none"
                    />
                  </div>

                  <button
                    onClick={() => handleToggleEnabled(selectedScript, !selectedScript.enabled)}
                    className={`px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors ${
                      selectedScript.enabled
                        ? "border-emerald-500/35 bg-emerald-500/15 text-emerald-300"
                        : "border-zinc-700 bg-zinc-800/45 text-zinc-400"
                    }`}
                  >
                    {selectedScript.enabled ? t("Enabled") : t("Disabled")}
                  </button>

                  <button
                    onClick={() => {
                      if (workersRef.current.has(selectedScript.id)) {
                        stopScript(selectedScript.id, true);
                      } else {
                        handleRunScript(selectedScript.id);
                      }
                    }}
                    className={`px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors ${
                      workersRef.current.has(selectedScript.id)
                        ? "border-red-500/35 bg-red-500/15 text-red-300"
                        : "border-sky-500/35 bg-sky-500/15 text-sky-300"
                    }`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {workersRef.current.has(selectedScript.id) ? (
                        <Square size={11} strokeWidth={2} />
                      ) : (
                        <Play size={11} strokeWidth={2} />
                      )}
                      {workersRef.current.has(selectedScript.id) ? t("Stop") : t("Run")}
                    </span>
                  </button>

                  <button
                    onClick={() => handleRestartScript(selectedScript.id)}
                    className="px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/45 text-[11px] text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    <span className="inline-flex items-center gap-1">
                      <RotateCcw size={11} strokeWidth={2} />
                      {t("Restart")}
                    </span>
                  </button>

                  <button
                    onClick={() => {
                      void handleExportScript(selectedScript);
                    }}
                    className="px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/45 text-[11px] text-zinc-300 hover:bg-zinc-700 transition-colors"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Download size={11} strokeWidth={2} />
                      {t("Export")}
                    </span>
                  </button>

                  <button
                    onClick={() => {
                      void handleDeleteScript(selectedScript.id);
                    }}
                    className="px-2.5 py-1.5 rounded-lg border border-red-500/35 bg-red-500/12 text-[11px] text-red-300 hover:bg-red-500/20 transition-colors"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Trash2 size={11} strokeWidth={2} />
                      {t("Delete")}
                    </span>
                  </button>
                </div>

                <div className="px-4 py-2 border-b theme-border flex items-center gap-2">
                  {([
                    ["editor", t("Editor")],
                    ["ui", t("UI")],
                    ["logs", t("Logs")],
                    ["api", t("API")],
                  ] as Array<[ScriptTabId, string]>).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setTab(id)}
                      className={`px-2.5 py-1 rounded-md text-[11px] border transition-colors ${
                        tab === id
                          ? "border-sky-500/35 bg-sky-500/15 text-sky-300"
                          : "border-zinc-700/70 bg-zinc-800/40 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      {label}
                    </button>
                  ))}

                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={() => {
                        void handleTrustToggle(selectedScript, !selectedScript.trusted);
                      }}
                      className={`px-2 py-1 rounded-md text-[10px] border transition-colors ${
                        selectedScript.trusted
                          ? "border-emerald-500/35 bg-emerald-500/15 text-emerald-300"
                          : "border-amber-500/35 bg-amber-500/12 text-amber-300"
                      }`}
                    >
                      <span className="inline-flex items-center gap-1">
                        {selectedScript.trusted ? (
                          <ShieldCheck size={11} strokeWidth={2} />
                        ) : (
                          <ShieldAlert size={11} strokeWidth={2} />
                        )}
                        {selectedScript.trusted ? t("Trusted") : t("Untrusted")}
                      </span>
                    </button>

                    <button
                      onClick={() => setShowUnsafe((prev) => !prev)}
                      className="px-2 py-1 rounded-md border border-zinc-700 bg-zinc-800/45 text-[10px] text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      {showUnsafe ? t("Hide Unsafe Details") : t("Show Unsafe Details")}
                    </button>
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-4">
                  {tab === "editor" && (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <PermissionRow
                          label={t("Invoke Rust Commands")}
                          enabled={draft.permissions.allowInvoke}
                          onChange={(value) => {
                            updateDraft((prev) => ({
                              ...prev,
                              permissions: { ...prev.permissions, allowInvoke: value },
                            }));
                          }}
                        />
                        <PermissionRow
                          label={t("HTTP Requests")}
                          enabled={draft.permissions.allowHttp}
                          onChange={(value) => {
                            updateDraft((prev) => ({
                              ...prev,
                              permissions: { ...prev.permissions, allowHttp: value },
                            }));
                          }}
                        />
                        <PermissionRow
                          label={t("WebSocket Connections")}
                          enabled={draft.permissions.allowWebSocket}
                          onChange={(value) => {
                            updateDraft((prev) => ({
                              ...prev,
                              permissions: { ...prev.permissions, allowWebSocket: value },
                            }));
                          }}
                        />
                        <PermissionRow
                          label={t("Window Snapshot")}
                          enabled={draft.permissions.allowWindow}
                          onChange={(value) => {
                            updateDraft((prev) => ({
                              ...prev,
                              permissions: { ...prev.permissions, allowWindow: value },
                            }));
                          }}
                        />
                        <PermissionRow
                          label={t("Modal Access")}
                          enabled={draft.permissions.allowModal}
                          onChange={(value) => {
                            updateDraft((prev) => ({
                              ...prev,
                              permissions: { ...prev.permissions, allowModal: value },
                            }));
                          }}
                        />
                        <PermissionRow
                          label={t("Script Settings")}
                          enabled={draft.permissions.allowSettings}
                          onChange={(value) => {
                            updateDraft((prev) => ({
                              ...prev,
                              permissions: { ...prev.permissions, allowSettings: value },
                            }));
                          }}
                        />
                        <PermissionRow
                          label={t("Custom UI")}
                          enabled={draft.permissions.allowUi}
                          onChange={(value) => {
                            updateDraft((prev) => ({
                              ...prev,
                              permissions: { ...prev.permissions, allowUi: value },
                            }));
                          }}
                        />
                      </div>

                      <div
                        className={`overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out ${
                          showUnsafe
                            ? "max-h-[260px] opacity-100 translate-y-0"
                            : "max-h-0 opacity-0 -translate-y-1 pointer-events-none"
                        }`}
                      >
                        <div className="rounded-lg border border-zinc-700/70 bg-zinc-900/45 px-3 py-2 text-[11px] space-y-1.5">
                          <div className="text-zinc-300 font-medium tracking-wide">{t("Unsafe capability details")}</div>
                          <div className="text-zinc-500">{t("Effective access is trust mode + permission toggle.")}</div>
                          <div className="text-zinc-500">
                            {t("Sandbox mode blocks direct global fetch/WebSocket/importScripts and constructor-chain escapes for untrusted scripts.")}
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-zinc-400">
                            <div>{t("Invoke commands")}</div>
                            <div className={`${draft.trusted && draft.permissions.allowInvoke ? "text-emerald-300" : "text-amber-300"} transition-colors duration-200`}>
                              {draft.permissions.allowInvoke ? (draft.trusted ? t("Allowed") : t("Blocked (untrusted)")) : t("Disabled")}
                            </div>
                            <div>{t("HTTP requests")}</div>
                            <div className={`${draft.trusted && draft.permissions.allowHttp ? "text-emerald-300" : "text-amber-300"} transition-colors duration-200`}>
                              {draft.permissions.allowHttp ? (draft.trusted ? t("Allowed") : t("Blocked (untrusted)")) : t("Disabled")}
                            </div>
                            <div>{t("WebSocket")}</div>
                            <div className={`${draft.trusted && draft.permissions.allowWebSocket ? "text-emerald-300" : "text-amber-300"} transition-colors duration-200`}>
                              {draft.permissions.allowWebSocket ? (draft.trusted ? t("Allowed") : t("Blocked (untrusted)")) : t("Disabled")}
                            </div>
                            <div>{t("Settings write")}</div>
                            <div className={`${draft.trusted && draft.permissions.allowSettings ? "text-emerald-300" : "text-amber-300"} transition-colors duration-200`}>
                              {draft.permissions.allowSettings ? (draft.trusted ? t("Allowed") : t("Blocked (untrusted)")) : t("Disabled")}
                            </div>
                          </div>
                        </div>
                      </div>

                      <label className="flex items-center gap-2 text-[12px] text-zinc-300">
                        <input
                          type="checkbox"
                          checked={draft.autoStart}
                          onChange={(event) =>
                            updateDraft((prev) => ({ ...prev, autoStart: event.target.checked }))
                          }
                          className="h-3.5 w-3.5 accent-sky-500"
                        />
                        {t("Auto start when app launches")}
                      </label>

                      <textarea
                        value={draft.source}
                        onChange={(event) =>
                          updateDraft((prev) => ({ ...prev, source: event.target.value }))
                        }
                        className="w-full h-[360px] resize-none rounded-xl bg-zinc-900 border border-zinc-700/60 text-[12px] text-zinc-200 font-mono leading-relaxed p-3 focus:outline-none focus:border-zinc-500"
                        spellCheck={false}
                      />

                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-zinc-500">
                          {draftDirty
                            ? t("Unsaved changes")
                            : t("Saved at {{time}}", {
                                time: new Date(draft.updatedAtMs).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                  hour12: false,
                                }),
                              })}
                        </span>
                        <button
                          onClick={() => {
                            void handleSaveDraft();
                          }}
                          disabled={!draftDirty || busyId === draft.id}
                          className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-[12px] font-medium text-white transition-colors"
                        >
                          {busyId === draft.id ? t("Saving...") : t("Save Script")}
                        </button>
                      </div>
                    </div>
                  )}

                  {tab === "ui" && (
                    <div className="space-y-3">
                      <div className="text-[12px] text-zinc-500">
                        {t("UI defined by script via ram.ui.set(...) appears here.")}
                      </div>
                      <ScriptUiRenderer
                        scriptId={selectedScript.id}
                        elements={selectedUi}
                        onEvent={handleUiEvent}
                        onStateChange={(nextElements) => {
                          updateRuntime(selectedScript.id, { uiElements: nextElements });
                        }}
                      />
                    </div>
                  )}

                  {tab === "logs" && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <Search
                            size={13}
                            strokeWidth={1.9}
                            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600"
                          />
                          <input
                            value={logQuery}
                            onChange={(event) => setLogQuery(event.target.value)}
                            className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-zinc-800/50 border border-zinc-700/60 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
                            placeholder={t("Search logs")}
                          />
                        </div>
                        <Select
                          value={logLevel}
                          onChange={(value) => setLogLevel(value as ScriptLogLevel | "all")}
                          options={[
                            { value: "all", label: "All" },
                            { value: "debug", label: "Debug" },
                            { value: "info", label: "Info" },
                            { value: "warn", label: "Warn" },
                            { value: "error", label: "Error" },
                          ]}
                          className="w-[130px]"
                        />
                        <button
                          onClick={() => {
                            setLogsByScript((prev) => ({ ...prev, [selectedScript.id]: [] }));
                            setStickLogsToBottom(true);
                          }}
                          className="px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/45 text-[12px] text-zinc-300 hover:bg-zinc-700 transition-colors"
                        >
                          {t("Clear")}
                        </button>
                      </div>

                      <div className="relative">
                        <div
                          ref={logsContainerRef}
                          onScroll={handleLogsScroll}
                          className="rounded-xl border border-zinc-800 bg-zinc-950/40 h-[430px] overflow-y-auto p-2.5 space-y-1"
                        >
                          {visibleLogs.length === 0 && (
                            <div className="text-[12px] text-zinc-600 p-2">{t("No logs")}</div>
                          )}
                          {visibleLogs.map((entry) => (
                            <div
                              key={entry.id}
                              className={`text-[11px] font-mono px-2 py-1 rounded border ${
                                entry.level === "error"
                                  ? "border-red-500/25 bg-red-500/10 text-red-200"
                                  : entry.level === "warn"
                                    ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
                                    : entry.level === "debug"
                                      ? "border-zinc-700/50 bg-zinc-800/30 text-zinc-400"
                                      : "border-zinc-700/50 bg-zinc-800/35 text-zinc-300"
                              }`}
                            >
                              <span className="text-zinc-500 mr-2">
                                {new Date(entry.at).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                  hour12: false,
                                })}
                              </span>
                              <span className="mr-2">[{entry.level.toUpperCase()}]</span>
                              <span className="mr-2">[{entry.source}]</span>
                              <span className="break-all">{entry.message}</span>
                            </div>
                          ))}
                        </div>

                        {!stickLogsToBottom && visibleLogs.length > 0 && (
                          <button
                            onClick={() => {
                              setStickLogsToBottom(true);
                              scrollLogsToBottom("smooth");
                            }}
                            className="absolute right-3 bottom-3 px-2.5 py-1 rounded-md border border-sky-500/35 bg-sky-500/18 text-[11px] text-sky-300 hover:bg-sky-500/28 transition-all duration-200"
                          >
                            {t("Jump to latest")}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {tab === "api" && (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[12px] text-zinc-300">
                        <div className="font-medium text-zinc-200 mb-1">{t("Host API")}</div>
                        <div className="text-zinc-400 leading-relaxed">
                          {t("Use ram.invoke(command, args), ram.http.request(...), ram.ws.connect/send/on(...), ram.window.snapshot(), ram.settings.get/set(), ram.modal.confirm(), ram.ui.set().")}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            onClick={() => {
                              void handleCopyApiSnippet();
                            }}
                            className="px-2.5 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/45 text-[11px] text-zinc-300 hover:bg-zinc-700 transition-colors"
                          >
                            <span className="inline-flex items-center gap-1">
                              <Copy size={11} strokeWidth={2} />
                              {t("Copy snippet")}
                            </span>
                          </button>
                          <span className="text-[11px] text-zinc-500">
                            {selectedScript.trusted
                              ? t("Trusted mode is enabled")
                              : t("Trusted mode is disabled")}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <Search
                            size={13}
                            strokeWidth={1.9}
                            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600"
                          />
                          <input
                            value={apiSearch}
                            onChange={(event) => setApiSearch(event.target.value)}
                            className="w-full pl-8 pr-2.5 py-1.5 rounded-lg bg-zinc-800/50 border border-zinc-700/60 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
                            placeholder={t("Search common command names")}
                          />
                        </div>
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-zinc-950/35 p-2 h-[420px] overflow-y-auto grid grid-cols-2 gap-1">
                        {commandList.map((command) => (
                          <button
                            key={command}
                            onClick={async () => {
                              await navigator.clipboard.writeText(command);
                              store.addToast(t("Copied {{name}}", { name: command }));
                            }}
                            className="text-left px-2.5 py-1.5 rounded-md border border-zinc-700/50 bg-zinc-800/30 text-[11px] text-zinc-300 hover:bg-zinc-700/50 transition-colors font-mono"
                          >
                            {command}
                          </button>
                        ))}
                        {commandList.length === 0 && (
                          <div className="text-[12px] text-zinc-600 px-2 py-2">{t("No matches")}</div>
                        )}
                      </div>

                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 text-[11px] text-zinc-500 leading-relaxed">
                        <div className="mb-1 text-zinc-300 font-medium">{t("WebSocket helper")}</div>
                        <div>{t("Connect with ram.ws.connect({ url, protocols?, allowPrivateNetwork? }).")}</div>
                        <div>{t("Subscribe with ram.ws.on((evt) => ...).")}</div>
                        <div>{t("Events: open, message, error, close.")}</div>
                        <div>{t("Send data with ram.ws.send(connectionId, payload).")}</div>
                        <div>{t("Close one or all connections with ram.ws.close(...).")}</div>
                      </div>

                      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-3 text-[11px] text-zinc-500 leading-relaxed">
                        <div className="mb-1 text-zinc-300 font-medium">{t("Trust Mode")}</div>
                        <div>
                          {t("Untrusted scripts keep read-only behavior. Trusted scripts can invoke commands, use HTTP/WebSocket, and write script-scoped settings.")}
                        </div>
                        <div>
                          {t("HTTP requests block localhost/private-network targets by default. Use allowPrivateNetwork: true in ram.http.request(...) only when intentionally needed.")}
                        </div>
                        <div>
                          {t("WebSocket connections also block localhost/private-network targets by default unless allowPrivateNetwork: true is set in ram.ws.connect(...).")}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="px-4 py-2 border-t theme-border flex items-center justify-between gap-3 text-[11px]">
                  <div className="text-zinc-500 flex items-center gap-2">
                    {(selectedRuntime?.status || "idle") === "running" ? (
                      <>
                        <CheckCircle2 size={13} strokeWidth={2} className="text-emerald-300" />
                        <span>{t("Script running")}</span>
                      </>
                    ) : selectedRuntime?.status === "error" ? (
                      <>
                        <AlertCircle size={13} strokeWidth={2} className="text-red-300" />
                        <span className="text-red-300">{selectedRuntime.lastError || t("Script error")}</span>
                      </>
                    ) : (
                      <span>{t("Script idle")}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (!draft) return;
                        if (!selectedScript) return;
                        if (!draftDirty) {
                          void handleRunScript(selectedScript.id);
                          return;
                        }
                        void handleSaveDraft().then(() => {
                          handleRunScript(selectedScript.id);
                        });
                      }}
                      className="px-3 py-1.5 rounded-lg border border-sky-500/35 bg-sky-500/15 text-[12px] text-sky-300 hover:bg-sky-500/25 transition-colors"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Play size={11} strokeWidth={2} />
                        {t("Run latest")}
                      </span>
                    </button>
                    <button
                      onClick={handleClose}
                      className="px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-800/45 text-[12px] text-zinc-300 hover:bg-zinc-700 transition-colors"
                    >
                      {t("Close")}
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>

          {scriptContextMenu && contextScript && (
            <div
              ref={scriptContextRef}
              className="theme-modal-scope theme-panel theme-border fixed z-[120] min-w-[220px] bg-zinc-900/95 backdrop-blur-xl border border-zinc-700/50 rounded-xl shadow-2xl py-1.5 animate-scale-in"
              style={{
                left: scriptContextPos?.left ?? scriptContextMenu.x,
                top: scriptContextPos?.top ?? scriptContextMenu.y,
              }}
            >
              <MenuLevel>
                {scriptContextItems.map((item, index) => (
                  <MenuItemView
                    key={`${contextScript.id}-${index}`}
                    item={item}
                    close={closeScriptContextMenu}
                    itemKey={String(index)}
                  />
                ))}
              </MenuLevel>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PermissionRow({
  label,
  enabled,
  onChange,
}: {
  label: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      className="w-full px-3 py-2 rounded-lg border border-zinc-700/60 bg-zinc-800/35 hover:bg-zinc-700/45 transition-colors text-left"
    >
      <span className="inline-flex items-center gap-2 text-[12px] text-zinc-300">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            enabled ? "bg-emerald-400" : "bg-zinc-600"
          }`}
        />
        {label}
      </span>
    </button>
  );
}

function ScriptUiRenderer({
  scriptId,
  elements,
  onEvent,
  onStateChange,
}: {
  scriptId: string;
  elements: ScriptUiElement[];
  onEvent: (scriptId: string, payload: Record<string, unknown>) => void;
  onStateChange: (next: ScriptUiElement[]) => void;
}) {
  function updateElementValue(id: string, value: string | number | boolean) {
    const next = elements.map((element) =>
      element.id === id
        ? {
            ...element,
            value,
          }
        : element
    );
    onStateChange(next);
  }

  if (elements.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-700/70 bg-zinc-900/30 p-6 text-center text-[12px] text-zinc-500">
        No custom UI yet
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-3 space-y-2">
      {elements.map((element) => {
        const widthStyle = element.width ? { width: element.width } : undefined;
        const toneClass =
          element.tone === "success"
            ? "text-emerald-300"
            : element.tone === "warn"
              ? "text-amber-300"
              : element.tone === "error"
                ? "text-red-300"
                : element.tone === "accent"
                  ? "text-sky-300"
                  : "text-zinc-300";

        if (element.type === "divider") {
          return <div key={element.id} className="h-px bg-zinc-700/70" />;
        }

        if (element.type === "badge") {
          return (
            <div
              key={element.id}
              className={`inline-flex px-2 py-1 rounded-md border border-zinc-700/70 bg-zinc-800/50 text-[11px] ${toneClass}`}
            >
              {element.text || element.label || element.id}
            </div>
          );
        }

        if (element.type === "button") {
          return (
            <button
              key={element.id}
              disabled={element.disabled}
              style={widthStyle}
              onClick={() => {
                onEvent(scriptId, {
                  id: element.id,
                  action: "click",
                });
              }}
              className="px-2.5 py-1.5 rounded-md border border-zinc-700 bg-zinc-800/45 text-[12px] text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-50"
            >
              {element.text || element.label || element.id}
            </button>
          );
        }

        if (element.type === "text") {
          return (
            <label key={element.id} className="block text-[11px] text-zinc-400">
              {element.label || element.id}
              <input
                value={typeof element.value === "string" ? element.value : ""}
                disabled={element.disabled}
                onChange={(event) => {
                  const value = event.target.value;
                  updateElementValue(element.id, value);
                  onEvent(scriptId, {
                    id: element.id,
                    action: "change",
                    value,
                  });
                }}
                style={widthStyle}
                placeholder={element.placeholder}
                className="mt-1 w-full px-2 py-1 rounded-md bg-zinc-800/50 border border-zinc-700/70 text-[12px] text-zinc-200 focus:outline-none focus:border-zinc-500"
              />
            </label>
          );
        }

        if (element.type === "textarea") {
          return (
            <label key={element.id} className="block text-[11px] text-zinc-400">
              {element.label || element.id}
              <textarea
                value={typeof element.value === "string" ? element.value : ""}
                disabled={element.disabled}
                rows={element.rows || 3}
                onChange={(event) => {
                  const value = event.target.value;
                  updateElementValue(element.id, value);
                  onEvent(scriptId, {
                    id: element.id,
                    action: "change",
                    value,
                  });
                }}
                style={widthStyle}
                placeholder={element.placeholder}
                className="mt-1 w-full px-2 py-1 rounded-md bg-zinc-800/50 border border-zinc-700/70 text-[12px] text-zinc-200 focus:outline-none focus:border-zinc-500 resize-y"
              />
            </label>
          );
        }

        if (element.type === "number") {
          const current =
            typeof element.value === "number"
              ? element.value
              : Number.parseFloat(String(element.value || "0"));
          return (
            <label key={element.id} className="block text-[11px] text-zinc-400">
              {element.label || element.id}
              <input
                type="number"
                value={Number.isFinite(current) ? current : 0}
                disabled={element.disabled}
                min={element.min}
                max={element.max}
                step={element.step || 1}
                onChange={(event) => {
                  const value = Number.parseFloat(event.target.value || "0");
                  updateElementValue(element.id, Number.isFinite(value) ? value : 0);
                  onEvent(scriptId, {
                    id: element.id,
                    action: "change",
                    value: Number.isFinite(value) ? value : 0,
                  });
                }}
                style={widthStyle}
                className="mt-1 w-full px-2 py-1 rounded-md bg-zinc-800/50 border border-zinc-700/70 text-[12px] text-zinc-200 focus:outline-none focus:border-zinc-500"
              />
            </label>
          );
        }

        if (element.type === "toggle") {
          const checked = Boolean(element.value);
          return (
            <label key={element.id} className="inline-flex items-center gap-2 text-[12px] text-zinc-300">
              <input
                type="checkbox"
                checked={checked}
                disabled={element.disabled}
                onChange={(event) => {
                  const value = event.target.checked;
                  updateElementValue(element.id, value);
                  onEvent(scriptId, {
                    id: element.id,
                    action: "change",
                    value,
                  });
                }}
                className="h-3.5 w-3.5 accent-sky-500"
              />
              {element.label || element.text || element.id}
            </label>
          );
        }

        if (element.type === "select") {
          const value = String(element.value || "");
          return (
            <label key={element.id} className="block text-[11px] text-zinc-400">
              {element.label || element.id}
              <select
                value={value}
                disabled={element.disabled}
                style={widthStyle}
                onChange={(event) => {
                  const next = event.target.value;
                  updateElementValue(element.id, next);
                  onEvent(scriptId, {
                    id: element.id,
                    action: "change",
                    value: next,
                  });
                }}
                className="mt-1 w-full px-2 py-1 rounded-md bg-zinc-800/50 border border-zinc-700/70 text-[12px] text-zinc-200 focus:outline-none focus:border-zinc-500"
              >
                {(element.options || []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }

        return (
          <div key={element.id} className="text-[12px] text-zinc-500">
            Unsupported element: {element.type}
          </div>
        );
      })}
    </div>
  );
}
