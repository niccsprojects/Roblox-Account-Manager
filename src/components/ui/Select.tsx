import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useTr } from "../../i18n/text";
import { ChevronDown } from "lucide-react";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
}

export function Select({ value, options, onChange, className = "", disabled = false }: SelectProps) {
  const t = useTr();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    openBelow: boolean;
  } | null>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        panelRef.current &&
        !panelRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;

    function compute() {
      const anchor = ref.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const margin = 10;
      const gap = 4;
      const belowSpace = window.innerHeight - margin - (r.bottom + gap);
      const aboveSpace = r.top - gap - margin;
      const openBelow = belowSpace >= 160 || belowSpace >= aboveSpace;
      const maxHeight = Math.min(280, Math.max(120, openBelow ? belowSpace : aboveSpace));
      setPos({
        top: openBelow ? r.bottom + gap : r.top - gap,
        left: r.left,
        width: r.width,
        maxHeight,
        openBelow,
      });
    }

    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open]);

  const panel =
    open && !disabled && pos
      ? createPortal(
          <div
            ref={panelRef}
            className="theme-modal-scope theme-panel theme-border fixed z-[999] bg-zinc-900 border border-zinc-700/60 rounded-lg shadow-2xl py-0.5 animate-scale-in overflow-y-auto overscroll-contain"
            style={{
              left: pos.left,
              top: pos.openBelow ? pos.top : undefined,
              bottom: pos.openBelow ? undefined : window.innerHeight - pos.top,
              width: pos.width,
              maxHeight: pos.maxHeight,
              transformOrigin: pos.openBelow ? "top" : "bottom",
            }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                onClick={() => { onChange(o.value); setOpen(false); }}
                className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors ${
                  o.value === value
                    ? "text-sky-400 bg-sky-500/10"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {t(o.label)}
              </button>
            ))}
          </div>,
          document.body
        )
      : null;

  return (
    <div ref={ref} className={`relative theme-modal-scope ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen(!open);
        }}
        className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
          disabled
            ? "cursor-not-allowed border border-zinc-800/60 bg-zinc-800/40 text-zinc-500"
            : "bg-zinc-800/50 border border-zinc-700/50 text-zinc-300 hover:border-zinc-600 focus:outline-none focus:border-zinc-600"
        }`}
      >
        <span className="truncate">{selected?.label ? t(selected.label) : t(value)}</span>
        <ChevronDown size={10} strokeWidth={2.5} className={`shrink-0 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {panel}
    </div>
  );
}
