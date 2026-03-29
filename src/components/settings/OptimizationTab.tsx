import { useMemo } from "react";
import type { UseSettingsReturn } from "../../hooks/useSettings";
import { useStore } from "../../store";
import { useTr } from "../../i18n/text";
import { Divider } from "../ui/Divider";
import { NumberField } from "../ui/NumberField";
import { SectionLabel } from "../ui/SectionLabel";
import { Select } from "../ui/Select";
import { TextAreaField } from "../ui/TextAreaField";
import { TextField } from "../ui/TextField";
import { Toggle } from "../ui/Toggle";
import { WarningBadge } from "../ui/WarningBadge";

type OptimizationProfileId = "Normal" | "BottingPlayer" | "BottingBot";

function generalKey(profile: OptimizationProfileId, suffix: string): string {
  if (profile === "Normal") return suffix;
  return `${profile}${suffix}`;
}

function optimizationKey(profile: OptimizationProfileId, suffix: string): string {
  return `${profile}${suffix}`;
}

function optimizationJsonError(raw: string, enabled: boolean, t: (text: string) => string) {
  if (!enabled) return null;
  const trimmed = raw.trim();
  if (!trimmed) return t("Allowlisted fast flags JSON cannot be empty while enabled");

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return t("Allowlisted fast flags JSON must be a JSON object");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `${t("Invalid allowlisted fast flags JSON")}: ${detail}`;
  }

  return null;
}

function AppliesBadge({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-400/80">
      {text}
    </span>
  );
}

