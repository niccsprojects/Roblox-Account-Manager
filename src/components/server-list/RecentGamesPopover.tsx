import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RecentGamesList } from "./RecentGamesList";
import { useTr } from "../../i18n/text";

export function RecentGamesPopover({
  open,
  onClose,
  anchorRef,
  userId,
  maxRecent,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  userId: number | null;
  maxRecent: number;
  onSelect: (placeId: number) => void;
}) {
  const t = useTr();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
    transformOrigin: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
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

    let raf = 0;
    function compute() {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;

      const gap = 8;
      const margin = 10;

      const a = anchor.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const panelW = p.width || 300;
      const panelH = p.height || 0;

      const preferredLeft = a.right - panelW;
      const left = Math.min(window.innerWidth - margin - panelW, Math.max(margin, preferredLeft));

      const belowSpace = window.innerHeight - margin - (a.bottom + gap);
      const aboveSpace = a.top - gap - margin;

      const openBelow = belowSpace >= panelH || belowSpace >= aboveSpace;
      const top = openBelow
        ? Math.min(window.innerHeight - margin - panelH, a.bottom + gap)
        : Math.max(margin, a.top - gap - panelH);

      const maxHeight = openBelow
        ? Math.max(160, window.innerHeight - margin - top)
        : Math.max(160, a.top - gap - margin);

      setPos({
        top,
        left,
        maxHeight: Math.min(360, maxHeight),
        transformOrigin: openBelow ? "top right" : "bottom right",
      });
    }

    function schedule() {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(compute);
    }

    schedule();
    const t1 = window.setTimeout(schedule, 0);

    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    return () => {
      window.clearTimeout(t1);
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [open, anchorRef]);

  if (!open) return null;

  const panel = (
    <div
      ref={panelRef}
      className="theme-modal-scope theme-panel theme-border fixed w-[300px] bg-zinc-900 border border-zinc-700/60 rounded-xl shadow-2xl z-[999] animate-scale-in p-2 flex flex-col"
      style={
        pos
          ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight, transformOrigin: pos.transformOrigin }
          : { top: 0, left: 0, transformOrigin: "top right" }
      }
    >
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 px-1 pb-2">
        {t("Recent games")}
      </div>
      <div className="flex-1 min-h-0">
        <RecentGamesList
          userId={userId}
          maxRecent={maxRecent}
          onSelect={(placeId) => {
            onSelect(placeId);
            onClose();
          }}
        />
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
