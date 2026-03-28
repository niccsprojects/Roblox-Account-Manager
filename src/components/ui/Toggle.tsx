import { useTr, trNode } from "../../i18n/text";

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  description?: string;
  disabled?: boolean;
}) {
  const t = useTr();
  return (
    <div
      className={`group flex items-start gap-3 py-2 px-1 rounded-lg select-none transition-colors ${
        disabled
          ? "cursor-not-allowed opacity-60"
          : "cursor-pointer hover:bg-white/[0.02]"
      }`}
      onClick={() => {
        if (disabled) return;
        onChange(!checked);
      }}
    >
      <div className="relative mt-0.5 shrink-0">
        <div
          className={`w-8 h-[18px] rounded-full transition-all duration-200 ${
            checked ? "bg-[var(--toggle-on-bg)]" : "bg-[var(--toggle-off-bg)]"
          }`}
        />
        <div
          className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-[var(--toggle-knob-bg)] transition-all duration-200 ${
            checked ? "left-[16px] shadow-[0_0_6px_var(--toggle-on-shadow)]" : "left-[2px] shadow-sm"
          }`}
        />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] text-zinc-200 leading-tight">{trNode(label, t)}</div>
        {description && (
          <div className="text-[11px] text-zinc-500 leading-snug mt-0.5">{t(description)}</div>
        )}
      </div>
    </div>
  );
}
