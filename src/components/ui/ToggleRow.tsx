import { useTr } from "../../i18n/text";

export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const t = useTr();
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-[var(--panel-fg)]">{t(label)}</span>
      <button
        onClick={() => onChange(!checked)}
        className={`w-8 h-[18px] rounded-full transition-colors relative border ${
          checked ? "bg-[var(--toggle-on-bg)] border-[var(--toggle-on-bg)]" : "bg-[var(--toggle-off-bg)] border-[var(--toggle-off-bg)]"
        }`}
        aria-pressed={checked}
        aria-label={t(label)}
      >
        <div
          className={`w-3.5 h-3.5 rounded-full bg-[var(--toggle-knob-bg)] absolute top-[2px] transition-all ${
            checked ? "left-[17px]" : "left-[2px]"
          }`}
        />
      </button>
    </div>
  );
}
