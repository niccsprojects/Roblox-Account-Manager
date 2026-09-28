import type { UseSettingsReturn } from "../../hooks/useSettings";
import { useStore, type HotkeyAction } from "../../store";
import { SectionLabel } from "../ui/SectionLabel";
import { HotkeyField } from "../ui/HotkeyField";
import { useTr } from "../../i18n/text";

const ACTIONS: { key: HotkeyAction; label: string }[] = [
  { key: "AfkToggle", label: "Toggle AFK mode" },
  { key: "AfkTriggerNow", label: "Send AFK key now" },
];

export function HotkeysTab({ s }: { s: UseSettingsReturn }) {
  const t = useTr();
  const store = useStore();
  return (
    <div className="space-y-0">
      <SectionLabel>AFK Mode</SectionLabel>
      {ACTIONS.map((action) => (
        <HotkeyField
          key={action.key}
          label={action.label}
          value={s.get("Hotkeys", action.key)}
          error={store.hotkeyErrors.includes(action.key)}
          onCaptureChange={store.setHotkeysPaused}
          onChange={(accelerator) => {
            s.set("Hotkeys", action.key, accelerator);
            store.setHotkeyBinding(action.key, accelerator);
          }}
        />
      ))}
      <div className="text-[11px] text-zinc-500 px-1 pt-2 leading-4">
        {t("Click a field, then press the combination. Esc cancels, Backspace clears")}
      </div>
    </div>
  );
}