function OptimizationProfileSection({
  s,
  title,
  profile,
  isWindows,
}: {
  s: UseSettingsReturn;
  title: string;
  profile: OptimizationProfileId;
  isWindows: boolean;
}) {
  const t = useTr();
  const customClientSettings = s.get("General", generalKey(profile, "CustomClientSettings"), "").trim();
  const customClientSettingsEnabled = customClientSettings.length > 0;
  const fastFlagsEnabled = s.getBool("Optimization", optimizationKey(profile, "EnableFastFlags"));
  const fastFlagsJson = s.get("Optimization", optimizationKey(profile, "FastFlagsJson"), "");
  const fastFlagsError = useMemo(
    () => optimizationJsonError(fastFlagsJson, fastFlagsEnabled, t),
    [fastFlagsEnabled, fastFlagsJson, t]
  );
  const disableExperimentalEditor = customClientSettingsEnabled || !isWindows;

  return (
    <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/35 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>{title}</SectionLabel>
        <AppliesBadge text={t("Applies on next launch")} />
      </div>

      <div className="mt-1 text-[11px] text-zinc-500">
        {t("These settings apply only to Roblox processes launched by RAM")}
      </div>

      <Divider />
      <SectionLabel>{t("Official Roblox Client")}</SectionLabel>

      <Toggle
        checked={s.getBool("General", generalKey(profile, "UnlockFPS"))}
        onChange={(v) => {
          if (customClientSettingsEnabled) return;
          s.setBool("General", generalKey(profile, "UnlockFPS"), v);
        }}
        disabled={customClientSettingsEnabled}
        label="Unlock FPS"
        description={
          customClientSettingsEnabled
            ? "Disabled while Custom ClientAppSettings is set"
            : undefined
        }
      />
      <NumberField
        value={s.getNumber("General", generalKey(profile, "MaxFPSValue"), 120)}
        onChange={(v) => s.setNumber("General", generalKey(profile, "MaxFPSValue"), v)}
        label="Max FPS"
        min={5}
        max={9999}
      />
      <TextField
        value={s.get("General", generalKey(profile, "CustomClientSettings"), "")}
        onChange={(v) => s.set("General", generalKey(profile, "CustomClientSettings"), v)}
        label="Custom ClientSettings"
        placeholder="C:\\path\\ClientAppSettings.json"
      />
      <Toggle
        checked={s.getBool("General", generalKey(profile, "OverrideClientVolume"))}
        onChange={(v) => s.setBool("General", generalKey(profile, "OverrideClientVolume"), v)}
        label="Override Client Volume"
        description="Apply this volume level before launching Roblox"
      />
      <NumberField
        value={Math.round(s.getNumber("General", generalKey(profile, "ClientVolume"), 0.5) * 100)}
        onChange={(v) =>
          s.setNumber(
            "General",
            generalKey(profile, "ClientVolume"),
            Math.max(0, Math.min(100, v)) / 100
          )
        }
        label="Client Volume"
        min={0}
        max={100}
        suffix="%"
      />
      <Toggle
        checked={s.getBool("General", generalKey(profile, "OverrideClientGraphics"))}
        onChange={(v) => s.setBool("General", generalKey(profile, "OverrideClientGraphics"), v)}
        label="Override Graphics Level"
        description="Forces manual graphics quality at launch"
      />
      <NumberField
        value={s.getNumber("General", generalKey(profile, "ClientGraphicsLevel"), 10)}
        onChange={(v) => s.setNumber("General", generalKey(profile, "ClientGraphicsLevel"), v)}
        label="Graphics Level"
        min={1}
        max={10}
      />
      <Toggle
        checked={s.getBool("General", generalKey(profile, "OverrideClientWindowSize"))}
        onChange={(v) => s.setBool("General", generalKey(profile, "OverrideClientWindowSize"), v)}
        label="Override Window Size"
        description="Optional: start Roblox in windowed mode with this size"
      />
      <NumberField
        value={s.getNumber("General", generalKey(profile, "ClientWindowWidth"), 1280)}
        onChange={(v) => s.setNumber("General", generalKey(profile, "ClientWindowWidth"), v)}
        label="Window Width"
        min={320}
        max={7680}
      />
      <NumberField
        value={s.getNumber("General", generalKey(profile, "ClientWindowHeight"), 720)}
        onChange={(v) => s.setNumber("General", generalKey(profile, "ClientWindowHeight"), v)}
        label="Window Height"
        min={240}
        max={4320}
      />
      <Toggle
        checked={s.getBool("General", generalKey(profile, "StartRobloxMinimized"))}
        onChange={(v) => s.setBool("General", generalKey(profile, "StartRobloxMinimized"), v)}
        label="Start Roblox Minimized"
        description="Launches Roblox and minimizes the client window right after startup"
      />

      {isWindows ? (
        <>
          <Divider />
          <SectionLabel>{t("Windows Process Policy")}</SectionLabel>

          <Toggle
            checked={s.getBool("Optimization", optimizationKey(profile, "EnableProcessPolicy"))}
            onChange={(v) =>
              s.setBool("Optimization", optimizationKey(profile, "EnableProcessPolicy"), v)
            }
            label="Enable Windows process optimization"
            description="Optimization settings are applied after PID detection and before background minimization completes"
          />
          <NumberField
            value={s.getNumber("Optimization", optimizationKey(profile, "ProcessPolicyDelayMs"), 1500)}
            onChange={(v) =>
              s.setNumber(
                "Optimization",
                optimizationKey(profile, "ProcessPolicyDelayMs"),
                Math.max(0, Math.min(15000, v))
              )
            }
            label="Apply delay"
            min={0}
            max={15000}
            suffix="ms"
          />

          <div className="flex items-center gap-3 py-2 px-1">
            <div className="text-[13px] text-zinc-300">{t("Priority Class")}</div>
            <div className="ml-auto w-[170px]">
              <Select
                value={s.get("Optimization", optimizationKey(profile, "PriorityClass"), "normal")}
                onChange={(value) =>
                  s.set("Optimization", optimizationKey(profile, "PriorityClass"), value)
                }
                options={[
                  { value: "normal", label: "Normal" },
                  { value: "below_normal", label: "Below Normal" },
                  { value: "idle", label: "Idle" },
                ]}
              />
            </div>
          </div>

          <Toggle
            checked={s.getBool("Optimization", optimizationKey(profile, "BackgroundMode"))}
            onChange={(v) =>
              s.setBool("Optimization", optimizationKey(profile, "BackgroundMode"), v)
            }
            label="Background Mode"
            description="Lowers scheduling priority for off-screen or minimized Roblox clients"
          />
          <Toggle
            checked={s.getBool("Optimization", optimizationKey(profile, "EcoQos"))}
            onChange={(v) => s.setBool("Optimization", optimizationKey(profile, "EcoQos"), v)}
            label="EcoQoS"
            description="Hints Windows to favor efficiency over burst performance"
          />
          <Toggle
            checked={s.getBool("Optimization", optimizationKey(profile, "IgnoreTimerResolution"))}
            onChange={(v) =>
              s.setBool("Optimization", optimizationKey(profile, "IgnoreTimerResolution"), v)
            }
            label="Ignore Timer Resolution"
            description="Reduces timer-resolution pressure for background Roblox clients"
          />

          <div className="flex items-center gap-3 py-2 px-1">
            <div className="text-[13px] text-zinc-300">{t("Memory Priority")}</div>
            <div className="ml-auto w-[170px]">
              <Select
                value={s.get("Optimization", optimizationKey(profile, "MemoryPriority"), "normal")}
                onChange={(value) =>
                  s.set("Optimization", optimizationKey(profile, "MemoryPriority"), value)
                }
                options={[
                  { value: "normal", label: "Normal" },
                  { value: "low", label: "Low" },
                  { value: "very_low", label: "Very Low" },
                ]}
              />
            </div>
          </div>

          <Divider />
          <div className="flex items-center px-1 pt-3 pb-1">
            <SectionLabel>Experimental / Danger</SectionLabel>
            <WarningBadge>advanced</WarningBadge>
          </div>

          <div className="px-1 pt-1 text-[11px] text-amber-400/80">
            {t("These settings are experimental and may stop working after Roblox updates")}
          </div>

          <Toggle
            checked={fastFlagsEnabled}
            onChange={(v) =>
              s.setBool("Optimization", optimizationKey(profile, "EnableFastFlags"), v)
            }
            disabled={customClientSettingsEnabled}
            label="Enable allowlisted fast flags"
            description={
              customClientSettingsEnabled
                ? "Custom ClientSettings disables generated fast flags for this profile"
                : "Only Roblox allowlisted keys are accepted"
            }
          />
          <TextAreaField
            value={fastFlagsJson}
            onChange={(value) =>
              s.set("Optimization", optimizationKey(profile, "FastFlagsJson"), value)
            }
            label="Allowlisted fast flags JSON"
            placeholder='{\n  "DFFlagTextureQualityOverrideEnabled": true,\n  "DFIntTextureQualityOverride": 0\n}'
            rows={6}
            disabled={disableExperimentalEditor}
            error={disableExperimentalEditor ? null : fastFlagsError}
            description={
              customClientSettingsEnabled
                ? "Custom ClientSettings disables generated fast flags for this profile"
                : "Only Roblox allowlisted keys are accepted"
            }
          />

          <Toggle
            checked={s.getBool("Optimization", optimizationKey(profile, "EnableJobCpuLimit"))}
            onChange={(v) =>
              s.setBool("Optimization", optimizationKey(profile, "EnableJobCpuLimit"), v)
            }
            label="Enable job CPU limit"
            description="Caps this Roblox process with a per-process Windows job object"
          />
          <NumberField
            value={s.getNumber("Optimization", optimizationKey(profile, "JobCpuLimitPercent"), 25)}
            onChange={(v) =>
              s.setNumber(
                "Optimization",
                optimizationKey(profile, "JobCpuLimitPercent"),
                Math.max(5, Math.min(100, v))
              )
            }
            label="CPU limit"
            min={5}
            max={100}
            suffix="%"
          />
          <Toggle
            checked={s.getBool("Optimization", optimizationKey(profile, "EnableJobMemoryLimit"))}
            onChange={(v) =>
              s.setBool("Optimization", optimizationKey(profile, "EnableJobMemoryLimit"), v)
            }
            label="Enable job memory limit"
            description="Caps the per-process memory budget with a Windows job object"
          />
          <NumberField
            value={s.getNumber("Optimization", optimizationKey(profile, "JobMemoryLimitMb"), 2048)}
            onChange={(v) =>
              s.setNumber(
                "Optimization",
                optimizationKey(profile, "JobMemoryLimitMb"),
                Math.max(256, Math.min(32768, v))
              )
            }
            label="Process memory limit"
            min={256}
            max={32768}
            suffix="MB"
          />
        </>
      ) : (
        <>
          <Divider />
          <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 px-3 py-2 text-[12px] text-zinc-400">
            {t("Windows-only process policies are unavailable on this platform")}
          </div>
        </>
      )}
    </div>
  );
}

