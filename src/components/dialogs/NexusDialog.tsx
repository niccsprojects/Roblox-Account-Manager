import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../../store";
import { useModalClose } from "../../hooks/useModalClose";
import { SlidingTabBar } from "../ui/SlidingTabBar";
import { Select } from "../ui/Select";
import { NumericInput } from "../ui/NumericInput";
import { tr, useTr } from "../../i18n/text";
import { X, ChevronRight } from "lucide-react";

interface NexusAccount {
  username: string;
  auto_execute: string;
  place_id: number;
  job_id: string;
  relaunch_delay: number;
  auto_relaunch: boolean;
  is_checked: boolean;
  status: string;
  in_game_job_id: string;
}

interface NexusElement {
  name: string;
  element_type: string;
  content: string;
  size: [number, number] | null;
  margin: [number, number, number, number] | null;
  decimal_places: number | null;
  increment: string | null;
  value: string;
  is_newline: boolean;
}

interface NexusStatus {
  running: boolean;
  port: number | null;
  connected_count: number;
}

type TabId = "control" | "settings" | "help";

export function NexusDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useStore();
  const { visible, closing, handleClose } = useModalClose(open, onClose);
  const [tab, setTab] = useState<TabId>("control");
  const [status, setStatus] = useState<NexusStatus>({ running: false, port: null, connected_count: 0 });
  const [accounts, setAccounts] = useState<NexusAccount[]>([]);
  const [elements, setElements] = useState<NexusElement[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [addInput, setAddInput] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [autoExecText, setAutoExecText] = useState("");
  const [placeInput, setPlaceInput] = useState("");
  const [jobInput, setJobInput] = useState("");
  const [scriptOpen, setScriptOpen] = useState(false);
  const [autoExecOpen, setAutoExecOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; username: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const [sStartOnLaunch, setSStartOnLaunch] = useState(false);
  const [sAllowExternal, setSAllowExternal] = useState(false);
  const [sInternetCheck, setSInternetCheck] = useState(false);
  const [sUsePresence, setSUsePresence] = useState(false);
  const [sRelaunchDelay, setSRelaunchDelay] = useState(30);
  const [sLauncherDelay, setSLauncherDelay] = useState(9);
  const [sPort, setSPort] = useState(5242);
  const [sAutoMinimize, setSAutoMinimize] = useState(false);
  const [sAutoMinInterval, setSAutoMinInterval] = useState(30);
  const [sAutoClose, setSAutoClose] = useState(false);
  const [sAutoCloseInterval, setSAutoCloseInterval] = useState(30);
  const [sAutoCloseType, setSAutoCloseType] = useState(0);
  const [sMaxInstances, setSMaxInstances] = useState(10);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, a, e, l] = await Promise.all([
        invoke<NexusStatus>("get_nexus_status"),
        invoke<NexusAccount[]>("get_nexus_accounts"),
        invoke<NexusElement[]>("get_nexus_elements"),
        invoke<string[]>("get_nexus_log"),
      ]);
      setStatus(s);
      setAccounts(a);
      setElements(e);
      setLog(l);
    } catch {}
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();

    const s = store.settings;
    if (s?.AccountControl) {
      setSStartOnLaunch(s.AccountControl.StartOnLaunch === "true");
      setSAllowExternal(s.AccountControl.AllowExternalConnections === "true");
      setSInternetCheck(s.AccountControl.InternetCheck === "true");
      setSUsePresence(s.AccountControl.UsePresence === "true");
      setSRelaunchDelay(parseInt(s.AccountControl.RelaunchDelay) || 30);
      setSLauncherDelay(parseInt(s.AccountControl.LauncherDelay) || 9);
      setSPort(parseInt(s.AccountControl.NexusPort) || 5242);
      setSAutoMinimize(s.AccountControl.AutoMinimizeEnabled === "true");
      setSAutoMinInterval(parseInt(s.AccountControl.AutoMinimizeInterval) || 30);
      setSAutoClose(s.AccountControl.AutoCloseEnabled === "true");
      setSAutoCloseInterval(parseInt(s.AccountControl.AutoCloseInterval) || 30);
      setSAutoCloseType(parseInt(s.AccountControl.AutoCloseType) || 0);
      setSMaxInstances(parseInt(s.AccountControl.MaxInstances) || 10);
    }
    setSettingsLoaded(true);

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const unlisteners: (() => void)[] = [];

    listen<{ message: string }>("nexus-log", (e) => {
      setLog((prev) => [...prev, e.payload.message]);
    }).then((u) => unlisteners.push(u));

    listen("nexus-account-connected", () => refresh()).then((u) => unlisteners.push(u));
    listen("nexus-account-disconnected", () => refresh()).then((u) => unlisteners.push(u));
    listen("nexus-element-created", () => refresh()).then((u) => unlisteners.push(u));
    listen("nexus-element-newline", () => refresh()).then((u) => unlisteners.push(u));

    return () => unlisteners.forEach((u) => u());
  }, [open, refresh]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  useEffect(() => {
    if (!selectedUsername) return;
    const acc = accounts.find((a) => a.username === selectedUsername);
    if (acc) {
      setPlaceInput(acc.place_id ? String(acc.place_id) : "");
      setJobInput(acc.job_id || "");
      setAutoExecText(acc.auto_execute || "");
    }
  }, [selectedUsername, accounts]);

  if (!visible) return null;

  async function handleStartStop() {
    try {
      if (status.running) {
        await invoke("stop_nexus_server");
        store.addToast(tr("Nexus server stopped"));
      } else {
        const port = await invoke<number>("start_nexus_server");
        store.addToast(tr("Nexus server started on port {{port}}", { port }));
      }
      refresh();
    } catch (e) {
      store.addToast(tr("Error: {{error}}", { error: String(e) }));
    }
  }

  async function handleAdd() {
    if (!addInput.trim()) return;
    try {
      await invoke("add_nexus_account", { username: addInput.trim() });
      setAddInput("");
      refresh();
    } catch (e) {
      store.addToast(tr("Error: {{error}}", { error: String(e) }));
    }
  }

  async function handleRemove(usernames: string[]) {
    try {
      await invoke("remove_nexus_accounts", { usernames });
      if (selectedUsername && usernames.includes(selectedUsername)) setSelectedUsername(null);
      refresh();
    } catch (e) {
      store.addToast(tr("Error: {{error}}", { error: String(e) }));
    }
  }

  async function handleCheckToggle(username: string) {
    const acc = accounts.find((a) => a.username === username);
    if (!acc) return;
    try {
      await invoke("update_nexus_account", {
        account: { ...acc, is_checked: !acc.is_checked },
      });
      refresh();
    } catch {}
  }

  async function handleCheckAll(checked: boolean) {
    for (const acc of accounts) {
      if (acc.is_checked !== checked) {
        await invoke("update_nexus_account", {
          account: { ...acc, is_checked: checked },
        }).catch(() => {});
      }
    }
    refresh();
  }

  async function handleSendCommand() {
    if (!commandInput.trim()) return;
    try {
      await invoke("nexus_send_command", { message: commandInput });
      setCommandInput("");
    } catch (e) {
      store.addToast(tr("Error: {{error}}", { error: String(e) }));
    }
  }

  async function handleExecuteScript() {
    if (!scriptText.trim()) return;
    try {
      await invoke("nexus_send_command", { message: `execute ${scriptText}` });
    } catch (e) {
      store.addToast(tr("Error: {{error}}", { error: String(e) }));
    }
  }

  async function handleAutoExecBlur() {
    if (!selectedUsername) return;
    const acc = accounts.find((a) => a.username === selectedUsername);
    if (!acc) return;
    try {
      await invoke("update_nexus_account", {
        account: { ...acc, auto_execute: autoExecText },
      });
    } catch {}
  }

  async function handleFieldBlur(field: "place_id" | "job_id") {
    if (!selectedUsername) return;
    const acc = accounts.find((a) => a.username === selectedUsername);
    if (!acc) return;
    const update = { ...acc };
    if (field === "place_id") update.place_id = parseInt(placeInput) || 0;
    if (field === "job_id") update.job_id = jobInput;
    try {
      await invoke("update_nexus_account", { account: update });
      refresh();
    } catch {}
  }

  async function handleAutoRelaunchToggle() {
    if (!selectedUsername) return;
    const acc = accounts.find((a) => a.username === selectedUsername);
    if (!acc) return;
    try {
      await invoke("update_nexus_account", {
        account: { ...acc, auto_relaunch: !acc.auto_relaunch },
      });
      refresh();
    } catch {}
  }

  async function handleElementClick(name: string) {
    try {
      await invoke("nexus_send_command", { message: `ButtonClicked:${name}` });
    } catch {}
  }

  async function handleElementChange(name: string, value: string) {
    try {
      await invoke("set_nexus_element_value", { name, value });
    } catch {}
  }

  function saveSetting(key: string, value: string) {
    if (!settingsLoaded) return;
    invoke("update_setting", { section: "AccountControl", key, value }).catch(() => {});
  }

  const selectedAcc = accounts.find((a) => a.username === selectedUsername);
  const allChecked = accounts.length > 0 && accounts.every((a) => a.is_checked);

  const tabs: { id: TabId; label: string }[] = [
    { id: "control", label: tr("Control Panel") },
    { id: "settings", label: tr("Settings") },
    { id: "help", label: tr("Help") },
  ];

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      onClick={handleClose}
    >
      <div
        className={`theme-modal-scope theme-panel theme-border bg-zinc-900 border border-zinc-800/80 rounded-2xl shadow-2xl w-[780px] h-[580px] flex flex-col overflow-hidden ${closing ? "animate-scale-out" : "animate-scale-in"}`}
        onClick={(e) => {
          e.stopPropagation();
          setContextMenu(null);
        }}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-[15px] font-semibold text-zinc-100 tracking-tight">{tr("Account Control")}</h2>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${status.running ? "bg-emerald-400" : "bg-zinc-600"}`} />
              <span className="text-[10px] text-zinc-500 font-mono">
                {status.running
                  ? tr("Port {{port}} - {{count}} connected", { port: status.port, count: status.connected_count })
                  : tr("Offline")}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleStartStop}
              className={`px-3 py-1 rounded-lg text-[11px] font-medium transition-all ${
                status.running
                  ? "bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
                  : "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 border border-emerald-500/20"
              }`}
            >
              {status.running ? tr("Stop") : tr("Start")}
            </button>
            <button onClick={handleClose} className="p-1 rounded-md text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors">
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        <SlidingTabBar tabs={tabs} activeTab={tab} onTabChange={setTab} />

        <div className="h-px bg-zinc-800/60 mx-5 mt-2" />

        <div className="flex-1 min-h-0 overflow-hidden">
          {tab === "control" && (
            <ControlPanel
              accounts={accounts}
              selectedUsername={selectedUsername}
              selectedAcc={selectedAcc}
              allChecked={allChecked}
              addInput={addInput}
              commandInput={commandInput}
              scriptText={scriptText}
              autoExecText={autoExecText}
              placeInput={placeInput}
              jobInput={jobInput}
              scriptOpen={scriptOpen}
              autoExecOpen={autoExecOpen}
              outputOpen={outputOpen}
              log={log}
              elements={elements}
              contextMenu={contextMenu}
              logRef={logRef}
              setSelectedUsername={setSelectedUsername}
              setAddInput={setAddInput}
              setCommandInput={setCommandInput}
              setScriptText={setScriptText}
              setAutoExecText={setAutoExecText}
              setPlaceInput={setPlaceInput}
              setJobInput={setJobInput}
              setScriptOpen={setScriptOpen}
              setAutoExecOpen={setAutoExecOpen}
              setOutputOpen={setOutputOpen}
              setContextMenu={setContextMenu}
              onAdd={handleAdd}
              onRemove={handleRemove}
              onCheckToggle={handleCheckToggle}
              onCheckAll={handleCheckAll}
              onSendCommand={handleSendCommand}
              onExecuteScript={handleExecuteScript}
              onAutoExecBlur={handleAutoExecBlur}
              onFieldBlur={handleFieldBlur}
              onAutoRelaunchToggle={handleAutoRelaunchToggle}
              onElementClick={handleElementClick}
              onElementChange={handleElementChange}
              onClearLog={async () => {
                await invoke("clear_nexus_log").catch(() => {});
                setLog([]);
              }}
            />
          )}

          {tab === "settings" && (
            <SettingsPanel
              startOnLaunch={sStartOnLaunch}
              allowExternal={sAllowExternal}
              internetCheck={sInternetCheck}
              usePresence={sUsePresence}
              relaunchDelay={sRelaunchDelay}
              launcherDelay={sLauncherDelay}
              port={sPort}
              autoMinimize={sAutoMinimize}
              autoMinInterval={sAutoMinInterval}
              autoClose={sAutoClose}
              autoCloseInterval={sAutoCloseInterval}
              autoCloseType={sAutoCloseType}
              maxInstances={sMaxInstances}
              onToggle={(key, val) => {
                const setters: Record<string, (v: boolean) => void> = {
                  StartOnLaunch: setSStartOnLaunch,
                  AllowExternalConnections: setSAllowExternal,
                  InternetCheck: setSInternetCheck,
                  UsePresence: setSUsePresence,
                  AutoMinimizeEnabled: setSAutoMinimize,
                  AutoCloseEnabled: setSAutoClose,
                };
                setters[key]?.(val);
                saveSetting(key, val ? "true" : "false");
              }}
              onNumber={(key, val) => {
                const setters: Record<string, (v: number) => void> = {
                  RelaunchDelay: setSRelaunchDelay,
                  LauncherDelay: setSLauncherDelay,
                  NexusPort: setSPort,
                  AutoMinimizeInterval: setSAutoMinInterval,
                  AutoCloseInterval: setSAutoCloseInterval,
                  MaxInstances: setSMaxInstances,
                };
                setters[key]?.(val);
                saveSetting(key, String(val));
              }}
              onCloseType={(val) => {
                setSAutoCloseType(val);
                saveSetting("AutoCloseType", String(val));
              }}
            />
          )}

          {tab === "help" && <HelpPanel />}
        </div>
      </div>
    </div>
  );
}

