export type ScriptStatus = "idle" | "running" | "stopped" | "error";
export type ScriptLogLevel = "debug" | "info" | "warn" | "error";

export interface ScriptPermissions {
  allowInvoke: boolean;
  allowHttp: boolean;
  allowWebSocket: boolean;
  allowWindow: boolean;
  allowModal: boolean;
  allowSettings: boolean;
  allowUi: boolean;
}

export interface ManagedScript {
  id: string;
  name: string;
  description: string;
  language: string;
  source: string;
  enabled: boolean;
  trusted: boolean;
  autoStart: boolean;
  permissions: ScriptPermissions;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ScriptLogEntry {
  id: string;
  at: number;
  level: ScriptLogLevel;
  source: "script" | "host";
  message: string;
}

export type ScriptUiElementType =
  | "button"
  | "text"
  | "number"
  | "toggle"
  | "select"
  | "textarea"
  | "badge"
  | "divider";

export interface ScriptUiOption {
  label: string;
  value: string;
}

export interface ScriptUiElement {
  id: string;
  type: ScriptUiElementType;
  label?: string;
  text?: string;
  value?: string | number | boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  width?: number;
  options?: ScriptUiOption[];
  disabled?: boolean;
  tone?: "default" | "success" | "warn" | "error" | "accent";
}

export interface ScriptRuntimeState {
  status: ScriptStatus;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  lastError: string | null;
  uiElements: ScriptUiElement[];
}

export interface WorkerHostRequest {
  type: "host-request";
  requestId: string;
  action: string;
  payload: unknown;
}

export interface WorkerHostLog {
  type: "host-log";
  level: ScriptLogLevel;
  message: string;
}

export interface WorkerScriptFinished {
  type: "script-finished";
}

export interface WorkerScriptError {
  type: "script-error";
  error: string;
}

export type WorkerIncomingMessage =
  | WorkerHostRequest
  | WorkerHostLog
  | WorkerScriptFinished
  | WorkerScriptError;

export interface ScriptWindowSnapshot {
  ts: number;
  placeId: string;
  jobId: string;
  launchData: string;
  selectedUserIds: number[];
  accounts: Array<{
    userId: number;
    username: string;
    alias: string;
    group: string;
    valid: boolean;
    lastUse: string;
    lastAttemptedRefresh: string;
  }>;
  presenceByUserId: Record<string, number>;
  launchedUserIds: number[];
  botting: unknown;
  generator: unknown;
  settings: Record<string, Record<string, string>> | null;
}

export interface ScriptHttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}

export interface ScriptWebSocketConnectInput {
  url: string;
  connectionId?: string;
  protocols?: string[] | string;
  allowPrivateNetwork?: boolean;
}