export function OptimizationTab({ s }: { s: UseSettingsReturn }) {
  const t = useTr();
  const store = useStore();
  const isWindows = store.platformCapabilities?.os === "windows";
  const bottingEnabled = s.getBool("General", "BottingEnabled");
  const sharedProfile = s.get("General", "BottingUseSharedClientProfile", "true") === "true";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/35 px-4 py-4">
        <SectionLabel>{t("Optimization Profiles")}</SectionLabel>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <AppliesBadge text={t("Applies on next launch")} />
          {!isWindows ? <AppliesBadge text={t("Windows only")} /> : null}
        </div>
        <div className="mt-3 text-[11px] leading-5 text-zinc-500">
          {isWindows
            ? t("These settings apply only to Roblox processes launched by RAM")
            : t("Windows-only process policies are unavailable on this platform")}
        </div>
        {bottingEnabled ? (
          <>
            <Divider />
            <Toggle
            checked={sharedProfile}
            onChange={(v) => s.setBool("General", "BottingUseSharedClientProfile", v)}
            label="Use same client settings for player and bots"
            description="Player and bot profiles inherit Normal while shared mode is enabled"
          />
          </>
        ) : null}
      </div>

      <OptimizationProfileSection
        s={s}
        title={t("Normal")}
        profile="Normal"
        isWindows={isWindows}
      />

      {bottingEnabled && !sharedProfile ? (
        <>
          <OptimizationProfileSection
            s={s}
            title={t("Botting Player")}
            profile="BottingPlayer"
            isWindows={isWindows}
          />
          <OptimizationProfileSection
            s={s}
            title={t("Botting Bot")}
            profile="BottingBot"
            isWindows={isWindows}
          />
        </>
      ) : null}
    </div>
  );
}
