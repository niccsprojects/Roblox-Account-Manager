import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UseSettingsReturn } from "../../hooks/useSettings";
import { Toggle } from "../ui/Toggle";
import { RestartBadge } from "../ui/RestartBadge";
import { useTr } from "../../i18n/text";
import { useStore } from "../../store";
import { ENABLE_WEBSERVER } from "../../featureFlags";

interface MutexDiagnosis {
  holder: "free" | "thisProcess" | "roblox" | "legacyRam" | "otherTool";
  robloxPids: number[];
  legacyRamPids: number[];
  thisProcessHolds: boolean;
}

export function DeveloperTab({ s }: { s: UseSettingsReturn }) {
  const t = useTr();
  const store = useStore();
  const [diagnosis, setDiagnosis] = useState<MutexDiagnosis | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [closingLegacy, setClosingLegacy] = useState(false);

  async function runDiagnose() {
    setDiagnosing(true);
    try {
      const result = await invoke<MutexDiagnosis>("diagnose_mutex_holder");
      setDiagnosis(result);
    } catch {
      setDiagnosis(null);
    } finally {
      setDiagnosing(false);
    }
  }

  async function closeLegacy() {
    setClosingLegacy(true);
    try {
      const killed = await invoke<number>("kill_legacy_ram_processes");
      if (killed > 0) {
        await runDiagnose();
      }
    } catch {
    } finally {
      setClosingLegacy(false);
    }
  }

  function holderLabel(d: MutexDiagnosis): string {
    switch (d.holder) {
      case "free":
        return t("Free (no process holds the mutex)");
      case "thisProcess":
        return t("This Account Manager (Multi-Roblox active)");
      case "roblox":
        return t("Running Roblox client(s): {{pids}}", {
          pids: d.robloxPids.join(", "),
        });
      case "legacyRam":
        return t("Legacy Roblox Account Manager: PID {{pids}}", {
          pids: d.legacyRamPids.join(", "),
        });
      case "otherTool":
        return t("Another program holds the Roblox singleton mutex");
    }
  }

  return (
    <div className="space-y-0">
      <Toggle
        checked={s.getBool("Developer", "DevMode")}
        onChange={(v) => s.setBool("Developer", "DevMode", v)}
        label="Enable Developer Mode"
        description="Show advanced options like auth tickets, field editing, and raw links"
      />
      {ENABLE_WEBSERVER && (
        <Toggle
          checked={s.getBool("Developer", "EnableWebServer")}
          onChange={(v) => s.setBool("Developer", "EnableWebServer", v)}
          label={
            <>
              {t("Enable Web Server")}
              <RestartBadge />
            </>
          }
          description="Start a local HTTP API for external tools and scripts"
        />
      )}

      <div className="px-1 py-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[13px] text-zinc-200">Update Modal Preview</div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              Opens a mocked release note so you can test markdown rendering
            </div>
          </div>
          <button
            type="button"
            onClick={store.openUpdatePreviewDialog}
            className="shrink-0 rounded-lg border border-zinc-700/70 bg-zinc-800 px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
          >
            Open Preview
          </button>
        </div>
      </div>

      <div className="px-1 pt-2 pb-1">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500">
          {t("Launch Diagnostics")}
        </div>
      </div>
      <div className="px-1 py-2">
        <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-3 space-y-2">
          <div className="text-[11px] text-zinc-500">
            {t(
              "Identify what is holding the Roblox singleton mutex if launches are being blocked"
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runDiagnose}
              disabled={diagnosing}
              className="rounded-lg border border-zinc-700/70 bg-zinc-800 px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-60"
            >
              {diagnosing ? t("Checking...") : t("Diagnose mutex holder")}
            </button>
            {diagnosis && diagnosis.legacyRamPids.length > 0 && (
              <button
                type="button"
                onClick={closeLegacy}
                disabled={closingLegacy}
                className="rounded-lg border border-rose-700/60 bg-rose-900/40 px-3 py-1.5 text-[12px] font-medium text-rose-200 transition-colors hover:bg-rose-900/60 disabled:opacity-60"
              >
                {closingLegacy ? t("Closing...") : t("Close legacy Account Manager")}
              </button>
            )}
          </div>
          {diagnosis && (
            <div className="rounded-md bg-zinc-950/40 px-2.5 py-2 text-[12px] text-zinc-300">
              {holderLabel(diagnosis)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
