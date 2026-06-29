import { Check, ChevronRight } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { useSortable, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStore } from "../../store";
import type { Account } from "../../types";
import { SortableAccountRow } from "./AccountRow";
import { useTr } from "../../i18n/text";

export function GroupSection({
  groupKey,
  displayName,
  accounts,
  collapsed,
  onToggle,
  onHeaderFocus,
  onHeaderBlur,
}: {
  groupKey: string;
  displayName: string;
  accounts: Account[];
  collapsed: boolean;
  onToggle: () => void;
  onHeaderFocus?: () => void;
  onHeaderBlur?: () => void;
}) {
  const t = useTr();
  const store = useStore();
  const showHeader = groupKey !== "__all__" && store.showGroups && (store.theme?.show_headers ?? true);

  const sortable = useSortable({ id: `g:${groupKey}`, disabled: !store.reorderMode || !showHeader });
  const droppable = useDroppable({ id: groupKey });

  const groupIds = accounts.map((a) => a.UserID);
  const allSelected = groupIds.length > 0 && groupIds.every((id) => store.selectedIds.has(id));
  const someSelected = groupIds.some((id) => store.selectedIds.has(id));
  const multiMode = store.selectedIds.size > 1;

  function handleGroupCheckbox(e: React.MouseEvent) {
    e.stopPropagation();
    const next = new Set(store.selectedIds);
    if (allSelected) groupIds.forEach((id) => next.delete(id));
    else groupIds.forEach((id) => next.add(id));
    store.setSelectedIds(next);
  }

  const rootStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    ...(sortable.isDragging ? { opacity: 0.5, zIndex: 1, position: "relative" } : {}),
  };

  const headerProps: Record<string, unknown> = store.reorderMode
    ? { ...sortable.attributes, ...sortable.listeners }
    : { role: "button", tabIndex: 0 };

  return (
    <div ref={sortable.setNodeRef} style={rootStyle} className="mb-0.5">
      {showHeader && (
        <div
          data-group-header="true"
          data-group-key={groupKey}
          aria-expanded={!collapsed}
          onFocus={onHeaderFocus}
          onBlur={onHeaderBlur}
          className={`group/gh theme-group-header relative flex items-center gap-2 px-3 py-1.5 select-none text-xs outline-none transition-all duration-150 ${
            store.reorderMode ? "cursor-grab active:cursor-grabbing" : "cursor-pointer hover:bg-[var(--row-hover)]"
          }`}
          onClick={onToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggle();
            }
          }}
          {...headerProps}
        >
          <div
            className={`shrink-0 overflow-hidden transition-all duration-150 ease-out ${
              multiMode ? "w-3.5 opacity-100" : "w-0 opacity-0"
            }`}
          >
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
              {allSelected && <Check size={8} stroke="var(--forms-bg)" strokeWidth={3.5} />}
              {someSelected && !allSelected && <div className="w-1.5 h-1.5 rounded-sm bg-[var(--accent-color)]" />}
            </div>
          </div>
          <ChevronRight
            size={12}
            fill="currentColor"
            stroke="none"
            className={`theme-muted transition-transform duration-200 ${collapsed ? "" : "rotate-90"}`}
          />
          <span className="theme-label font-medium">{displayName === "Default" ? t("Default") : displayName}</span>
          <span className="theme-muted text-[10px] tabular-nums">{accounts.length}</span>
        </div>
      )}

      <div
        ref={droppable.setNodeRef}
        className={`overflow-hidden transition-all duration-200 ${
          showHeader && collapsed ? "max-h-0 opacity-0" : "max-h-[9999px] opacity-100"
        }`}
      >
        <SortableContext items={collapsed ? [] : groupIds} strategy={verticalListSortingStrategy}>
          {!collapsed && accounts.map((account) => <SortableAccountRow key={account.UserID} account={account} />)}
          {!collapsed && accounts.length === 0 && store.reorderMode && (
            <div className="px-3 py-2 text-[11px] theme-muted italic">{t("Drop accounts here")}</div>
          )}
        </SortableContext>
      </div>
    </div>
  );
}