function ControlPanel({
  accounts,
  selectedUsername,
  selectedAcc,
  allChecked,
  addInput,
  commandInput,
  scriptText,
  autoExecText,
  placeInput,
  jobInput,
  scriptOpen,
  autoExecOpen,
  outputOpen,
  log,
  elements,
  contextMenu,
  logRef,
  setSelectedUsername,
  setAddInput,
  setCommandInput,
  setScriptText,
  setAutoExecText,
  setPlaceInput,
  setJobInput,
  setScriptOpen,
  setAutoExecOpen,
  setOutputOpen,
  setContextMenu,
  onAdd,
  onRemove,
  onCheckToggle,
  onCheckAll,
  onSendCommand,
  onExecuteScript,
  onAutoExecBlur,
  onFieldBlur,
  onAutoRelaunchToggle,
  onElementClick,
  onElementChange,
  onClearLog,
}: {
  accounts: NexusAccount[];
  selectedUsername: string | null;
  selectedAcc: NexusAccount | undefined;
  allChecked: boolean;
  addInput: string;
  commandInput: string;
  scriptText: string;
  autoExecText: string;
  placeInput: string;
  jobInput: string;
  scriptOpen: boolean;
  autoExecOpen: boolean;
  outputOpen: boolean;
  log: string[];
  elements: NexusElement[];
  contextMenu: { x: number; y: number; username: string } | null;
  logRef: React.RefObject<HTMLDivElement | null>;
  setSelectedUsername: (u: string | null) => void;
  setAddInput: (v: string) => void;
  setCommandInput: (v: string) => void;
  setScriptText: (v: string) => void;
  setAutoExecText: (v: string) => void;
  setPlaceInput: (v: string) => void;
  setJobInput: (v: string) => void;
  setScriptOpen: (v: boolean) => void;
  setAutoExecOpen: (v: boolean) => void;
  setOutputOpen: (v: boolean) => void;
  setContextMenu: (v: { x: number; y: number; username: string } | null) => void;
  onAdd: () => void;
  onRemove: (usernames: string[]) => void;
  onCheckToggle: (username: string) => void;
  onCheckAll: (checked: boolean) => void;
  onSendCommand: () => void;
  onExecuteScript: () => void;
  onAutoExecBlur: () => void;
  onFieldBlur: (field: "place_id" | "job_id") => void;
  onAutoRelaunchToggle: () => void;
  onElementClick: (name: string) => void;
  onElementChange: (name: string, value: string) => void;
  onClearLog: () => void;
}) {
  const t = useTr();
  return (
    <div className="flex h-full">
      <div className="w-[240px] border-r border-zinc-800/60 flex flex-col shrink-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/40">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={() => onCheckAll(!allChecked)}
            className="accent-sky-500 w-3.5 h-3.5 cursor-pointer"
          />
          <span className="text-[11px] text-zinc-400 font-medium flex-1">{t("Accounts")}</span>
          <span className="text-[10px] text-zinc-600 font-mono">{accounts.length}</span>
        </div>

        <div className="flex-1 overflow-y-auto">
          {accounts.map((acc) => (
            <div
              key={acc.username}
              onClick={() => setSelectedUsername(acc.username)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelectedUsername(acc.username);
                setContextMenu({ x: e.clientX, y: e.clientY, username: acc.username });
              }}
              className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors ${
                selectedUsername === acc.username
                  ? "theme-row-selected"
                  : "hover:bg-zinc-800/40"
              }`}
            >
              <input
                type="checkbox"
                checked={acc.is_checked}
                onChange={(e) => {
                  e.stopPropagation();
                  onCheckToggle(acc.username);
                }}
                onClick={(e) => e.stopPropagation()}
                className="accent-sky-500 w-3 h-3 cursor-pointer shrink-0"
              />
              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                acc.status === "Online" ? "bg-emerald-400" : "bg-zinc-600"
              }`} />
              <span className="text-[12px] text-zinc-300 truncate flex-1">{acc.username}</span>
              {acc.in_game_job_id && acc.status === "Online" && (
                <span className="text-[9px] text-zinc-600 font-mono truncate max-w-[60px]">
                  {acc.in_game_job_id.slice(0, 8)}
                </span>
              )}
            </div>
          ))}
          {accounts.length === 0 && (
            <div className="px-3 py-6 text-center text-[11px] text-zinc-600">
              {t("No accounts added")}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 p-2 border-t border-zinc-800/40">
          <input
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onAdd()}
            placeholder={t("Username")}
            className="flex-1 px-2 py-1 bg-zinc-800/50 border border-zinc-700/50 rounded-md text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          <button
            onClick={onAdd}
            className="px-2 py-1 bg-zinc-800 border border-zinc-700/50 rounded-md text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            {t("Add")}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5">
        {selectedAcc && (
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selectedAcc.auto_relaunch}
                onChange={onAutoRelaunchToggle}
                className="accent-sky-500 w-3.5 h-3.5"
              />
              <span className="text-[12px] text-zinc-300">{t("Auto Relaunch")}</span>
            </label>
          </div>
        )}

        {selectedAcc && (
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <label className="text-[10px] text-zinc-600 mb-0.5 block">{t("Place ID")}</label>
              <input
                value={placeInput}
                onChange={(e) => setPlaceInput(e.target.value)}
                onBlur={() => onFieldBlur("place_id")}
                className="w-full px-2 py-1 bg-zinc-800/50 border border-zinc-700/50 rounded-md text-[12px] text-zinc-300 font-mono focus:outline-none focus:border-zinc-600"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-zinc-600 mb-0.5 block">{t("Job ID")}</label>
              <input
                value={jobInput}
                onChange={(e) => setJobInput(e.target.value)}
                onBlur={() => onFieldBlur("job_id")}
                className="w-full px-2 py-1 bg-zinc-800/50 border border-zinc-700/50 rounded-md text-[12px] text-zinc-300 font-mono focus:outline-none focus:border-zinc-600"
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <input
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSendCommand()}
            placeholder={t("Command")}
            className="flex-1 px-2.5 py-1.5 bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-[12px] text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
          />
          <button
            onClick={onSendCommand}
            className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-[11px] font-medium transition-colors"
          >
            {t("Send")}
          </button>
        </div>

        <CollapsibleSection title={t("Script")} open={scriptOpen} onToggle={() => setScriptOpen(!scriptOpen)}>
          <textarea
            value={scriptText}
            onChange={(e) => setScriptText(e.target.value)}
            className="w-full h-24 px-2.5 py-2 bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-[11px] text-zinc-300 font-mono resize-none focus:outline-none focus:border-zinc-600"
            placeholder={t("Lua script...")}
          />
          <div className="flex items-center gap-1.5 mt-1.5">
            <button
              onClick={onExecuteScript}
              className="px-3 py-1 bg-sky-600 hover:bg-sky-500 text-white rounded-md text-[10px] font-medium transition-colors"
            >
              {t("Execute")}
            </button>
            <button
              onClick={() => setScriptText("")}
              className="px-3 py-1 bg-zinc-800 border border-zinc-700/50 rounded-md text-[10px] text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              {t("Clear")}
            </button>
          </div>
        </CollapsibleSection>

        {selectedAcc && (
          <CollapsibleSection title={t("Auto Execute")} open={autoExecOpen} onToggle={() => setAutoExecOpen(!autoExecOpen)}>
            <textarea
              value={autoExecText}
              onChange={(e) => setAutoExecText(e.target.value)}
              onBlur={onAutoExecBlur}
              className="w-full h-20 px-2.5 py-2 bg-zinc-800/50 border border-zinc-700/50 rounded-lg text-[11px] text-zinc-300 font-mono resize-none focus:outline-none focus:border-zinc-600"
              placeholder={t("Script to execute on connect...")}
            />
          </CollapsibleSection>
        )}

        <CollapsibleSection title={t("Output")} open={outputOpen} onToggle={() => setOutputOpen(!outputOpen)} actions={
          <button onClick={onClearLog} className="text-[9px] text-zinc-600 hover:text-zinc-400 transition-colors">
            {t("Clear")}
          </button>
        }>
          <div ref={logRef} className="h-28 overflow-y-auto bg-zinc-950/50 border border-zinc-800/40 rounded-lg p-2 space-y-0.5">
            {log.length === 0 && (
              <span className="text-[10px] text-zinc-600">{t("No output")}</span>
            )}
            {log.map((msg, i) => (
              <div key={i} className="text-[10px] text-zinc-400 font-mono leading-relaxed break-all">
                {msg}
              </div>
            ))}
          </div>
        </CollapsibleSection>

        {elements.length > 0 && (
          <div className="flex flex-wrap items-start gap-1.5">
            {elements.map((el) => {
              if (el.is_newline) return <div key={el.name} className="w-full h-0" />;

              if (el.element_type === "Button") {
                return (
                  <button
                    key={el.name}
                    onClick={() => onElementClick(el.name)}
                    className="px-2.5 py-1 bg-zinc-800 border border-zinc-700/50 rounded-md text-[11px] text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
                  >
                    {el.content}
                  </button>
                );
              }

              if (el.element_type === "TextBox") {
                return (
                  <input
                    key={el.name}
                    value={el.value}
                    onChange={(e) => onElementChange(el.name, e.target.value)}
                    className="px-2 py-1 bg-zinc-800/50 border border-zinc-700/50 rounded-md text-[11px] text-zinc-300 focus:outline-none focus:border-zinc-600"
                    style={{ width: el.size ? el.size[0] : 75 }}
                  />
                );
              }

              if (el.element_type === "Numeric") {
                const numericValue = Number.parseFloat(el.value);
                const stepValue = Number.parseFloat(el.increment || "1");
                return (
                  <div key={el.name} style={{ width: el.size ? el.size[0] : 75 }}>
                    <NumericInput
                      value={Number.isFinite(numericValue) ? numericValue : 0}
                      onChange={(next) => onElementChange(el.name, String(next))}
                      step={Number.isFinite(stepValue) && stepValue > 0 ? stepValue : 1}
                      integer={el.decimal_places !== null ? el.decimal_places <= 0 : undefined}
                      className="w-full px-2 py-1 bg-zinc-800/50 border border-zinc-700/50 rounded-md text-[11px] text-zinc-300 font-mono focus:outline-none focus:border-zinc-600 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                );
              }

              if (el.element_type === "Label") {
                return (
                  <span key={el.name} className="text-[11px] text-zinc-400 py-1 px-1">
                    {el.content}
                  </span>
                );
              }

              return null;
            })}
          </div>
        )}
      </div>

      {contextMenu &&
        createPortal(
          <div
            className="theme-modal-scope theme-panel theme-border fixed z-100 bg-zinc-900 border border-zinc-700/60 rounded-lg shadow-xl py-1 min-w-[140px] animate-scale-in"
            style={{
              left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 148)),
              top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 96)),
            }}
          >
            <button
              onClick={() => {
                const acc = accounts.find((a) => a.username === contextMenu.username);
                if (acc?.in_game_job_id) {
                  navigator.clipboard.writeText(acc.in_game_job_id);
                }
                setContextMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              {t("Copy Job ID")}
            </button>
            <button
              onClick={() => {
                onRemove([contextMenu.username]);
                setContextMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left text-[11px] text-red-400 hover:bg-zinc-800 transition-colors"
            >
              {t("Remove")}
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}

function CollapsibleSection({
  title,
  open,
  onToggle,
  actions,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [rendered, setRendered] = useState(open);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setAnimating(true);
    } else if (rendered) {
      setAnimating(true);
      const t = setTimeout(() => { setRendered(false); setAnimating(false); }, 100);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (open && animating) {
      const t = setTimeout(() => setAnimating(false), 150);
      return () => clearTimeout(t);
    }
  }, [open, animating]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <button onClick={onToggle} className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors">
          <ChevronRight size={10} strokeWidth={2} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          {title}
        </button>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      {rendered && (
        <div className={open ? "animate-expand" : "animate-collapse"}>
          {children}
        </div>
      )}
    </div>
  );
}

function SettingsPanel({
  startOnLaunch,
  allowExternal,
  internetCheck,
  usePresence,
  relaunchDelay,
  launcherDelay,
  port,
  autoMinimize,
  autoMinInterval,
  autoClose,
  autoCloseInterval,
  autoCloseType,
  maxInstances,
  onToggle,
  onNumber,
  onCloseType,
}: {
  startOnLaunch: boolean;
  allowExternal: boolean;
  internetCheck: boolean;
  usePresence: boolean;
  relaunchDelay: number;
  launcherDelay: number;
  port: number;
  autoMinimize: boolean;
  autoMinInterval: number;
  autoClose: boolean;
  autoCloseInterval: number;
  autoCloseType: number;
  maxInstances: number;
  onToggle: (key: string, val: boolean) => void;
  onNumber: (key: string, val: number) => void;
  onCloseType: (val: number) => void;
}) {
  const t = useTr();
  return (
    <div className="p-5 overflow-y-auto h-full">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <SettingToggle label="Start on Launch" checked={startOnLaunch} onChange={(v) => onToggle("StartOnLaunch", v)} />
        <SettingToggle label="Allow External Connections" checked={allowExternal} onChange={(v) => onToggle("AllowExternalConnections", v)} />
        <SettingToggle label="Check Internet Before Launch" checked={internetCheck} onChange={(v) => onToggle("InternetCheck", v)} />
        <SettingToggle label="Use Presence API" checked={usePresence} onChange={(v) => onToggle("UsePresence", v)} />
      </div>

      <div className="h-px bg-zinc-800/60 my-3" />

      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        <SettingNumber label="Relaunch Delay" value={relaunchDelay} min={1} max={3600} suffix="sec" onChange={(v) => onNumber("RelaunchDelay", v)} />
        <SettingNumber label="Launcher Delay" value={launcherDelay} min={1} max={3600} suffix="sec" onChange={(v) => onNumber("LauncherDelay", v)} />
        <SettingNumber label="Port" value={port} min={1} max={65535} onChange={(v) => onNumber("NexusPort", v)} />
      </div>

      <div className="h-px bg-zinc-800/60 my-3" />

      <div className="space-y-2">
        <SettingToggle label="Auto Minimize Roblox" checked={autoMinimize} onChange={(v) => onToggle("AutoMinimizeEnabled", v)} />
        {autoMinimize && (
          <SettingNumber label="Interval" value={autoMinInterval} min={5} max={3600} suffix="sec" onChange={(v) => onNumber("AutoMinimizeInterval", v)} />
        )}

        <SettingToggle label="Auto Close Roblox" checked={autoClose} onChange={(v) => onToggle("AutoCloseEnabled", v)} />
        {autoClose && (
          <div className="pl-4 space-y-2">
            <SettingNumber label="Interval" value={autoCloseInterval} min={1} max={3600} suffix="min" onChange={(v) => onNumber("AutoCloseInterval", v)} />
            <div className="flex items-center gap-3">
              <span className="text-[12px] text-zinc-400">{t("Type")}</span>
              <Select
                value={String(autoCloseType)}
                options={[
                  { value: "0", label: "Per Instance" },
                  { value: "1", label: "Global" },
                ]}
                onChange={(v) => onCloseType(parseInt(v))}
                className="ml-auto w-32"
              />
            </div>
            <SettingNumber label="Max Instances" value={maxInstances} min={1} max={100} onChange={(v) => onNumber("MaxInstances", v)} />
          </div>
        )}
      </div>
    </div>
  );
}

function SettingToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const t = useTr();
  return (
    <div
      className="flex items-center gap-2.5 py-1.5 px-1 rounded-lg cursor-pointer select-none hover:bg-white/2 transition-colors"
      onClick={() => onChange(!checked)}
    >
      <div className="relative shrink-0">
        <div className={`w-7 h-[16px] rounded-full transition-all duration-200 ${checked ? "bg-[var(--toggle-on-bg)]" : "bg-[var(--toggle-off-bg)]"}`} />
        <div className={`absolute top-[2px] w-[12px] h-[12px] rounded-full bg-[var(--toggle-knob-bg)] transition-all duration-200 ${checked ? "left-[13px]" : "left-[2px]"}`} />
      </div>
      <span className="text-[12px] text-zinc-300">{t(label)}</span>
    </div>
  );
}

function SettingNumber({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  const t = useTr();
  return (
    <div className="flex items-center gap-2 py-1 px-1">
      <span className="text-[12px] text-zinc-400">{t(label)}</span>
      <div className="flex items-center gap-1 ml-auto">
        <NumericInput
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={1}
          integer
          className="w-16 px-2 py-0.5 bg-zinc-800/60 border border-zinc-700/50 rounded-md text-[12px] text-zinc-200 text-right font-mono focus:outline-none focus:border-zinc-600 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        {suffix && <span className="text-[10px] text-zinc-600">{t(suffix)}</span>}
      </div>
    </div>
  );
}

function HelpPanel() {
  const t = useTr();
  return (
    <div className="p-5 space-y-4">
      <div>
        <h3 className="text-[13px] font-medium text-zinc-200 mb-2">{t("Getting Started")}</h3>
        <div className="text-[12px] text-zinc-400 leading-relaxed space-y-1.5">
          <p>1. {t("Add accounts to the control list using the panel on the left.")}</p>
          <p>2. {t("Start the Nexus server using the Start button in the header.")}</p>
          <p>3. {t("Execute Nexus.lua in each Roblox client you want to control.")}</p>
          <p>4. {t("Connected clients will appear as Online with a green status dot.")}</p>
          <p>5. {t("Use the command input or script panel to send commands to checked accounts.")}</p>
        </div>
      </div>

      <div>
        <h3 className="text-[13px] font-medium text-zinc-200 mb-2">{t("Commands")}</h3>
        <div className="text-[12px] text-zinc-400 leading-relaxed space-y-1">
          <p>
            <code className="text-zinc-300 bg-zinc-800/60 px-1.5 py-0.5 rounded text-[11px] font-mono">execute &lt;script&gt;</code>
            {" "} - {t("Run Lua script on clients")}
          </p>
          <p>
            <code className="text-zinc-300 bg-zinc-800/60 px-1.5 py-0.5 rounded text-[11px] font-mono">teleport &lt;placeId&gt; [jobId]</code>
            {" "} - {t("Teleport to place")}
          </p>
          <p>
            <code className="text-zinc-300 bg-zinc-800/60 px-1.5 py-0.5 rounded text-[11px] font-mono">rejoin</code>
            {" "} - {t("Rejoin current server")}
          </p>
          <p>
            <code className="text-zinc-300 bg-zinc-800/60 px-1.5 py-0.5 rounded text-[11px] font-mono">mute</code>
            {" "} /{" "}
            <code className="text-zinc-300 bg-zinc-800/60 px-1.5 py-0.5 rounded text-[11px] font-mono">unmute</code>
            {" "} - {t("Toggle audio")}
          </p>
          <p>
            <code className="text-zinc-300 bg-zinc-800/60 px-1.5 py-0.5 rounded text-[11px] font-mono">performance [fps]</code>
            {" "} - {t("Low performance mode")}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={async () => {
            try {
              const path = await invoke<string>("export_nexus_lua");
              await navigator.clipboard.writeText(path);
            } catch {}
          }}
          className="px-3 py-1.5 bg-zinc-800 border border-zinc-700/50 rounded-lg text-[11px] text-zinc-300 hover:bg-zinc-700 transition-colors"
        >
          {t("Download Nexus.lua")}
        </button>
        <button
          onClick={() => {
            window.open("https://github.com/niccsprojects/Roblox-Account-Manager/blob/v4/RBX%20Alt%20Manager/Nexus/NexusDocs.md");
          }}
          className="px-3 py-1.5 bg-zinc-800 border border-zinc-700/50 rounded-lg text-[11px] text-zinc-300 hover:bg-zinc-700 transition-colors"
        >
          {t("Documentation")}
        </button>
      </div>
    </div>
  );
}

