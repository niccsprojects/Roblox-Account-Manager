import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UseSettingsReturn } from "../../hooks/useSettings";
import { Toggle } from "../ui/Toggle";
import { Select } from "../ui/Select";
import { Divider } from "../ui/Divider";
import { SectionLabel } from "../ui/SectionLabel";
import { WarningBadge } from "../ui/WarningBadge";
import { useTr } from "../../i18n/text";

type IsolationMode = "off" | "light" | "medium" | "full";

interface AdapterInfo {
  subkey: string;
  description: string;
  currentMac: string | null;
  netCfgInstanceId: string | null;
}

interface DryRunReport {
  paths: string[];
  registryKeys: string[];
}

const MODE_DESCRIPTIONS: Record<IsolationMode, string> = {
  off: "No cleanup before launch",
  light: "Wipe HTTP cache, logs, prefetch, temp files",
  medium: "Light + HKCU Roblox registry tree",
  full: "Medium + Roblox install Versions folders (forces reinstall)",
};

const MODE_OPTIONS: { value: IsolationMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "light", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "full", label: "Full" },
];

function modeFromSettings(value: string): IsolationMode {
  const lower = value.trim().toLowerCase();
  if (lower === "light" || lower === "medium" || lower === "full") return lower;
  return "off";
}

function modeToStored(value: IsolationMode): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function IsolationTab({ s }: { s: UseSettingsReturn }) {
  const t = useTr();
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [adaptersLoading, setAdaptersLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [dryReport, setDryReport] = useState<DryRunReport | null>(null);
  const [dryRunning, setDryRunning] = useState(false);

  const mode = modeFromSettings(s.get("Isolation", "Mode", "Off"));
  const spoofGuid = s.getBool("Isolation", "SpoofMachineGuid");
  const spoofMac = s.getBool("Isolation", "SpoofMacAddress");
  const targetAdapter = s.get("Isolation", "TargetAdapter", "");
  const includeStudio = s.getBool("Isolation", "IncludeStudio");
  const preserveFastFlags = s.get("Isolation", "PreserveFastFlags", "true") !== "false";
  const preserveBasicSettings =
    s.get("Isolation", "PreserveBasicSettings", "true") !== "false";

  const backupGuid = s.get("Isolation", "BackupMachineGuid", "");
  const backupAdapter = s.get("Isolation", "BackupAdapterId", "");
  const hasBackup = backupGuid.trim().length > 0 || backupAdapter.trim().length > 0;

  async function loadAdapters() {
    setAdaptersLoading(true);
    try {
      const list = await invoke<AdapterInfo[]>("isolation_list_adapters");
      setAdapters(list);
    } catch {
      setAdapters([]);
    } finally {
      setAdaptersLoading(false);
    }
  }

  useEffect(() => {
    if (spoofMac && adapters.length === 0 && !adaptersLoading) {
      void loadAdapters();
    }
  }, [spoofMac, adapters.length, adaptersLoading]);

  async function handleRestore() {
    setRestoring(true);
    setRestoreMessage(null);
    try {
      await invoke("isolation_restore_network_identifiers");
      setRestoreMessage({ ok: true, text: t("Original network identifiers restored") });
      await s.load();
    } catch (e) {
      setRestoreMessage({ ok: false, text: String(e) });
    } finally {
      setRestoring(false);
    }
  }

  async function handleDryRun() {
    setDryRunning(true);
    setDryReport(null);
    try {
      const report = await invoke<DryRunReport>("isolation_dry_run", {
        mode: modeToStored(mode),
        spoofMachineGuid: spoofGuid,
        spoofMac,
        targetAdapter,
        includeStudio,
        preserveFastFlags,
        preserveBasicSettings,
      });
      setDryReport(report);
    } catch (e) {
      setDryReport({
        paths: [],
        registryKeys: [String(e)],
      });
    } finally {
      setDryRunning(false);
    }
  }

  const adapterOptions = [
    { value: "", label: t("Primary active adapter") },
    ...adapters.map((a) => ({
      value: a.subkey,
      label: `${a.description}${a.currentMac ? ` (${a.currentMac})` : ""}`,
    })),
  ];

  return (
    <div className="space-y-0">
      <SectionLabel>Mode</SectionLabel>
      <div className="px-1 -mt-1 mb-2">
        <span className="text-[11px] text-zinc-500">
          {t(
            "Choose how aggressively to clean Roblox traces before each launch. Heavier modes break ban-linking more reliably but may force a Roblox reinstall."
          )}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1.5 px-1">
        {MODE_OPTIONS.map((opt) => {
          const active = mode === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => s.set("Isolation", "Mode", modeToStored(opt.value))}
              className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                active
                  ? "border-sky-500/40 bg-sky-500/10"
                  : "border-zinc-800/60 bg-zinc-900/30 hover:border-zinc-700"
              }`}
            >
              <div
                className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${
                  active ? "border-sky-400 bg-sky-400" : "border-zinc-600"
                }`}
              />
              <div className="min-w-0">
                <div className="text-[13px] text-zinc-200">{t(opt.label)}</div>
                <div className="mt-0.5 text-[11px] text-zinc-500">
                  {t(MODE_DESCRIPTIONS[opt.value])}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <Divider />
      <SectionLabel>Advanced</SectionLabel>
      <Toggle
        checked={spoofGuid}
        onChange={(v) => s.setBool("Isolation", "SpoofMachineGuid", v)}
        label={
          <>
            {t("Rotate MachineGuid")}
            <WarningBadge>Requires UAC</WarningBadge>
          </>
        }
        description="Writes a fresh GUID to HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid"
      />
      <Toggle
        checked={spoofMac}
        onChange={(v) => s.setBool("Isolation", "SpoofMacAddress", v)}
        label={
          <>
            {t("Rotate MAC address")}
            <WarningBadge>Briefly interrupts network</WarningBadge>
          </>
        }
        description="Sets NetworkAddress on the selected adapter and toggles it"
      />
      {spoofMac && (
        <div className="px-1 py-2">
          <div className="text-[11px] text-zinc-500 mb-1.5">{t("Target adapter")}</div>
          <Select
            value={targetAdapter}
            options={adapterOptions}
            onChange={(v) => s.set("Isolation", "TargetAdapter", v)}
            className="w-full"
          />
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={loadAdapters}
              disabled={adaptersLoading}
              className="text-[11px] text-sky-400 hover:text-sky-300 disabled:opacity-60"
            >
              {adaptersLoading ? t("Loading...") : t("Refresh adapter list")}
            </button>
          </div>
        </div>
      )}

      <Divider />
      <SectionLabel>Preservation</SectionLabel>
      <Toggle
        checked={preserveFastFlags}
        onChange={(v) => s.setBool("Isolation", "PreserveFastFlags", v)}
        label="Preserve fast flags"
        description="Back up ClientAppSettings.json before Full mode wipes the Versions folder"
      />
      <Toggle
        checked={preserveBasicSettings}
        onChange={(v) => s.setBool("Isolation", "PreserveBasicSettings", v)}
        label="Preserve basic settings"
        description="Back up GlobalBasicSettings_13.xml (graphics quality, volume, window size)"
      />
      <Toggle
        checked={includeStudio}
        onChange={(v) => s.setBool("Isolation", "IncludeStudio", v)}
        label="Include Roblox Studio in Full wipe"
        description="By default Studio installs are skipped to avoid forcing a Studio reinstall"
        disabled={mode !== "full"}
      />

      <Divider />
      <SectionLabel>Restore</SectionLabel>
      <div className="px-1 py-2">
        <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-3 space-y-2">
          <div className="text-[11px] text-zinc-500">
            {hasBackup
              ? t("Reverts MachineGuid and MAC address to the values captured before the first spoof")
              : t("No backups stored yet. Enable a spoof option and launch once to capture originals.")}
          </div>
          <button
            type="button"
            onClick={handleRestore}
            disabled={!hasBackup || restoring}
            className="rounded-lg border border-zinc-700/70 bg-zinc-800 px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-60"
          >
            {restoring ? t("Restoring...") : t("Restore original network identifiers")}
          </button>
          {restoreMessage && (
            <div
              className={`text-[11px] ${
                restoreMessage.ok ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {restoreMessage.text}
            </div>
          )}
        </div>
      </div>

      <Divider />
      <SectionLabel>Preview</SectionLabel>
      <div className="px-1 py-2">
        <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-3 space-y-2">
          <div className="text-[11px] text-zinc-500">
            {t("Show what would be deleted without actually deleting anything")}
          </div>
          <button
            type="button"
            onClick={handleDryRun}
            disabled={dryRunning}
            className="rounded-lg border border-zinc-700/70 bg-zinc-800 px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-60"
          >
            {dryRunning ? t("Checking...") : t("Preview what gets wiped")}
          </button>
          {dryReport && (
            <div className="space-y-1 rounded-md bg-zinc-950/50 px-2.5 py-2 text-[11px] text-zinc-400 max-h-48 overflow-y-auto font-mono">
              {dryReport.paths.length === 0 && dryReport.registryKeys.length === 0 ? (
                <div className="text-zinc-500">{t("Nothing would be removed")}</div>
              ) : (
                <>
                  {dryReport.paths.map((p, i) => (
                    <div key={`p-${i}`} className="break-all">{p}</div>
                  ))}
                  {dryReport.registryKeys.map((k, i) => (
                    <div key={`k-${i}`} className="break-all text-amber-300/80">{k}</div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <Divider />
      <SectionLabel>Credits</SectionLabel>
      <div className="px-1 py-2">
        <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-3 text-[11px] text-zinc-400 space-y-1.5">
          <div>
            {t("Cleanup and network-identifier rotation are adapted from")}{" "}
            <a
              href="https://github.com/focat69/rblxswap"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              focat69/rblxswap
            </a>
            .
          </div>
          <div>
            {t("MAC rotation technique credited to")}{" "}
            <a
              href="https://github.com/centerepic/ByeBanAsync"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              centerepic/ByeBanAsync
            </a>
            .
          </div>
        </div>
      </div>
    </div>
  );
}
