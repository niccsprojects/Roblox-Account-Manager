import { useRef, useEffect, useMemo, useState } from "react";
import { User } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useStore } from "../../store";
import { GroupSection } from "./GroupSection";
import { AccountRowView } from "./AccountRow";
import { useTr } from "../../i18n/text";
import { AddAccountDialog } from "../dialogs/AddAccountDialog";

type DragSelectRect = { left: number; top: number; width: number; height: number };
type Container = { key: string; userIds: number[] };

export function AccountList() {
  const t = useTr();
  const store = useStore();
  const listRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [dragSelectRect, setDragSelectRect] = useState<DragSelectRect | null>(null);
  const [focusedGroupKey, setFocusedGroupKey] = useState<string | null>(null);

  const [containers, setContainers] = useState<Container[]>([]);
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const dragSelectionRef = useRef<number[]>([]);

  const accountById = useMemo(
    () => new Map(store.accounts.map((a) => [a.UserID, a])),
    [store.accounts]
  );
  const groupMeta = useMemo(() => {
    const m = new Map<string, { displayName: string }>();
    for (const g of store.groups) m.set(g.key, { displayName: g.displayName });
    return m;
  }, [store.groups]);

  useEffect(() => {
    if (activeId != null) return;
    setContainers(store.groups.map((g) => ({ key: g.key, userIds: g.accounts.map((a) => a.UserID) })));
  }, [store.groups, activeId]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function findContainerKey(id: UniqueIdentifier): string | undefined {
    if (typeof id === "number") return containers.find((c) => c.userIds.includes(id))?.key;
    const s = String(id);
    if (s.startsWith("g:")) return s.slice(2);
    return containers.find((c) => c.key === s)?.key;
  }

  function resync() {
    setContainers(store.groups.map((g) => ({ key: g.key, userIds: g.accounts.map((a) => a.UserID) })));
  }

  function commit(next: Container[]) {
    void store.applyArrangement(next.map((c) => ({ key: c.key, userIds: c.userIds })));
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(e.active.id);
    if (typeof e.active.id === "number") {
      dragSelectionRef.current = store.selectedIds.has(e.active.id)
        ? store.orderedUserIds.filter((id) => store.selectedIds.has(id))
        : [e.active.id];
    } else {
      dragSelectionRef.current = [];
    }
  }

  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over || typeof active.id !== "number") return;
    const activeKey = findContainerKey(active.id);
    const overKey = findContainerKey(over.id);
    if (!activeKey || !overKey || activeKey === overKey) return;

    setContainers((prev) => {
      const activeC = prev.find((c) => c.key === activeKey);
      const overC = prev.find((c) => c.key === overKey);
      if (!activeC || !overC) return prev;
      const activeIds = activeC.userIds.filter((id) => id !== active.id);
      let newIndex = overC.userIds.length;
      if (typeof over.id === "number") {
        const overIndex = overC.userIds.indexOf(over.id);
        if (overIndex >= 0) newIndex = overIndex;
      }
      const overIds = [
        ...overC.userIds.slice(0, newIndex),
        active.id as number,
        ...overC.userIds.slice(newIndex),
      ];
      return prev.map((c) =>
        c.key === activeKey ? { ...c, userIds: activeIds } : c.key === overKey ? { ...c, userIds: overIds } : c
      );
    });
  }

  function relocateSelection(conts: Container[], activeIdNum: number, sel: number[]): Container[] {
    const selSet = new Set(sel);
    const tc = conts.find((c) => c.userIds.includes(activeIdNum));
    if (!tc) return conts;
    const insertAt = tc.userIds.filter((id) => !selSet.has(id) || id === activeIdNum).indexOf(activeIdNum);
    const cleaned = conts.map((c) => ({ ...c, userIds: c.userIds.filter((id) => !selSet.has(id)) }));
    return cleaned.map((c) => {
      if (c.key !== tc.key) return c;
      const at = Math.max(0, insertAt);
      return { ...c, userIds: [...c.userIds.slice(0, at), ...sel, ...c.userIds.slice(at)] };
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveId(null);
    if (!over) {
      resync();
      return;
    }

    if (typeof active.id !== "number") {
      const fromKey = String(active.id).slice(2);
      const overKey = findContainerKey(over.id);
      if (overKey && fromKey !== overKey) {
        setContainers((prev) => {
          const from = prev.findIndex((c) => c.key === fromKey);
          const to = prev.findIndex((c) => c.key === overKey);
          if (from < 0 || to < 0) return prev;
          const next = arrayMove(prev, from, to);
          commit(next);
          return next;
        });
      } else {
        resync();
      }
      return;
    }

    const activeKey = findContainerKey(active.id);
    const overKey = findContainerKey(over.id);
    if (!activeKey || !overKey) {
      resync();
      return;
    }

    setContainers((prev) => {
      let next = prev;
      if (activeKey === overKey && typeof over.id === "number") {
        const c = prev.find((x) => x.key === activeKey);
        if (c) {
          const oldI = c.userIds.indexOf(active.id as number);
          const newI = c.userIds.indexOf(over.id);
          if (oldI >= 0 && newI >= 0 && oldI !== newI) {
            const moved = arrayMove(c.userIds, oldI, newI);
            next = prev.map((x) => (x.key === activeKey ? { ...x, userIds: moved } : x));
          }
        }
      }
      const sel = dragSelectionRef.current;
      if (sel.length > 1) next = relocateSelection(next, active.id as number, sel);
      commit(next);
      return next;
    });
  }

  function onDragCancel() {
    setActiveId(null);
    resync();
  }

  function handleBackgroundClick(e: React.MouseEvent) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (e.target === e.currentTarget) store.deselectAll();
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
      for (const cookie of matches) await store.addAccountByCookie(cookie);
    }
  }

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey && e.shiftKey) {
        e.preventDefault();
        const dir = e.key === "ArrowUp" ? "up" : "down";
        if (focusedGroupKey) store.nudgeGroup(focusedGroupKey, dir);
        else store.nudgeSelectionVertical(dir);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        store.navigateSelection(e.key === "ArrowUp" ? "up" : "down", e.shiftKey);
      }
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        store.selectAll();
      }
      if (e.key === "Escape") store.deselectAll();
      if (e.key === "Home") {
        e.preventDefault();
        if (store.orderedUserIds.length > 0) store.selectSingle(store.orderedUserIds[0]);
      }
      if (e.key === "End") {
        e.preventDefault();
        if (store.orderedUserIds.length > 0)
          store.selectSingle(store.orderedUserIds[store.orderedUserIds.length - 1]);
      }
    }
    el.addEventListener("keydown", handleKeyDown);
    return () => el.removeEventListener("keydown", handleKeyDown);
  }, [
    store.navigateSelection,
    store.selectAll,
    store.deselectAll,
    store.selectSingle,
    store.orderedUserIds,
    store.nudgeSelectionVertical,
    store.nudgeGroup,
    focusedGroupKey,
  ]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      if ((e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (e.key === "y" || e.key === "Y" || ((e.key === "z" || e.key === "Z") && e.shiftKey)) {
        e.preventDefault();
        store.redo();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [store.undo, store.redo]);

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    if (store.reorderMode) return;
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
      if (!dragging && (width > threshold || height > threshold)) dragging = true;
      if (!dragging) return;
      const additive = e.ctrlKey || e.metaKey;
      const selectedInRect = new Set<number>();
      const rows = list.querySelectorAll<HTMLElement>("[data-account-row='true']");
      for (const row of rows) {
        const userIdRaw = row.dataset.userId;
        if (!userIdRaw) continue;
        const userId = Number(userIdRaw);
        if (!Number.isFinite(userId) || !selectableIds.has(userId)) continue;
        const rowRect = row.getBoundingClientRect();
        const rowLeft = rowRect.left - listRect.left + list.scrollLeft;
        const rowTop = rowRect.top - listRect.top + list.scrollTop;
        if (rowLeft + rowRect.width >= left && rowLeft <= right && rowTop + rowRect.height >= top && rowTop <= bottom)
          selectedInRect.add(userId);
      }
      if (collapsedGroupIds.size > 0) {
        const headers = list.querySelectorAll<HTMLElement>("[data-group-header='true']");
        for (const header of headers) {
          const groupKey = header.dataset.groupKey;
          if (!groupKey) continue;
          const memberIds = collapsedGroupIds.get(groupKey);
          if (!memberIds) continue;
          const hr = header.getBoundingClientRect();
          const hLeft = hr.left - listRect.left + list.scrollLeft;
          const hTop = hr.top - listRect.top + list.scrollTop;
          if (hLeft + hr.width >= left && hLeft <= right && hTop + hr.height >= top && hTop <= bottom)
            for (const id of memberIds) selectedInRect.add(id);
        }
      }
      store.setSelectedIds(additive ? new Set<number>([...baseSelection, ...selectedInRect]) : selectedInRect);
      setDragSelectRect({ left, top, width, height });
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

  const activeAccount = typeof activeId === "number" ? accountById.get(activeId) : undefined;

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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <SortableContext items={containers.map((c) => `g:${c.key}`)} strategy={verticalListSortingStrategy}>
          {containers.map((c) => {
            const accounts = c.userIds
              .map((id) => accountById.get(id))
              .filter((a): a is NonNullable<typeof a> => !!a);
            return (
              <GroupSection
                key={c.key}
                groupKey={c.key}
                displayName={groupMeta.get(c.key)?.displayName ?? c.key}
                accounts={accounts}
                collapsed={store.collapsedGroups.has(c.key)}
                onToggle={() => store.toggleGroup(c.key)}
                onHeaderFocus={() => setFocusedGroupKey(c.key)}
                onHeaderBlur={() => setFocusedGroupKey((k) => (k === c.key ? null : k))}
              />
            );
          })}
        </SortableContext>
        <DragOverlay>
          {activeAccount ? (
            <AccountRowView account={activeAccount} overlay />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
