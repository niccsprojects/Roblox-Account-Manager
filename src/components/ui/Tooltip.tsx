import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type TooltipSide = "top" | "bottom";

let tooltipOpenCount = 0;
let lastTooltipCloseAt = 0;

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function Tooltip({
  content,
  children,
  side = "top",
  maxWidth = 280,
  delayMs = 350,
  showArrow = false,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  maxWidth?: number;
  delayMs?: number;
  showArrow?: boolean;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; side: TooltipSide } | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const isOpenRef = useRef(false);

  const portalRoot = useMemo(() => {
    if (typeof document === "undefined") return null;
    return document.body;
  }, []);

  const updatePos = () => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const preferred = side;
    const autoSide: TooltipSide = preferred === "top" && r.top < 56 ? "bottom" : preferred;
    const x = clamp(r.left + r.width / 2, 12, vw - 12);
    const y = autoSide === "top" ? clamp(r.top, 12, vh - 12) : clamp(r.bottom, 12, vh - 12);
    setPos({ x, y, side: autoSide });
  };

  const clearOpenTimer = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };

  const doOpen = () => {
    clearOpenTimer();
    updatePos();
    setOpen(true);
    if (!isOpenRef.current) {
      tooltipOpenCount += 1;
      isOpenRef.current = true;
    }
  };

  const doClose = () => {
    clearOpenTimer();
    setOpen(false);
    if (isOpenRef.current) {
      tooltipOpenCount = Math.max(0, tooltipOpenCount - 1);
      isOpenRef.current = false;
      lastTooltipCloseAt = Date.now();
    }
  };

  useEffect(() => {
    if (!open) return;

    updatePos();
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open, side]);

  useLayoutEffect(() => {
    if (!open || !pos) return;
    const panel = panelRef.current;
    if (!panel) return;
    const w = panel.getBoundingClientRect().width;
    const vw = window.innerWidth;
    const clamped = clamp(pos.x, 12 + w / 2, vw - 12 - w / 2);
    if (Math.abs(clamped - pos.x) > 0.5) {
      setPos({ ...pos, x: clamped });
    }
  }, [open, pos]);

  useEffect(() => {
    return () => {
      clearOpenTimer();
      if (isOpenRef.current) {
        tooltipOpenCount = Math.max(0, tooltipOpenCount - 1);
        isOpenRef.current = false;
      }
    };
  }, []);

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex"
        onMouseEnter={() => {
          const canInstant =
            tooltipOpenCount > 0 || Date.now() - lastTooltipCloseAt <= 250 || delayMs <= 0;
          if (canInstant) {
            doOpen();
            return;
          }
          clearOpenTimer();
          openTimerRef.current = window.setTimeout(doOpen, delayMs);
        }}
        onMouseLeave={doClose}
        onFocus={doOpen}
        onBlur={doClose}
      >
        {children}
      </span>
      {open && portalRoot && pos
        ? createPortal(
            <div
              className="fixed z-[200] pointer-events-none"
              style={{
                left: pos.x,
                top: pos.y,
                transform:
                  pos.side === "top"
                    ? "translate(-50%, calc(-100% - 8px))"
                    : "translate(-50%, 8px)",
              }}
            >
              <div
                ref={panelRef}
                className={[
                  "relative theme-panel border theme-border rounded-lg px-2.5 py-2 shadow-2xl text-[11px] text-[var(--panel-fg)]",
                  "animate-tooltip-pop",
                  pos.side === "top" ? "origin-bottom" : "origin-top",
                ].join(" ")}
                style={{
                  maxWidth,
                  width: "max-content",
                  willChange: "transform, opacity",
                  ["--tt-from-y" as never]: pos.side === "top" ? "6px" : "-6px",
                }}
                role="tooltip"
              >
                {content}
                {showArrow ? (
                  <>
                    <div
                      className={[
                        "absolute left-1/2 -translate-x-1/2 w-7 h-px bg-[var(--panel-bg)]",
                        pos.side === "top" ? "bottom-0" : "top-0",
                      ].join(" ")}
                    />
                    <svg
                      width="16"
                      height="10"
                      viewBox="0 0 16 10"
                      className={[
                        "absolute left-1/2 -translate-x-1/2",
                        pos.side === "top" ? "-bottom-[9px]" : "-top-[9px] rotate-180",
                      ].join(" ")}
                      aria-hidden="true"
                      style={{
                        filter: "drop-shadow(0 10px 18px rgba(0,0,0,0.35))",
                      }}
                    >
                      <path
                        d="M1 1 L8 9 L15 1 Z"
                        fill="var(--panel-bg)"
                        stroke="var(--border-color)"
                        strokeWidth="1"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        shapeRendering="geometricPrecision"
                      />
                    </svg>
                  </>
                ) : null}
              </div>
            </div>,
            portalRoot
          )
        : null}
    </>
  );
}
