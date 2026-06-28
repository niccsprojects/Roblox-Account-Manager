import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { UseSettingsReturn } from "../../hooks/useSettings";
import { Toggle } from "../ui/Toggle";
import { Select } from "../ui/Select";
import { NumberField } from "../ui/NumberField";
import { Divider } from "../ui/Divider";
import { SectionLabel } from "../ui/SectionLabel";
import { useTr } from "../../i18n/text";
import { useStore } from "../../store";
import { Package, FolderOpen } from "lucide-react";

interface VersionEntry {
  channel: string;
  versionHash: string;
  installPath: string;
  displayVersion: string | null;
  userLabel: string | null;
  exists: boolean;
}

function shortHash(hash: string): string {
  return hash.startsWith("version-") ? hash.slice(8, 16) : hash.slice(0, 8);
}

export function VersionsTab({ s }: { s: UseSettingsReturn }) {
  const t = useTr();
  const store = useStore();
  const [installed, setInstalled] = useState<VersionEntry[]>([]);
  const defaultVersion = s.get("Versions", "DefaultVersion", "");
  const isWindows = (store.platformCapabilities?.os ?? "windows") === "windows";
  const savedCustomPath = s.get("Versions", "CustomInstallPath", "");
  const [customPath, setCustomPath] = useState(savedCustomPath);
  const [detectedPath, setDetectedPath] = useState<string | null>(null);

  useEffect(() => {
    setCustomPath(savedCustomPath);
  }, [savedCustomPath]);

  async function refresh() {
    try {
      const list = await invoke<VersionEntry[]>("versions_list_installed");
      setInstalled(list);
    } catch {
    }
  }

  async function detectInstallPath() {
    try {
      const p = await invoke<string>("versions_detect_install_path");
      setDetectedPath(p || null);
    } catch {
      setDetectedPath(null);
    }
  }

  async function applyCustomPath(path: string | null) {
    try {
      const resolved = await invoke<string>("versions_set_custom_install_path", { path });
      await s.load();
      setCustomPath(resolved);
      void detectInstallPath();
      store.addToast(
        path
          ? t("Roblox install path set: {{path}}", { path: resolved })
          : t("Roblox install path override cleared")
      );
    } catch (e) {
      store.addToast(t("Error: {{error}}", { error: String(e) }));
    }
  }

  async function browseInstallPath() {
    const dir = await open({ directory: true, title: t("Select Roblox install folder") });
    if (typeof dir === "string") void applyCustomPath(dir);
  }

  useEffect(() => {
    if (isWindows) void detectInstallPath();
    void refresh();
    const unlisten = listen<{ stage: string }>("version-install-progress", (e) => {
      if (e.payload.stage === "ready") {
        void refresh();
      }
    });
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unlisten.then((fn) => fn());
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const validVersions = installed.filter((v) => v.exists);
  const missingCount = installed.length - validVersions.length;
  const defaultVersionValid = validVersions.some(
    (v) => `${v.channel}:${v.versionHash}` === defaultVersion
  );
  const options = [
    { value: "", label: t("Default Roblox install") },
    ...validVersions.map((v) => ({
      value: `${v.channel}:${v.versionHash}`,
      label:
        v.userLabel ?? `${v.channel} · ${v.displayVersion ?? shortHash(v.versionHash)}`,
    })),
  ];

  async function pruneMissing() {
    try {
      await invoke<number>("versions_prune_missing");
    } catch {
    }
    await refresh();
    await s.load();
  }

  return (
    <div className="space-y-0">
      <SectionLabel>Default Roblox version</SectionLabel>
      <div className="px-1 -mt-1 mb-2">
        <span className="text-[11px] text-zinc-500">
          {t(
            "Managed versions are opt-in. Leave this on 'Default Roblox install' to launch with the standard Roblox install on this PC, or pick a downloaded version to use it for every account."
          )}
        </span>
      </div>
      <div className="flex items-center gap-3 py-2 px-1">
        <span className="text-[13px] text-zinc-300 shrink-0">{t("Default")}</span>
        <Select
          value={defaultVersionValid ? defaultVersion : ""}
          options={options}
          onChange={(v) => {
            void invoke("versions_set_default", { versionId: v || null }).then(() =>
              s.load()
            );
          }}
          className="ml-auto w-72"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-1 py-2">
        <button
          onClick={() => store.setVersionsDialogOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-700/70 bg-zinc-800 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
        >
          <Package size={13} strokeWidth={1.5} />
          {t("Manage installed versions")}
        </button>
        {missingCount > 0 && (
          <button
            onClick={() => void pruneMissing()}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-700/70 bg-zinc-900/40 text-[12px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            {t("Remove {{count}} missing", { count: missingCount })}
          </button>
        )}
      </div>

      {isWindows && (
        <>
          <Divider />
          <SectionLabel>Roblox installation</SectionLabel>
          <div className="px-1 -mt-1 mb-2">
            <span className="text-[11px] text-zinc-500">
              {t(
                "Set this only if RAM can't find your Roblox automatically. Point it at the Roblox install folder (for example a version-... folder)."
              )}
            </span>
          </div>
          <div className="flex items-center gap-2 px-1 py-2">
            <input
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void applyCustomPath(customPath.trim() || null);
              }}
              placeholder={t("Auto-detected")}
              spellCheck={false}
              className="flex-1 rounded-lg border border-zinc-700/70 bg-zinc-900/50 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-zinc-500"
            />
            <button
              onClick={browseInstallPath}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700/70 bg-zinc-800 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
            >
              <FolderOpen size={13} strokeWidth={1.5} />
              {t("Browse…")}
            </button>
          </div>
          {detectedPath && (
            <div className="px-1 pb-1">
              <span className="text-[11px] text-zinc-500 break-all">
                {t("Detected: {{path}}", { path: detectedPath })}
              </span>
            </div>
          )}
          <div className="flex items-center gap-3 px-1 py-1">
            <button
              onClick={() => void detectInstallPath()}
              className="text-[11px] text-sky-400 hover:text-sky-300"
            >
              {t("Auto-detect")}
            </button>
            <button
              onClick={() => void applyCustomPath(null)}
              className="text-[11px] text-zinc-400 hover:text-zinc-200"
            >
              {t("Clear override")}
            </button>
          </div>
        </>
      )}

      <Divider />
      <SectionLabel>Downloader</SectionLabel>
      <NumberField
        value={s.getNumber("Versions", "MaxParallelDownloads", 4)}
        onChange={(v) => s.setNumber("Versions", "MaxParallelDownloads", v)}
        label="Max parallel downloads"
        min={1}
        max={8}
      />
      <Toggle
        checked={s.getBool("Versions", "ShowPreReleaseVersions")}
        onChange={(v) => s.setBool("Versions", "ShowPreReleaseVersions", v)}
        label="Show pre-release channels"
        description="Surface zlive, zcanary, and other non-LIVE channels in the catalog"
      />
      <Toggle
        checked={s.get("Versions", "PreferOldJoinForVersioned", "true") !== "false"}
        onChange={(v) => s.setBool("Versions", "PreferOldJoinForVersioned", v)}
        label="Always use direct exe launch for managed versions"
        description="Required to spawn a non-default Roblox version. Disable only for troubleshooting."
      />

      <Divider />
      <SectionLabel>Credits</SectionLabel>
      <div className="px-1 py-2">
        <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-3 text-[11px] text-zinc-400 space-y-1.5">
          <div>
            {t("Downloader logic adapted from")}{" "}
            <a
              href="https://github.com/latte-soft/rdd"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              latte-soft/rdd
            </a>
            {" "}({t("MIT, Latte Softworks")}).
          </div>
          <div>
            {t("Version metadata catalog via")}{" "}
            <a
              href="https://weao.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              weao.xyz
            </a>
            {" "}({t("WhatExpsAre.Online")}).
          </div>
        </div>
      </div>
    </div>
  );
}
