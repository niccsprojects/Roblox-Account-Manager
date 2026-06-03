import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UseSettingsReturn } from "../../hooks/useSettings";
import { Toggle } from "../ui/Toggle";
import { Select } from "../ui/Select";
import { NumberField } from "../ui/NumberField";
import { Divider } from "../ui/Divider";
import { SectionLabel } from "../ui/SectionLabel";
import { useTr } from "../../i18n/text";
import { useStore } from "../../store";
import { Package } from "lucide-react";

interface VersionEntry {
  channel: string;
  versionHash: string;
  installPath: string;
  displayVersion: string | null;
  userLabel: string | null;
}

function shortHash(hash: string): string {
  return hash.startsWith("version-") ? hash.slice(8, 16) : hash.slice(0, 8);
}

export function VersionsTab({ s }: { s: UseSettingsReturn }) {
  const t = useTr();
  const store = useStore();
  const [installed, setInstalled] = useState<VersionEntry[]>([]);
  const defaultVersion = s.get("Versions", "DefaultVersion", "");

  async function refresh() {
    try {
      const list = await invoke<VersionEntry[]>("versions_list_installed");
      setInstalled(list);
    } catch {
    }
  }

  useEffect(() => {
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

  const options = [
    { value: "", label: t("Roblox official install") },
    ...installed.map((v) => ({
      value: `${v.channel}:${v.versionHash}`,
      label:
        v.userLabel ?? `${v.channel} · ${v.displayVersion ?? shortHash(v.versionHash)}`,
    })),
  ];

  return (
    <div className="space-y-0">
      <SectionLabel>Default Roblox version</SectionLabel>
      <div className="px-1 -mt-1 mb-2">
        <span className="text-[11px] text-zinc-500">
          {t(
            "Launch every account with this version unless an account has its own override. Pick 'Roblox official install' to use the version Roblox installs itself."
          )}
        </span>
      </div>
      <div className="flex items-center gap-3 py-2 px-1">
        <span className="text-[13px] text-zinc-300 shrink-0">{t("Default")}</span>
        <Select
          value={defaultVersion}
          options={options}
          onChange={(v) => {
            void invoke("versions_set_default", { versionId: v || null }).then(() =>
              s.load()
            );
          }}
          className="ml-auto w-72"
        />
      </div>
      <div className="px-1 py-2">
        <button
          onClick={() => store.setVersionsDialogOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-700/70 bg-zinc-800 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
        >
          <Package size={13} strokeWidth={1.5} />
          {t("Manage installed versions")}
        </button>
      </div>

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
