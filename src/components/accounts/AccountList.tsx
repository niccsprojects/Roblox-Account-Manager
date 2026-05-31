import { useRef, useEffect, useState } from "react";
import { User } from "lucide-react";
import { useStore } from "../../store";
import { GroupSection } from "./GroupSection";
import { useTr } from "../../i18n/text";
import { AddAccountDialog } from "../dialogs/AddAccountDialog";

type DragSelectRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function AccountList() {
  const t = useTr();
  const store = useStore();
  const listRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [dragSelectRect, setDragSelectRect] = useState<DragSelectRect | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        store.navigateSelection(e.key === "ArrowUp" ? "up" : "down", e.shiftKey);
      }
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        store.selectAll();
      }
      if (e.key === "Escape") {
        store.deselectAll();
      }
      if (e.key === "Home") {
        e.preventDefault();
        if (store.orderedUserIds.length > 0) {
          store.selectSingle(store.orderedUserIds[0]);
        }
      }
      if (e.key === "End") {
        e.preventDefault();
        if (store.orderedUserIds.length > 0) {
          store.selectSingle(store.orderedUserIds[store.orderedUserIds.length - 1]);
        }
      }
    }

    el.addEventListener("keydown", handleKeyDown);
    return () => el.removeEventListener("keydown", handleKeyDown);
  }, [store.navigateSelection, store.selectAll, store.deselectAll, store.selectSingle, store.orderedUserIds]);

  function handleDrop(targetGroupKey: string) {
    if (!store.dragState) return;
    const userId = store.dragState.userId;
    const sourceGroup = store.dragState.sourceGroup;
    store.setDragState(null);
    if (sourceGroup === targetGroupKey) return;

    const selected = store.selectedIds.has(userId)
      ? [...store.selectedIds]
      : [userId];
    store.moveToGroup(selected, targetGroupKey);
  }

  function handleBackgroundClick(e: React.MouseEvent) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (e.target === e.currentTarget) {
      store.deselectAll();
    }
  }

  function handleClickCapture(e: React.MouseEvent) {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }

  function handleBackgroundContext(e: React.MouseEvent) {
    if (e.target === e.currentTarget) {
      e.preventDefault();
      store.deselectAll();
      store.openContextMenu(e.clientX, e.clientY);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  async function handleExternalDrop(e: React.DragEvent) {
    e.preventDefault();
    const text = e.dataTransfer.getData("text/plain");
    if (!text) return;
    const cookieRe =
      /_\|WARNING:-DO-NOT-SHARE-THIS\.--Sharing-this-will-allow-someone-to-log-in-as-you-and-to-steal-your-ROBUX-and-items\.\|\w+/g;
    const matches = text.match(cookieRe);
    if (matches) {
      for (const cookie of matches) {
        await store.addAccountByCookie(cookie);
      }
    }
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;

    const list = listRef.current;
    if (!list) return;

    const target = e.target;
    if (!(target instanceof Element)) return;

    const rowTarget = target.closest<HTMLElement>("[data-account-row='true']");
    if (rowTarget) {
      const onRowBackground = target === rowTarget;
      const onRowMarqueeSurface = target.closest("[data-row-marquee-surface='true']") !== null;
      if (!onRowBackground && !onRowMarqueeSurface) return;
    }

    e.preventDefault();
    list.focus();

    const initialScrollTop = list.scrollTop;
    const initialScrollLeft = list.scrollLeft;
    const listRect = list.getBoundingClientRect();
    const startX = e.clientX - listRect.left + initialScrollLeft;
    const startY = e.clientY - listRect.top + initialScrollTop;
    const baseSelection = new Set(store.selectedIds);
    const selectableIds = new Set(store.orderedUserIds);
    const collapsedGroupIds = new Map<string, number[]>();
    for (const group of store.groups) {
      if (store.collapsedGroups.has(group.key)) {
        collapsedGroupIds.set(group.key, group.accounts.map((a) => a.UserID));
      }
    }

    let dragging = false;
    const threshold = 4;

    const updateSelection = (clientX: number, clientY: number) => {
      const currentX = clientX - listRect.left + list.scrollLeft;
      const currentY = clientY - listRect.top + list.scrollTop;
      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);
      const right = Math.max(startX, currentX);
      const bottom = Math.max(startY, currentY);
      const width = right - left;
      const height = bottom - top;

      if (!dragging && (width > threshold || height > threshold)) {
        dragging = true;
      }
      if (!dragging) return;

      const additive = e.ctrlKey || e.metaKey;
      const selectedInRect = new Set<number>();
      const rows = list.querySelectorAll<HTMLElement>("[data-account-row='true']");
      for (const row of rows) {
        const userIdRaw = row.dataset.userId;
        if (!userIdRaw) continue;
        const userId = Number(userIdRaw);
        if (!Number.isFinite(userId)) continue;
        if (!selectableIds.has(userId)) continue;

        const rowRect = row.getBoundingClientRect();
        const rowLeft = rowRect.left - listRect.left + list.scrollLeft;
        const rowTop = rowRect.top - listRect.top + list.scrollTop;
        const rowRight = rowLeft + rowRect.width;
        const rowBottom = rowTop + rowRect.height;

        const intersects =
          rowRight >= left &&
          rowLeft <= right &&
          rowBottom >= top &&
          rowTop <= bottom;

        if (intersects) selectedInRect.add(userId);
      }

      if (collapsedGroupIds.size > 0) {
        const headers = list.querySelectorAll<HTMLElement>("[data-group-header='true']");
        for (const header of headers) {
          const groupKey = header.dataset.groupKey;
          if (!groupKey) continue;
          const memberIds = collapsedGroupIds.get(groupKey);
          if (!memberIds) continue;

          const headerRect = header.getBoundingClientRect();
          const headerLeft = headerRect.left - listRect.left + list.scrollLeft;
          const headerTop = headerRect.top - listRect.top + list.scrollTop;
          const headerRight = headerLeft + headerRect.width;
          const headerBottom = headerTop + headerRect.height;

          const intersects =
            headerRight >= left &&
            headerLeft <= right &&
            headerBottom >= top &&
            headerTop <= bottom;

          if (intersects) {
            for (const id of memberIds) selectedInRect.add(id);
          }
        }
      }

      const next = additive
        ? new Set<number>([...baseSelection, ...selectedInRect])
        : selectedInRect;
      store.setSelectedIds(next);

      setDragSelectRect({
        left,
        top,
        width,
        height,
      });
      suppressClickRef.current = true;
    };

    const endDrag = (clearSuppress: boolean) => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      setDragSelectRect(null);
      if (clearSuppress) suppressClickRef.current = false;
    };

    const onMouseUp = () => endDrag(false);
    const onCancel = () => endDrag(true);

    const onMouseMove = (ev: MouseEvent) => {
      if (ev.buttons === 0) {
        endDrag(true);
        return;
      }
      updateSelection(ev.clientX, ev.clientY);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
  }

  if (store.accounts.length === 0 && !store.searchQuery) {
    return (
      <>
        <div
          data-tour="accounts-list"
          className="theme-surface flex-1 flex flex-col items-center justify-center min-h-0 text-center px-8"
          onDragOver={handleDragOver}
          onDrop={handleExternalDrop}
        >
          <div className="theme-panel theme-border w-14 h-14 rounded-2xl border flex items-center justify-center mb-4 animate-fade-in">
            <User size={24} strokeWidth={1.5} className="theme-muted" />
          </div>
          <p className="theme-muted text-sm mb-1 animate-fade-in">{t("No accounts yet")}</p>
          <p className="theme-label text-xs animate-fade-in">
            {t("Click")}{" "}
            <button
              type="button"
              onClick={() => setAddDialogOpen(true)}
              data-tour="empty-add"
              className="theme-accent hover:underline underline-offset-2"
            >
              {t("Add")}
            </button>{" "}
            {t("or drop a cookie here")}
          </p>
        </div>
        <AddAccountDialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)} />
      </>
    );
  }

  if (store.groups.length === 0 && store.searchQuery) {
    return (
      <div className="theme-surface flex-1 flex items-center justify-center min-h-0">
        <p className="theme-muted text-sm animate-fade-in">{t("No matches for")} &ldquo;{store.searchQuery}&rdquo;</p>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      data-tour="accounts-list"
      tabIndex={0}
      className="relative flex-1 overflow-y-auto min-h-0 py-1 outline-none"
      onClickCapture={handleClickCapture}
      onClick={handleBackgroundClick}
      onContextMenu={handleBackgroundContext}
      onMouseDown={handleMouseDown}
      onDragOver={handleDragOver}
      onDrop={handleExternalDrop}
    >
      {dragSelectRect && (
        <div
          className="pointer-events-none absolute z-30 rounded-md border theme-accent-border theme-accent-bg"
          style={{
            left: dragSelectRect.left,
            top: dragSelectRect.top,
            width: dragSelectRect.width,
            height: dragSelectRect.height,
            boxShadow: "0 0 0 1px var(--accent-strong), 0 0 20px var(--accent-soft)",
          }}
        />
      )}
      {store.groups.map((group) => (
        <GroupSection
          key={group.key}
          group={group}
          collapsed={store.collapsedGroups.has(group.key)}
          onToggle={() => store.toggleGroup(group.key)}
          onDrop={handleDrop}
        />
      ))}
    </div>
  );
}
