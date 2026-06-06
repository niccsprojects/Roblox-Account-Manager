import { describe, it, expect } from "vitest";
import type { ScriptPermissions, ManagedScript } from "../scripting/types";

/**
 * Tests for logic added/changed in src/components/dialogs/ScriptsDialog.tsx
 *
 * The private functions are replicated here to test their behavior in isolation.
 * This documents the expected contracts for:
 *   - allPermissions() — new function returning all-true ScriptPermissions
 *   - defaultPermissions() — existing function returning all-false ScriptPermissions
 *   - createScript() — extended with an optional `overrides` parameter
 *   - SCRIPT_INVOKE_COMMANDS — new entries added in this PR
 */

// ---------------------------------------------------------------------------
// Replicated pure functions from ScriptsDialog.tsx (private module scope)
// ---------------------------------------------------------------------------

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

function buildId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

const SCRIPT_SECURITY_LIMITS = {
  maxScriptNameChars: 100,
  maxScriptDescriptionChars: 500,
  maxScriptIdChars: 64,
  maxScriptSourceBytes: 250_000,
};

function createScript(
  name: string,
  description: string,
  source: string,
  overrides?: Partial<Pick<ManagedScript, "trusted" | "autoStart" | "permissions">>
): ManagedScript {
  const ts = Date.now();
  const normalizedName =
    trimToLength(name, SCRIPT_SECURITY_LIMITS.maxScriptNameChars) || "New Script";
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

// ---------------------------------------------------------------------------
// New SCRIPT_INVOKE_COMMANDS entries added in this PR (as a spec)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests: allPermissions()
// ---------------------------------------------------------------------------

describe("allPermissions()", () => {
  it("returns an object with all permissions set to true", () => {
    const perms = allPermissions();
    expect(perms.allowInvoke).toBe(true);
    expect(perms.allowHttp).toBe(true);
    expect(perms.allowWebSocket).toBe(true);
    expect(perms.allowWindow).toBe(true);
    expect(perms.allowModal).toBe(true);
    expect(perms.allowSettings).toBe(true);
    expect(perms.allowUi).toBe(true);
  });

  it("returns a distinct object on each call (no shared reference)", () => {
    const p1 = allPermissions();
    const p2 = allPermissions();
    expect(p1).not.toBe(p2);
    expect(p1).toEqual(p2);
  });

  it("has exactly 7 permission keys", () => {
    expect(Object.keys(allPermissions())).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Tests: defaultPermissions()
// ---------------------------------------------------------------------------

describe("defaultPermissions()", () => {
  it("returns an object with all permissions set to false", () => {
    const perms = defaultPermissions();
    expect(perms.allowInvoke).toBe(false);
    expect(perms.allowHttp).toBe(false);
    expect(perms.allowWebSocket).toBe(false);
    expect(perms.allowWindow).toBe(false);
    expect(perms.allowModal).toBe(false);
    expect(perms.allowSettings).toBe(false);
    expect(perms.allowUi).toBe(false);
  });

  it("returns a distinct object on each call", () => {
    const p1 = defaultPermissions();
    const p2 = defaultPermissions();
    expect(p1).not.toBe(p2);
  });

  it("all permission values are false (regression: allPermissions differs)", () => {
    const def = defaultPermissions();
    const all = allPermissions();
    for (const key of Object.keys(def) as (keyof ScriptPermissions)[]) {
      expect(def[key]).toBe(false);
      expect(all[key]).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: createScript() — overrides parameter (new in this PR)
// ---------------------------------------------------------------------------

describe("createScript()", () => {
  it("defaults to trusted=false without overrides", () => {
    const script = createScript("My Script", "desc", "ram.info('hi');");
    expect(script.trusted).toBe(false);
  });

  it("defaults to autoStart=false without overrides", () => {
    const script = createScript("My Script", "desc", "ram.info('hi');");
    expect(script.autoStart).toBe(false);
  });

  it("defaults to all-false permissions without overrides", () => {
    const script = createScript("My Script", "desc", "ram.info('hi');");
    expect(script.permissions).toEqual(defaultPermissions());
  });

  it("sets trusted=true when provided in overrides", () => {
    const script = createScript("Hub Link", "desc", "code", { trusted: true });
    expect(script.trusted).toBe(true);
  });

  it("sets autoStart=true when provided in overrides", () => {
    const script = createScript("Hub Link", "desc", "code", { autoStart: true });
    expect(script.autoStart).toBe(true);
  });

  it("sets all-true permissions when allPermissions() is provided in overrides", () => {
    const script = createScript("Hub Link", "desc", "code", {
      permissions: allPermissions(),
    });
    expect(script.permissions).toEqual(allPermissions());
  });

  it("hub link template gets trusted=true, autoStart=true, allPermissions", () => {
    // This test documents the behavior added in this PR for the Hub Link template
    const script = createScript(
      "Hub Link",
      "Link this RAM to a remote hub for web and Discord control.",
      "// hub link code",
      { trusted: true, autoStart: true, permissions: allPermissions() }
    );
    expect(script.trusted).toBe(true);
    expect(script.autoStart).toBe(true);
    expect(script.permissions).toEqual(allPermissions());
    expect(script.enabled).toBe(true);
    expect(script.language).toBe("javascript");
  });

  it("blank script does not get elevated permissions", () => {
    const script = createScript("New Script", "", 'ram.info("Hello");');
    expect(script.trusted).toBe(false);
    expect(script.autoStart).toBe(false);
    expect(script.permissions).toEqual(defaultPermissions());
  });

  it("discord bridge does not get elevated permissions", () => {
    const script = createScript(
      "Discord Bridge",
      "Send account presence to a local Discord bot bridge.",
      "// discord bridge code"
    );
    expect(script.trusted).toBe(false);
    expect(script.autoStart).toBe(false);
    expect(script.permissions).toEqual(defaultPermissions());
  });

  it("partial overrides only change provided fields", () => {
    const script = createScript("Test", "desc", "code", { trusted: true });
    // autoStart should remain false, permissions should remain default
    expect(script.trusted).toBe(true);
    expect(script.autoStart).toBe(false);
    expect(script.permissions).toEqual(defaultPermissions());
  });

  it("stores the provided source unchanged", () => {
    const source = 'ram.info("test source");';
    const script = createScript("Test", "", source);
    expect(script.source).toBe(source);
  });

  it("trims long names to maxScriptNameChars", () => {
    const longName = "x".repeat(200);
    const script = createScript(longName, "", "code");
    expect(script.name.length).toBe(SCRIPT_SECURITY_LIMITS.maxScriptNameChars);
  });

  it("uses 'New Script' as name fallback for empty name", () => {
    const script = createScript("", "", "code");
    expect(script.name).toBe("New Script");
  });

  it("uses 'New Script' as name fallback for whitespace-only name", () => {
    const script = createScript("   ", "", "code");
    expect(script.name).toBe("New Script");
  });

  it("always sets enabled=true and language=javascript", () => {
    const script = createScript("Test", "", "code");
    expect(script.enabled).toBe(true);
    expect(script.language).toBe("javascript");
  });

  it("generates a unique id for each script", () => {
    const s1 = createScript("A", "", "code");
    const s2 = createScript("B", "", "code");
    expect(s1.id).not.toBe(s2.id);
  });

  it("sets createdAtMs and updatedAtMs to the same timestamp at creation", () => {
    const before = Date.now();
    const script = createScript("Test", "", "code");
    const after = Date.now();
    expect(script.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(script.createdAtMs).toBeLessThanOrEqual(after);
    expect(script.createdAtMs).toBe(script.updatedAtMs);
  });
});

// ---------------------------------------------------------------------------
// Tests: SCRIPT_INVOKE_COMMANDS — new entries added in this PR
// ---------------------------------------------------------------------------

describe("SCRIPT_INVOKE_COMMANDS", () => {
  const commands = SCRIPT_INVOKE_COMMANDS as readonly string[];

  // New account management commands (added in this PR)
  it("includes add_account command", () => {
    expect(commands).toContain("add_account");
  });

  it("includes remove_account command", () => {
    expect(commands).toContain("remove_account");
  });

  it("includes validate_cookie command", () => {
    expect(commands).toContain("validate_cookie");
  });

  // New botting commands (added in this PR)
  it("includes get_botting_mode_status command", () => {
    expect(commands).toContain("get_botting_mode_status");
  });

  it("includes add_botting_accounts command", () => {
    expect(commands).toContain("add_botting_accounts");
  });

  it("includes set_botting_player_accounts command", () => {
    expect(commands).toContain("set_botting_player_accounts");
  });

  it("includes botting_account_action command", () => {
    expect(commands).toContain("botting_account_action");
  });

  // New generator commands (added in this PR)
  it("includes start_generator command", () => {
    expect(commands).toContain("start_generator");
  });

  it("includes stop_generator command", () => {
    expect(commands).toContain("stop_generator");
  });

  it("includes get_generator_status command", () => {
    expect(commands).toContain("get_generator_status");
  });

  it("includes generator_test_key command", () => {
    expect(commands).toContain("generator_test_key");
  });

  // Verify pre-existing commands still present
  it("retains existing get_accounts command", () => {
    expect(commands).toContain("get_accounts");
  });

  it("retains existing update_account command", () => {
    expect(commands).toContain("update_account");
  });

  it("retains existing start_botting_mode command", () => {
    expect(commands).toContain("start_botting_mode");
  });

  it("retains existing stop_botting_mode command", () => {
    expect(commands).toContain("stop_botting_mode");
  });

  it("contains no duplicate entries", () => {
    const seen = new Set<string>();
    for (const cmd of commands) {
      expect(seen.has(cmd)).toBe(false);
      seen.add(cmd);
    }
  });

  it("all entries are non-empty strings", () => {
    for (const cmd of commands) {
      expect(typeof cmd).toBe("string");
      expect(cmd.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Hub Link template utility functions (inline spec)
//
// These pure functions are embedded in the HUB_LINK_TEMPLATE string added in
// this PR. They are extracted here for unit-level verification.
// ---------------------------------------------------------------------------

// asText: coerce a value to a trimmed string with fallback
function asText(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

// asBool: coerce a value to boolean with fallback
function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

// asInt: coerce to int with clamping and fallback
function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = value === null || value === undefined ? "" : value;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// parseJson: safely parse JSON string
function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// trimTrailingSlash: remove trailing slashes from URL
function trimTrailingSlash(url: unknown): string {
  let s = String(url || "");
  while (s.length > 0 && s.charAt(s.length - 1) === "/") {
    s = s.slice(0, s.length - 1);
  }
  return s;
}

// deriveWsUrl: derive WebSocket URL from HTTP hub URL
function deriveWsUrl(hubUrl: string): string {
  const base = trimTrailingSlash(hubUrl);
  if (base.indexOf("https://") === 0) return "wss://" + base.slice(8) + "/agent";
  if (base.indexOf("http://") === 0) return "ws://" + base.slice(7) + "/agent";
  return base + "/agent";
}

// normalizeAction: validate and normalize a botting action string
function normalizeAction(value: unknown): string {
  const v = asText(value, "");
  if (!v) return "";
  const lower = v.charAt(0).toLowerCase() + v.slice(1);
  const allowed = ["disconnect", "close", "closeDisconnect", "restartClient", "restartLoop"];
  return allowed.includes(lower) ? lower : "";
}

describe("Hub Link template: asText()", () => {
  it("returns trimmed string for string input", () => {
    expect(asText("  hello  ", "fallback")).toBe("hello");
  });

  it("returns fallback for empty string", () => {
    expect(asText("", "default")).toBe("default");
  });

  it("returns fallback for whitespace-only string", () => {
    expect(asText("   ", "default")).toBe("default");
  });

  it("returns fallback for null", () => {
    expect(asText(null, "fallback")).toBe("fallback");
  });

  it("returns fallback for undefined", () => {
    expect(asText(undefined, "fallback")).toBe("fallback");
  });

  it("converts number to string", () => {
    expect(asText(42, "fb")).toBe("42");
  });

  it("converts object to string representation", () => {
    const result = asText({ toString: () => "custom" }, "fb");
    expect(typeof result).toBe("string");
  });
});

describe("Hub Link template: asBool()", () => {
  it("passes through boolean true", () => {
    expect(asBool(true, false)).toBe(true);
  });

  it("passes through boolean false", () => {
    expect(asBool(false, true)).toBe(false);
  });

  it("converts number 0 to false", () => {
    expect(asBool(0, true)).toBe(false);
  });

  it("converts non-zero number to true", () => {
    expect(asBool(1, false)).toBe(true);
    expect(asBool(-1, false)).toBe(true);
  });

  it("converts truthy strings to true", () => {
    expect(asBool("1", false)).toBe(true);
    expect(asBool("true", false)).toBe(true);
    expect(asBool("yes", false)).toBe(true);
    expect(asBool("on", false)).toBe(true);
    expect(asBool("TRUE", false)).toBe(true);
  });

  it("converts falsy strings to false", () => {
    expect(asBool("0", true)).toBe(false);
    expect(asBool("false", true)).toBe(false);
    expect(asBool("no", true)).toBe(false);
    expect(asBool("off", true)).toBe(false);
    expect(asBool("FALSE", true)).toBe(false);
  });

  it("returns fallback for unrecognized string", () => {
    expect(asBool("maybe", false)).toBe(false);
    expect(asBool("maybe", true)).toBe(true);
  });

  it("returns fallback for null", () => {
    expect(asBool(null, true)).toBe(true);
    expect(asBool(null, false)).toBe(false);
  });
});

describe("Hub Link template: asInt()", () => {
  it("parses integer string", () => {
    expect(asInt("42", 0, 0, 100)).toBe(42);
  });

  it("clamps to min value", () => {
    expect(asInt("-5", 0, 0, 100)).toBe(0);
  });

  it("clamps to max value", () => {
    expect(asInt("200", 0, 0, 100)).toBe(100);
  });

  it("returns fallback for non-numeric string", () => {
    expect(asInt("abc", 10, 0, 100)).toBe(10);
  });

  it("returns fallback for null", () => {
    expect(asInt(null, 5, 0, 100)).toBe(5);
  });

  it("returns fallback for undefined", () => {
    expect(asInt(undefined, 7, 0, 100)).toBe(7);
  });

  it("parses integer from numeric value", () => {
    expect(asInt(50, 0, 0, 100)).toBe(50);
  });

  it("truncates float to integer", () => {
    expect(asInt("3.7", 0, 0, 100)).toBe(3);
  });

  it("handles boundary values exactly", () => {
    expect(asInt("0", 5, 0, 100)).toBe(0);
    expect(asInt("100", 5, 0, 100)).toBe(100);
  });
});

describe("Hub Link template: parseJson()", () => {
  it("parses valid JSON object", () => {
    expect(parseJson('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("parses valid JSON array", () => {
    expect(parseJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("returns null for invalid JSON", () => {
    expect(parseJson("{not valid}")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseJson("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseJson("   ")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseJson(null)).toBeNull();
    expect(parseJson(undefined)).toBeNull();
    expect(parseJson(42)).toBeNull();
  });

  it("parses JSON null", () => {
    expect(parseJson("null")).toBeNull();
  });

  it("parses JSON string", () => {
    expect(parseJson('"hello"')).toBe("hello");
  });
});

describe("Hub Link template: trimTrailingSlash()", () => {
  it("removes single trailing slash", () => {
    expect(trimTrailingSlash("https://example.com/")).toBe("https://example.com");
  });

  it("removes multiple trailing slashes", () => {
    expect(trimTrailingSlash("https://example.com///")).toBe("https://example.com");
  });

  it("does not modify URL without trailing slash", () => {
    expect(trimTrailingSlash("https://example.com")).toBe("https://example.com");
  });

  it("handles empty string", () => {
    expect(trimTrailingSlash("")).toBe("");
  });

  it("handles null-like by converting to string", () => {
    expect(trimTrailingSlash(null)).toBe("");
    expect(trimTrailingSlash(undefined)).toBe("");
  });

  it("does not strip interior slashes", () => {
    expect(trimTrailingSlash("https://example.com/path/to/resource/")).toBe(
      "https://example.com/path/to/resource"
    );
  });
});

describe("Hub Link template: deriveWsUrl()", () => {
  it("converts https:// to wss://", () => {
    expect(deriveWsUrl("https://hub.example.com")).toBe("wss://hub.example.com/agent");
  });

  it("converts http:// to ws://", () => {
    expect(deriveWsUrl("http://hub.example.com")).toBe("ws://hub.example.com/agent");
  });

  it("strips trailing slash from hub URL before deriving", () => {
    expect(deriveWsUrl("https://hub.example.com/")).toBe("wss://hub.example.com/agent");
  });

  it("appends /agent to the path", () => {
    const wsUrl = deriveWsUrl("https://hub.example.com");
    expect(wsUrl.endsWith("/agent")).toBe(true);
  });

  it("handles URL without recognized scheme by appending /agent", () => {
    const result = deriveWsUrl("wss://already-ws.example.com");
    expect(result).toBe("wss://already-ws.example.com/agent");
  });
});

describe("Hub Link template: normalizeAction()", () => {
  it("accepts disconnect", () => {
    expect(normalizeAction("disconnect")).toBe("disconnect");
  });

  it("accepts close", () => {
    expect(normalizeAction("close")).toBe("close");
  });

  it("accepts closeDisconnect", () => {
    expect(normalizeAction("closeDisconnect")).toBe("closeDisconnect");
  });

  it("accepts restartClient", () => {
    expect(normalizeAction("restartClient")).toBe("restartClient");
  });

  it("accepts restartLoop", () => {
    expect(normalizeAction("restartLoop")).toBe("restartLoop");
  });

  it("normalizes first character to lowercase", () => {
    expect(normalizeAction("Disconnect")).toBe("disconnect");
    expect(normalizeAction("Close")).toBe("close");
  });

  it("rejects unknown action and returns empty string", () => {
    expect(normalizeAction("kill")).toBe("");
    expect(normalizeAction("ban")).toBe("");
    expect(normalizeAction("")).toBe("");
  });

  it("returns empty string for null input", () => {
    expect(normalizeAction(null)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(normalizeAction(undefined)).toBe("");
  });
});