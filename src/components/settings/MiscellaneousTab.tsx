import type { UseSettingsReturn } from "../../hooks/useSettings";
import { Toggle } from "../ui/Toggle";
import { NumberField } from "../ui/NumberField";
import { Divider } from "../ui/Divider";
import { SectionLabel } from "../ui/SectionLabel";
import { useTr } from "../../i18n/text";

export function MiscellaneousTab({
  s,
  onRequestEncryptionSetup,
}: {
  s: UseSettingsReturn;
  onRequestEncryptionSetup?: () => void;
}) {
  const t = useTr();

  return (
    <div className="space-y-0">
      <Toggle
        checked={s.getBool("General", "BottingAutoShareLaunchFields")}
        onChange={(v) => s.setBool("General", "BottingAutoShareLaunchFields", v)}
        label="Auto-share launch fields with Sidebar"
        description="Keeps Place ID, Job ID, and JoinData synced between Sidebar and Botting Mode"
      />
      <Toggle
        checked={s.get("General", "BottingDualPanelDialog", "true") === "true"}
        onChange={(v) => s.setBool("General", "BottingDualPanelDialog", v)}
        label="Use dual-panel Botting dialog"
        description="Shows setup and live cycle side-by-side with a 1/3 + 2/3 layout"
      />

      <Divider />
      <SectionLabel>Shuffle</SectionLabel>

      <Toggle
        checked={s.getBool("General", "ShuffleJobId")}
        onChange={(v) => s.setBool("General", "ShuffleJobId", v)}
        label="Shuffle Job ID"
        description="Randomize which server instance to join"
      />

      <Divider />
      <SectionLabel>Other</SectionLabel>

      <Toggle
        checked={s.getBool("General", "AutoCloseLastProcess")}
        onChange={(v) => s.setBool("General", "AutoCloseLastProcess", v)}
        label="Auto Close Last Process"
        description="Close the previous Roblox instance when launching a new one for the same account"
      />
      <Toggle
        checked={s.getBool("General", "AutoCloseRobloxForMultiRbx")}
        onChange={(v) => s.setBool("General", "AutoCloseRobloxForMultiRbx", v)}
        label="Auto Close Roblox for Multi Roblox"
        description="If Multi Roblox cannot be enabled, close open Roblox windows automatically and continue"
      />
      <NumberField
        value={s.getNumber("General", "PresenceUpdateRate", 5)}
        onChange={(v) => s.setNumber("General", "PresenceUpdateRate", v)}
        label="Presence Refresh"
        min={1}
        max={9999}
        suffix="min"
      />

      <Divider />
      <SectionLabel>Security</SectionLabel>
      <div className="flex items-center justify-between gap-3 py-2 px-1 rounded-lg border border-zinc-800/70 bg-zinc-900/35">
        <div className="min-w-0">
          <div className="text-[13px] text-zinc-200">{t("Change Encryption Method")}</div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {t("Re-encrypts your current AccountData.json with the selected method.")}
          </div>
        </div>
        <button
          type="button"
          onClick={onRequestEncryptionSetup}
          className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/70 text-[12px] text-zinc-200 font-medium transition-colors"
        >
          {t("Open")}
        </button>
      </div>
    </div>
  );
}
