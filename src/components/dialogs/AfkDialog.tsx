import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../store";
import { useModalClose } from "../../hooks/useModalClose";
import { useTr } from "../../i18n/text";
import { Select } from "../ui/Select";
import { NumericInput } from "../ui/NumericInput";
import { X, Send } from "lucide-react";

interface AfkDialogProps {
  open: boolean;
  onClose: () => void;
}

const KEY_OPTIONS = ["Space", "W", "A", "S", "D", "E", "F", "R", "Q", "1", "2", "3", "4", "5"].map(
  (key) => ({ value: key, label: key })
);

function formatCountdown(targetMs: number | null, nowMs: number): string {
  if (targetMs === null) return "--";
  if (targetMs <= nowMs) return "0:00";
  const secs = Math.ceil((targetMs - nowMs) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AfkDialog({ open, onClose }: AfkDialogProps) {
  const t = useTr();
  const store = useStore();
  const { visible, closing, handleClose } = useModalClose(open, onClose);
  const status = store.afkStatus;
  const running = status?.active === true;

  const [intervalMinutes, setIntervalMinutes] = useState(10);
  const [key, setKey] = useState("Space");
  const [interWindowDelayMs, setInterWindowDelayMs] = useState(250);
  const [busy, setBusy] = useState(false);
  const [sendingNow, setSendingNow] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const all = await invoke<Record<string, Record<string, string>>>("get_all_settings");
        if (cancelled) return;
        const afk = all.Afk || {};
        setIntervalMinutes(parseInt(afk.IntervalMinutes || "10", 10) || 10);
        setKey(afk.Key || "Space");
        setInterWindowDelayMs(parseInt(afk.InterWindowDelayMs || "250", 10) || 250);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !running) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible, running]);

  function persist(keyName: string, value: string) {
    void invoke("update_setting", { section: "Afk", key: keyName, value }).catch(() => {});
  }

  async function handleStart() {
    setBusy(true);
    try {
      await store.startAfkMode({
        intervalSeconds: Math.max(1, intervalMinutes) * 60,
        key,
        interWindowDelayMs,
      });
    } catch {
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      await store.stopAfkMode();
    } catch {
    } finally {
      setBusy(false);
    }
  }

  async function handleSendNow() {
    setSendingNow(true);
    try {
      const hit = await invoke<number>("afk_trigger_now", {
        key,
        interWindowDelayMs,
      });
      store.addToast(
        hit > 0
          ? t("Sent {{key}} to {{count}} Roblox windows", { key, count: hit })
          : t("No open Roblox windows found")
      );
    } catch (e) {
      store.addToast(t("Error: {{error}}", { error: String(e) }));
    } finally {
      setSendingNow(false);
    }
  }

  if (!visible) return null;

  const configDisabled = running || busy;
  const countdown = formatCountdown(status?.nextCycleAtMs ?? null, nowMs);

  return (
    <div
      className={`fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm ${
        closing ? "animate-fade-out" : "animate-fade-in"
      }`}
      onClick={handleClose}
    >
      <div
        className={`theme-panel theme-border rounded-2xl border w-[460px] max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] flex flex-col overflow-hidden shadow-2xl ${
          closing ? "animate-scale-out" : "animate-scale-in"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b theme-border flex items-center justify-between">
          <div className="text-[15px] font-semibold text-[var(--panel-fg)]">{t("AFK Mode")}</div>
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-1 rounded-full text-[10px] border ${
                running
                  ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300 animate-pulse"
                  : "theme-border theme-soft theme-muted"
              }`}
            >
              {running ? t("RUNNING") : t("IDLE")}
            </span>
            <button
              onClick={handleClose}
              className="p-1 rounded-md theme-muted hover:text-[var(--panel-fg)] transition-colors"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="p-4 overflow-y-auto space-y-3">
          <section className="theme-surface rounded-xl border theme-border p-3 space-y-2.5">
            <label className="flex items-center gap-2">
              <span className="text-[11px] theme-muted w-40 shrink-0">{t("Press every")}</span>
              <NumericInput
                value={intervalMinutes}
                min={1}
                max={120}
                integer
                disabled={configDisabled}
                onChange={setIntervalMinutes}
                onCommit={(v) => persist("IntervalMinutes", String(v))}
                containerClassName="relative flex-1"
                className="sidebar-input text-xs w-full disabled:opacity-60"
              />
              <span className="text-[11px] theme-muted">{t("min")}</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-[11px] theme-muted w-40 shrink-0">{t("Key")}</span>
              <Select
                value={key}
                options={KEY_OPTIONS}
                disabled={configDisabled}
                onChange={(v) => {
                  setKey(v);
                  persist("Key", v);
                }}
                className="flex-1"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-[11px] theme-muted w-40 shrink-0">{t("Delay between windows")}</span>
              <NumericInput
                value={interWindowDelayMs}
                min={50}
                max={5000}
                integer
                disabled={configDisabled}
                onChange={setInterWindowDelayMs}
                onCommit={(v) => persist("InterWindowDelayMs", String(v))}
                containerClassName="relative flex-1"
                className="sidebar-input text-xs w-full disabled:opacity-60"
              />
              <span className="text-[11px] theme-muted">{t("ms")}</span>
            </label>
            <div className="text-[10px] theme-muted leading-4">
              {t("Each cycle briefly focuses every Roblox window to send the key, then returns to the window you were using")}
            </div>
          </section>

          {running ? (
            <section className="theme-surface rounded-xl border theme-border p-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border theme-border bg-[rgba(0,0,0,0.18)] px-2.5 py-2">
                  <div className="text-[9px] uppercase tracking-[0.08em] theme-muted">{t("Next in")}</div>
                  <div className="text-[14px] font-mono text-cyan-200 leading-tight mt-0.5">{countdown}</div>
                </div>
                <div className="rounded-lg border theme-border bg-[rgba(0,0,0,0.18)] px-2.5 py-2">
                  <div className="text-[9px] uppercase tracking-[0.08em] theme-muted">{t("Windows")}</div>
                  <div className="text-[14px] font-mono text-[var(--panel-fg)] leading-tight mt-0.5">
                    {status?.lastWindowCount ?? 0}
                  </div>
                </div>
                <div className="rounded-lg border theme-border bg-[rgba(0,0,0,0.18)] px-2.5 py-2">
                  <div className="text-[9px] uppercase tracking-[0.08em] theme-muted">{t("Cycles")}</div>
                  <div className="text-[14px] font-mono text-[var(--panel-fg)] leading-tight mt-0.5">
                    {status?.totalCycles ?? 0}
                  </div>
                </div>
              </div>
              {status?.lastError ? (
                <div className="mt-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-[11px] text-red-300 break-words">
                  {status.lastError}
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="theme-surface rounded-xl border theme-border p-3 grid grid-cols-1 gap-1.5">
            {running ? (
              <button
                onClick={handleStop}
                disabled={busy}
                className="sidebar-btn-sm text-red-200 border-red-400/40 hover:bg-red-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("Stop AFK Mode")}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={busy}
                className="sidebar-btn-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("Start AFK Mode")}
              </button>
            )}
            <button
              onClick={handleSendNow}
              disabled={sendingNow}
              className="sidebar-btn-sm flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send size={13} strokeWidth={1.75} />
              {sendingNow ? t("Sending...") : t("Send key now")}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
