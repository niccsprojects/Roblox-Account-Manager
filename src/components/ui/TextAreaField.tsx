import { useTr } from "../../i18n/text";

export function TextAreaField({
  value,
  onChange,
  label,
  placeholder,
  rows = 5,
  disabled = false,
  error,
  description,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  error?: string | null;
  description?: string;
}) {
  const t = useTr();

  return (
    <div className="py-2 px-1">
      <div className="text-[13px] text-zinc-300">{t(label)}</div>
      {description ? (
        <div className="mt-0.5 text-[11px] text-zinc-500">{t(description)}</div>
      ) : null}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ? t(placeholder) : undefined}
        rows={rows}
        disabled={disabled}
        spellCheck={false}
        className={`mt-2 w-full resize-y rounded-lg border bg-zinc-800/60 px-3 py-2 text-[12px] text-zinc-200 placeholder-zinc-600 transition-colors focus:outline-none ${
          disabled
            ? "cursor-not-allowed border-zinc-800/60 opacity-60"
            : error
              ? "border-red-500/50 focus:border-red-500/60"
              : "border-zinc-700/60 focus:border-sky-500/40"
        }`}
      />
      {error ? <div className="mt-1.5 text-[11px] text-red-400">{t(error)}</div> : null}
    </div>
  );
}
