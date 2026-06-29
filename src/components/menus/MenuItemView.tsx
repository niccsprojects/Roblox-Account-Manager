import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTr } from "../../i18n/text";

export interface MenuItem {
  label: string;
  action?: () => void;
  separator?: boolean;
  submenu?: MenuItem[];
  devOnly?: boolean;
  className?: string;
}

const MenuLevelContext = createContext<{
  openKey: string | null;
  setOpenKey: React.Dispatch<React.SetStateAction<string | null>>;
}>({ openKey: null, setOpenKey: () => {} });

export function MenuLevel({ children }: { children: React.ReactNode }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <MenuLevelContext.Provider value={{ openKey, setOpenKey }}>
      {children}
    </MenuLevelContext.Provider>
  );
}

function pointInRect(x: number, y: number, r: DOMRect): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function triangleSide(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): boolean {
  const d1 = triangleSide(px, py, ax, ay, bx, by);
  const d2 = triangleSide(px, py, bx, by, cx, cy);
  const d3 = triangleSide(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function SubmenuItem({
  item,
  close,
  itemKey,
}: {
  item: MenuItem;
  close: () => void;
  itemKey: string;
}) {
  const t = useTr();
  const { openKey, setOpenKey } = useContext(MenuLevelContext);
  const open = openKey === itemKey;
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const graceAnchor = useRef<{ x: number; y: number } | null>(null);

  function clearCloseTimer() {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  function scheduleClose() {
    if (closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpenKey((prev) => (prev === itemKey ? null : prev));
    }, 240);
  }

  function openNow() {
    clearCloseTimer();
    setOpenKey(itemKey);
  }

  useEffect(() => {
    if (!open) {
      graceAnchor.current = null;
      clearCloseTimer();
      return;
    }

    function onMove(e: MouseEvent) {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;

      const px = e.clientX;
      const py = e.clientY;
      const triggerRect = trigger.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();

      if (pointInRect(px, py, panelRect)) {
        clearCloseTimer();
        return;
      }
      if (pointInRect(px, py, triggerRect)) {
        clearCloseTimer();
        graceAnchor.current = { x: px, y: py };
        return;
      }

      const anchor = graceAnchor.current;
      const opensRight = panelRect.left >= triggerRect.right - 4;
      const nearX = opensRight ? panelRect.left : panelRect.right;
      const headingToPanel =
        anchor !== null &&
        pointInTriangle(
          px,
          py,
          anchor.x,
          anchor.y,
          nearX,
          panelRect.top - 12,
          nearX,
          panelRect.bottom + 12
        );

      if (headingToPanel) {
        clearCloseTimer();
      } else {
        scheduleClose();
      }
    }

    document.addEventListener("mousemove", onMove);
    return () => document.removeEventListener("mousemove", onMove);
  }, [open]);

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <div ref={triggerRef} className="relative" onMouseEnter={openNow}>
      <button
        type="button"
        onClick={openNow}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex w-[calc(100%-0.5rem)] items-center justify-between px-3 py-1.5 text-[13px] text-left rounded-md mx-1 ${
          open ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800"
        }`}
      >
        <span>{t(item.label)}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-zinc-600">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
      {open && (
        <div
          ref={panelRef}
          className="theme-modal-scope theme-panel theme-border absolute left-full top-0 -mt-1 ml-0.5 min-w-[200px] bg-zinc-900/95 backdrop-blur-xl border border-zinc-700/50 rounded-xl shadow-2xl py-1 z-50 animate-fade-in"
        >
          <MenuLevel>
            <div className="pl-1">
              {item.submenu!.map((sub, i) => (
                <MenuItemView key={i} item={sub} close={close} itemKey={String(i)} />
              ))}
            </div>
          </MenuLevel>
        </div>
      )}
    </div>
  );
}

export function MenuItemView({
  item,
  close,
  itemKey,
}: {
  item: MenuItem;
  close: () => void;
  itemKey: string;
}) {
  const t = useTr();
  if (item.separator) {
    return <div className="my-1 border-t border-zinc-800/80" />;
  }

  if (item.submenu) {
    return <SubmenuItem item={item} close={close} itemKey={itemKey} />;
  }

  return (
    <div
      className={`flex items-center px-3 py-1.5 text-[13px] hover:bg-zinc-800 cursor-default rounded-md mx-1 ${item.className || "text-zinc-300"}`}
      onClick={() => {
        item.action?.();
        close();
      }}
    >
      {t(item.label)}
    </div>
  );
}
