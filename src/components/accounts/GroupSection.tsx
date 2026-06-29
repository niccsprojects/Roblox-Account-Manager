import { Check, ChevronRight, GripVertical } from "lucide-react";
import { useStore } from "../../store";
import type { ParsedGroup } from "../../types";
import { AccountRow } from "./AccountRow";
import { useTr } from "../../i18n/text";

export function GroupSection({
  group,
  collapsed,
  onToggle,
  onDrop,
  onHeaderFocus,
  onHeaderBlur,
}: {
  group: ParsedGroup;
  collapsed: boolean;
  onToggle: () => void;
  onDrop: (groupKey: string) => void;
  onHeaderFocus?: () => void;
  onHeaderBlur?: () => void;
}) {
  const t = useTr();
  const store = useStore();
  const showHeader = group.key !== "__all__" && store.showGroups && (store.theme?.show_headers ?? true);
  const reorderStyle = store.settings?.General?.ReorderStyle === "mode" ? "mode" : "handle";
  const headerDraggable = reorderStyle === "mode" && store.reorderMode;

  function startGroupDrag(e: React.DragEvent) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `group:${group.key}`);
    store.setDragState({ kind: "group", groupKey: group.key });
  }

  function handleDragEnd() {
    store.setDragState(null);
    store.setDropIndicator(null);
  }

  function handleHeaderDragOver(e: React.DragEvent) {
    const ds = store.dragState;
    if (!ds) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (ds.kind === "group") {
      if (ds.groupKey === group.key) {
        store.setDropIndicator(null);
        return;
      }
      const rect = e.currentTarget.getBoundingClientRect();
      const after = e.clientY - rect.top > rect.height / 2;
      store.setDropIndicator({ kind: after ? "after-group" : "before-group", groupKey: group.key });
    } else {
      store.setDropIndicator({ kind: "group-end", groupKey: group.key });
    }
  }

  function handleHeaderDrop(e: React.DragEvent) {
    e.preventDefault();
    const ds = store.dragState;
    const ind = store.dropIndicator;
    store.setDragState(null);
    store.setDropIndicator(null);
    if (!ds) return;
    if (ds.kind === "group") {
      if (ind && (ind.kind === "before-group" || ind.kind === "after-group")) {
        void store.reorderGroup(ds.groupKey, ind);
      }
    } else {
      onDrop(group.key);
    }
  }

  function handleBodyDragOver(e: React.DragEvent) {
    if (store.dragState?.kind !== "accounts") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    store.setDropIndicator({ kind: "group-end", groupKey: group.key });
  }

  function handleBodyDrop(e: React.DragEvent) {
    e.preventDefault();
    const ds = store.dragState;
    store.setDragState(null);
    store.setDropIndicator(null);
    if (ds?.kind === "accounts") onDrop(group.key);
  }

  const groupIds = group.accounts.map((a) => a.UserID);
  const allSelected = groupIds.length > 0 && groupIds.every((id) => store.selectedIds.has(id));
  const someSelected = groupIds.some((id) => store.selectedIds.has(id));
  const multiMode = store.selectedIds.size > 1;

  function handleGroupCheckbox(e: React.MouseEvent) {
    e.stopPropagation();
    if (allSelected) {
      const next = new Set(store.selectedIds);
      groupIds.forEach((id) => next.delete(id));
      store.setSelectedIds(next);
    } else {
      const next = new Set(store.selectedIds);
      groupIds.forEach((id) => next.add(id));
      store.setSelectedIds(next);
    }
  }

  return (
    <div className="mb-0.5">
      {showHeader && (
        <div
          data-group-header="true"
          data-group-key={group.key}
          tabIndex={0}
          onFocus={onHeaderFocus}
          onBlur={onHeaderBlur}
          draggable={headerDraggable}
          onDragStart={headerDraggable ? startGroupDrag : undefined}
          onDragEnd={handleDragEnd}
          className={`group/gh theme-group-header relative flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none text-xs outline-none transition-all duration-150 ${
            store.dragState ? "hover:bg-[var(--accent-soft)] hover:pl-4" : "hover:bg-[var(--row-hover)]"
          }`}
          onClick={onToggle}
          onDragOver={handleHeaderDragOver}
          onDrop={handleHeaderDrop}
        >
          {reorderStyle === "handle" && (
            <div
              draggable
              onDragStart={startGroupDrag}
              onDragEnd={handleDragEnd}
              onClick={(e) => e.stopPropagation()}
              title={t("Drag to reorder")}
              aria-label={t("Drag to reorder group")}
              className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-0.5 opacity-0 group-hover/gh:opacity-100 transition-opacity duration-100 cursor-grab active:cursor-grabbing theme-muted hover:text-[var(--panel-fg)]"
            >
              <GripVertical size={12} strokeWidth={1.5} />
            </div>
          )}
          <div className={`shrink-0 overflow-hidden transition-all duration-150 ease-out ${
            multiMode ? "w-3.5 opacity-100" : "w-0 opacity-0"
          }`}>
            <div
              className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-all duration-100 cursor-pointer ${
                allSelected ? "" : someSelected ? "" : "theme-border group-hover:brightness-110"
              }`}
              style={
                allSelected
                  ? { backgroundColor: "var(--accent-color)", borderColor: "var(--accent-color)" }
                  : someSelected
                  ? { backgroundColor: "var(--accent-soft)", borderColor: "var(--accent-strong)" }
                  : undefined
              }
              onClick={handleGroupCheckbox}
            >
              {allSelected && (
                <Check size={8} stroke="var(--forms-bg)" strokeWidth={3.5} />
              )}
              {someSelected && !allSelected && (
                <div className="w-1.5 h-1.5 rounded-sm bg-[var(--accent-color)]" />
              )}
            </div>
          </div>
          <ChevronRight size={12} fill="currentColor" stroke="none" className={`theme-muted transition-transform duration-200 ${collapsed ? "" : "rotate-90"}`} />
          <span className="theme-label font-medium">{group.displayName === "Default" ? t("Default") : group.displayName}</span>
          <span className="theme-muted text-[10px] tabular-nums">{group.accounts.length}</span>
        </div>
      )}

      <div
        className={`overflow-hidden transition-all duration-200 ${
          showHeader && collapsed ? "max-h-0 opacity-0" : "max-h-[9999px] opacity-100"
        }`}
        onDragOver={!showHeader ? handleBodyDragOver : undefined}
        onDrop={!showHeader ? handleBodyDrop : undefined}
      >
        {group.accounts.map((account) => (
          <AccountRow key={account.UserID} account={account} />
        ))}
      </div>
    </div>
  );
}
