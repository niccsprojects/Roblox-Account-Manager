import { useEffect, useState } from "react";
import { useTr } from "../../i18n/text";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function keyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

export function HotkeyField({
  label,
  value,
  error = false,
  onChange,
  onCaptureChange,
}: {
  label: string;
  value: string;
  error?: boolean;
  onChange: (accelerator: string) => void;
  onCaptureChange?: (capturing: boolean) => void;
}) {
  const t = useTr();
  const [capturing, setCapturing] = useState(false);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    if (!capturing || !onCaptureChange) return;
    onCaptureChange(true);
    return () => onCaptureChange(false);
  }, [capturing, onCaptureChange]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      e.currentTarget.blur();
      return;
    }
    if (e.key === "Backspace") {
      onChange("");
      e.currentTarget.blur();
      return;
    }
    if (MODIFIER_KEYS.has(e.key)) return;
    const modifiers = [
      e.ctrlKey && "Ctrl",
      e.altKey && "Alt",
      e.shiftKey && "Shift",
      e.metaKey && "Super",
    ].filter((m): m is string => Boolean(m));
    if (modifiers.length === 0) {
      setHint(true);
      return;
    }
    onChange([...modifiers, keyName(e.code)].join("+"));
    e.currentTarget.blur();
  }

  return (
    <div className="py-2 px-1">
      <div className="flex items-center gap-3">
        <span className="text-[13px] text-zinc-300 shrink-0">{t(label)}</span>
        <button
          type="button"
          aria-label={t(label)}
          aria-invalid={error}
          onClick={() => {
            setHint(false);
            setCapturing(true);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            setCapturing(false);
            setHint(false);
          }}
          className={`ml-auto min-w-[150px] px-2.5 py-1 rounded-md text-[13px] font-mono text-right transition-colors bg-zinc-800/60 border focus:outline-none ${
            capturing
              ? "border-sky-500/60 text-sky-200"
              : error
                ? "border-red-500/60 text-red-300"
                : "border-zinc-700/60 text-zinc-200"
          }`}
        >
          {capturing ? t("Press a key combination") : value || t("Not set")}
        </button>
      </div>
      {hint && (
        <div className="text-[11px] text-amber-300/90 text-right pt-1">
          {t("Hold Ctrl, Alt or Shift with the key")}
        </div>
      )}
    </div>
  );
}
