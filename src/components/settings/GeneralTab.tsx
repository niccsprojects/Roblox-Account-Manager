import { useState } from "react";
import { enable, disable } from "@tauri-apps/plugin-autostart";
import type { UseSettingsReturn } from "../../hooks/useSettings";
import { Toggle } from "../ui/Toggle";
import { NumberField } from "../ui/NumberField";
import { TextField } from "../ui/TextField";
import { Divider } from "../ui/Divider";
import { SectionLabel } from "../ui/SectionLabel";
import { WarningBadge } from "../ui/WarningBadge";
import { Select } from "../ui/Select";
import i18n, { normalizeLanguage } from "../../i18n";
import { useTr } from "../../i18n/text";
import { useStore } from "../../store";
import {
  normalizeUpdaterReleaseChannel,
  normalizeUpdaterFeatureChannel,
} from "../../updaterChannels";

export function GeneralTab({ s }: { s: UseSettingsReturn }) {
  const t = useTr();
  const store = useStore();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const restrictedBackgroundStyle = (() => {
    const style = s.get("General", "RestrictedBackgroundStyle", "warp");
    if (style === "bubbles" || style === "warp" || style === "warpLegacy" || style === "waves") {
      return style;
    }
    return "warp";
  })();
  const isWindows =
    typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("windows");
  const updaterReleaseChannel = normalizeUpdaterReleaseChannel(
    s.get("General", "UpdaterReleaseChannel", "beta")
  );
  const updaterFeatureChannel = normalizeUpdaterFeatureChannel(
    s.get("General", "UpdaterFeatureChannel", "standard")
  );

  const handleManualUpdateCheck = async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      await store.checkForUpdates(true, {
        releaseChannel: updaterReleaseChannel,
        featureChannel: updaterFeatureChannel,
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  return (
    <div className="space-y-0">
      <div className="flex items-center gap-3 py-2 px-1">
        <span className="text-[13px] text-zinc-300 shrink-0">{t("Language")}</span>
        <div className="ml-auto min-w-[180px]">
          <Select
            value={normalizeLanguage(s.get("General", "Language", "en"))}
            options={[
              { value: "en", label: "English" },
              { value: "de", label: "German" },
            ]}
            onChange={(value) => {
              const next = normalizeLanguage(value);
              s.set("General", "Language", next);
              void i18n.changeLanguage(next);
            }}
          />
        </div>
      </div>

      <Divider />

      <Toggle
        checked={s.getBool("General", "CheckForUpdates")}
        onChange={(v) => s.setBool("General", "CheckForUpdates", v)}
        label="Auto Check for Updates"
        description="Automatically check for new versions on launch"
      />

      <div className="flex items-center gap-3 py-2 px-1">
        <div className="min-w-0">
          <div className="text-[13px] text-zinc-300">{t("Update Release Channel")}</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {t("Pick which release stream is used by the updater")}
          </div>
        </div>
        <div className="ml-auto min-w-[180px]">
          <Select
            value={updaterReleaseChannel}
            options={[
              { value: "beta", label: "Beta" },
              { value: "stable", label: "Stable" },
            ]}
            onChange={(value) =>
              s.set("General", "UpdaterReleaseChannel", normalizeUpdaterReleaseChannel(value))
            }
          />
        </div>
      </div>

      <div className="flex items-center gap-3 py-2 px-1">
        <div className="min-w-0">
          <div className="text-[13px] text-zinc-300">{t("Update Feature Channel")}</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {t("Choose whether updates use the standard or Nexus/WebServer build")}
          </div>
        </div>
        <div className="ml-auto min-w-[220px]">
          <Select
            value={updaterFeatureChannel}
            options={[
              { value: "standard", label: "Standard (Non-Nexus/WebServer)" },
              { value: "nexus-ws", label: "Nexus + WebServer" },
            ]}
            onChange={(value) =>
              s.set("General", "UpdaterFeatureChannel", normalizeUpdaterFeatureChannel(value))
            }
          />
        </div>
      </div>

      <div className="px-1 py-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[13px] text-zinc-200">{t("Manual Update Check")}</div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {t("Run an update check immediately")}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void handleManualUpdateCheck();
            }}
            disabled={checkingUpdate}
            className="shrink-0 rounded-lg border border-zinc-700/70 bg-zinc-800 px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checkingUpdate ? t("Checking...") : t("Check Now")}
          </button>
        </div>
      </div>

      <div className="px-1 py-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-2">
          <div className="min-w-0">
            <div className="text-[13px] text-zinc-200">{t("First-Time Walkthrough")}</div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {t("Replay the guided setup tour with launch and safety essentials")}
            </div>
          </div>
          <button
            type="button"
            onClick={store.openFirstRunWalkthroughFromSettings}
            className="shrink-0 rounded-lg border border-zinc-700/70 bg-zinc-800 px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
          >
            {t("Open Walkthrough")}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 py-2 px-1">
        <div className="min-w-0">
          <div className="text-[13px] text-zinc-300">{t("Restricted Screen Style")}</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            {t("Choose the animated background used on the password screen")}
          </div>
        </div>
        <div className="ml-auto min-w-[220px]">
          <Select
            value={restrictedBackgroundStyle}
            options={[
              { value: "warp", label: t("Fluid Warp") },
              { value: "warpLegacy", label: t("Fluid Warp Legacy") },
              { value: "waves", label: t("Waves & Lines") },
              { value: "bubbles", label: t("Fluid Bubbles") },
            ]}
            onChange={(value) => {
              s.set(
                "General",
                "RestrictedBackgroundStyle",
                value === "bubbles" || value === "warp" || value === "warpLegacy" || value === "waves" ? value : "warp"
              );
            }}
          />
        </div>
      </div>

      {isWindows && (
        <Toggle
          checked={s.getBool("General", "ThemeWindowsNavbar")}
          onChange={(v) => s.setBool("General", "ThemeWindowsNavbar", v)}
          label="Theme Windows window navbar"
          description="Makes the top window navbar follow your active RAM theme"
        />
      )}

      <Toggle
        checked={s.getBool("General", "AsyncJoin")}
        onChange={(v) => s.setBool("General", "AsyncJoin", v)}
        label="Async Launching"
        description="Wait for each account to launch before launching the next"
      />
      <NumberField
        value={s.getNumber("General", "AccountJoinDelay", 8)}
        onChange={(v) => s.setNumber("General", "AccountJoinDelay", v)}
        label="Account Join Delay"
        min={0}
        max={60}
        step={0.5}
        suffix="sec"
      />
      <Toggle
        checked={s.getBool("General", "DisableAgingAlert")}
        onChange={(v) => s.setBool("General", "DisableAgingAlert", v)}
        label="Disable Aging Alert"
        description="Hide the freshness dots on accounts unused for 20+ days"
      />
      <Toggle
        checked={s.getBool("General", "DisableImages")}
        onChange={(v) => s.setBool("General", "DisableImages", v)}
        label="Disable Image Loading"
        description="Reduces memory usage by skipping avatar thumbnails"
      />

      <Divider />
      <SectionLabel>Login Browser</SectionLabel>
      <Toggle
        checked={s.get("Login", "PersistentProfile", "true") !== "false"}
        onChange={(v) => s.setBool("Login", "PersistentProfile", v)}
        label="Persistent login profile"
        description="Reuse the login browser profile so the device builds trust over time, which cuts down on login captchas. Only the Roblox sign-in cookie is cleared before each login"
      />
      <Toggle
        checked={s.get("Login", "StealthMode", "true") !== "false"}
        onChange={(v) => s.setBool("Login", "StealthMode", v)}
        label="Reduce automation signals"
        description="Hide browser automation flags Roblox can detect during login. Helps lower captcha prompts"
      />

      <Divider />
      <SectionLabel>Hidden Names</SectionLabel>

      <NumberField
        value={s.getNumber("General", "HiddenNameLetters", 0)}
        onChange={(v) => s.setNumber("General", "HiddenNameLetters", v)}
        label="Preview Letters"
        min={0}
        max={20}
        suffix="chars"
      />
      <Toggle
        checked={s.getBool("General", "ShowAvatarsWhenHidden")}
        onChange={(v) => s.setBool("General", "ShowAvatarsWhenHidden", v)}
        label="Show Avatars When Hidden"
        description="Display profile pictures even when names are hidden"
      />
      <Toggle
        checked={s.getBool("General", "HideRobuxWhenHidden")}
        onChange={(v) => s.setBool("General", "HideRobuxWhenHidden", v)}
        label="Hide Robux When Hidden"
        description="Mask the Robux balance in the sidebar when names are hidden"
      />

      <Divider />

      <Toggle
        checked={s.getBool("General", "EnableMultiRbx")}
        onChange={(v) => s.setBool("General", "EnableMultiRbx", v)}
        label={<>Multi Roblox<WarningBadge>use at own risk</WarningBadge></>}
        description="Allow multiple Roblox instances to run simultaneously"
      />
      <Toggle
        checked={s.getBool("General", "BottingEnabled")}
        onChange={(v) => s.setBool("General", "BottingEnabled", v)}
        label={<>Botting Mode<WarningBadge>advanced</WarningBadge></>}
        description="Enable account cycling tools to keep selected alts rejoining automatically"
      />
      <Toggle
        checked={s.getBool("General", "ShowPresence")}
        onChange={(v) => s.setBool("General", "ShowPresence", v)}
        label="Show Presence"
        description="Display online status for accounts in the list"
      />
      <Toggle
        checked={s.get("General", "WarnOnOnlineJoin", "true") === "true"}
        onChange={(v) => s.setBool("General", "WarnOnOnlineJoin", v)}
        label="Warn Before Joining Online Accounts"
        description="Show a confirmation if selected accounts are already online/in-game"
      />
      <Toggle
        checked={s.getBool("General", "AutoCookieRefresh")}
        onChange={(v) => s.setBool("General", "AutoCookieRefresh", v)}
        label="Auto Cookie Refresh"
        description="Periodically refresh account cookies to prevent expiration"
      />
      <Toggle
        checked={s.getBool("General", "StartOnPCStartup")}
        onChange={(v) => {
          s.setBool("General", "StartOnPCStartup", v);
          (v ? enable() : disable()).catch(() => {});
        }}
        label="Run on Windows Startup"
      />
      <Toggle
        checked={s.getBool("General", "MinimizeToTray")}
        onChange={(v) => s.setBool("General", "MinimizeToTray", v)}
        label="Minimize to Tray"
        description="Close button hides to system tray instead of exiting"
      />

      <Divider />

      <NumberField
        value={s.getNumber("General", "MaxRecentGames", 8)}
        onChange={(v) => s.setNumber("General", "MaxRecentGames", v)}
        label="Max Recent Games"
        min={1}
        max={30}
      />
      <TextField
        value={s.get("General", "ServerRegionFormat", "<city>, <countryCode>")}
        onChange={(v) => s.set("General", "ServerRegionFormat", v)}
        label="Region Format"
        placeholder="<city>, <countryCode>"
      />
    </div>
  );
}
