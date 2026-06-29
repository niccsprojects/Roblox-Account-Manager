import { Check, User } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useStore } from "../../store";
import type { Account } from "../../types";
import { timeAgo, getFreshnessColor } from "../../types";
import { Tooltip } from "../ui/Tooltip";
import { useTr } from "../../i18n/text";

function maskName(name: string, previewLetters: number): string {
  if (previewLetters > 0 && previewLetters < name.length) {
    return name.slice(0, previewLetters) + "********";
  }
  return "************";
}

export function SortableAccountRow({ account }: { account: Account }) {
  const store = useStore();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: account.UserID,
    disabled: !store.reorderMode,
  });
  return (
    <AccountRowView
      account={account}
      setNodeRef={setNodeRef}
      dragStyle={{ transform: CSS.Transform.toString(transform), transition }}
      handleProps={store.reorderMode ? { ...attributes, ...listeners } : undefined}
      dimmed={isDragging}
    />
  );
}

export function AccountRowView({
  account,
  setNodeRef,
  dragStyle,
  handleProps,
  dimmed,
  overlay,
}: {
  account: Account;
  setNodeRef?: (el: HTMLElement | null) => void;
  dragStyle?: React.CSSProperties;
  handleProps?: Record<string, unknown>;
  dimmed?: boolean;
  overlay?: boolean;
}) {
  const t = useTr();
  const store = useStore();
  const selected = store.selectedIds.has(account.UserID);
  const multiMode = store.selectedIds.size > 1;
  const avatarUrl = store.avatarUrls.get(account.UserID);
  const freshness =
    store.settings?.General?.DisableAgingAlert === "true" ? null : getFreshnessColor(account.LastUse);
  const rawName = account.Alias || account.Username;
  const displayName = store.hideUsernames ? maskName(rawName, store.hiddenNameLetters) : rawName;
  const showUsername = !!account.Alias && !store.hideUsernames;
  const description = account.Description?.trim() || "";
  const hideAvatar = store.hideUsernames && !store.showAvatarsWhenHidden;
  const showPresence = store.settings?.General?.ShowPresence === "true";
  const presenceType = store.presenceByUserId.get(account.UserID) ?? 0;
  const launchedLocally = store.launchedByProgram.has(account.UserID);
  const isJoining = store.joiningAccounts.has(account.UserID);

  const presenceMeta =
    presenceType === 3
      ? { label: t("In Studio"), dotClass: "bg-violet-500", dotStyle: undefined as React.CSSProperties | undefined }
      : presenceType >= 2
      ? { label: t("In Game"), dotClass: "bg-emerald-500", dotStyle: undefined as React.CSSProperties | undefined }
      : presenceType === 1
        ? { label: t("Online"), dotClass: "bg-sky-500", dotStyle: undefined as React.CSSProperties | undefined }
        : { label: t("Offline"), dotClass: "", dotStyle: { backgroundColor: "var(--panel-muted)" } };

  const statusDots: Array<{ color: string; title: string }> = [];
  if (!account.Valid) statusDots.push({ color: "#ef4444", title: t("Invalid session") });
  if (freshness) statusDots.push({ color: freshness, title: t("Aged account (20+ days inactive)") });
  if (launchedLocally) statusDots.push({ color: "#f59e0b", title: t("Launched by Roblox Account Manager") });
  if (showPresence && presenceType >= 1) {
    const presenceColor = presenceType === 3 ? "#4629d8" : presenceType >= 2 ? "#02b757" : "#00a2ff";
    statusDots.push({ color: presenceColor, title: presenceMeta.label });
  }

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    store.handleSelect(account.UserID, e);
  }

  function handleContext(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!store.selectedIds.has(account.UserID)) store.selectSingle(account.UserID);
    store.openContextMenu(e.clientX, e.clientY);
  }

  const cursor = overlay
    ? "cursor-grabbing"
    : store.reorderMode
    ? "cursor-grab active:cursor-grabbing"
    : "cursor-default";

  const style: React.CSSProperties = {
    ...(dragStyle || {}),
    ...(selected ? { borderLeftColor: "var(--accent-color)" } : {}),
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-account-row="true"
      data-user-id={account.UserID}
      className={`group/row theme-row-hover relative flex items-center gap-3 px-3 py-1.5 select-none border-l-2 transition-colors duration-100 ${cursor} ${
        selected ? "theme-row-selected" : "border-l-transparent"
      } ${dimmed ? "opacity-40" : ""} ${
        overlay ? "theme-panel rounded-lg shadow-2xl ring-1 ring-[var(--accent-strong)]" : ""
      }`}
      onClick={overlay ? undefined : handleClick}
      onContextMenu={overlay ? undefined : handleContext}
      {...(overlay ? {} : handleProps ?? {})}
    >
      <div
        className={`shrink-0 overflow-hidden transition-all duration-150 ease-out ${
          multiMode ? "w-4 opacity-100" : "w-0 opacity-0"
        }`}
      >
        <div
          className={`w-4 h-4 rounded border flex items-center justify-center transition-all duration-100 ${
            selected ? "" : "theme-border group-hover/row:brightness-110"
          }`}
          style={
            selected ? { backgroundColor: "var(--accent-color)", borderColor: "var(--accent-color)" } : undefined
          }
        >
          {selected && <Check size={10} stroke="var(--forms-bg)" strokeWidth={3} />}
        </div>
      </div>

      <div className="relative flex-shrink-0">
        {statusDots.length > 0 && (
          <div className="absolute -left-1.5 -top-1 z-10 flex items-center gap-0.5">
            {statusDots.map((dot, index) => (
              <Tooltip key={index} content={dot.title} side="bottom">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ boxShadow: "0 0 0 1px var(--app-bg)", backgroundColor: dot.color }}
                />
              </Tooltip>
            ))}
          </div>
        )}
        {hideAvatar ? (
          <div className="theme-avatar w-8 h-8 rounded-full bg-[var(--panel-soft)] flex items-center justify-center theme-muted">
            <User size={14} strokeWidth={1.5} />
          </div>
        ) : avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="theme-avatar w-8 h-8 rounded-full bg-[var(--panel-soft)] transition-transform duration-150 group-hover/row:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="theme-avatar w-8 h-8 rounded-full bg-[var(--panel-soft)] flex items-center justify-center theme-muted text-xs font-medium">
            {(account.Username || "?").charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      <div data-row-marquee-surface="true" className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {showPresence && presenceType >= 1 && (
            <Tooltip content={presenceMeta.label} side="bottom">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${presenceMeta.dotClass} ${
                  presenceType >= 1 ? "animate-pulse" : ""
                }`}
                style={presenceMeta.dotStyle}
              />
            </Tooltip>
          )}
          <div
            className={`text-[13px] truncate leading-tight transition-colors duration-100 ${
              selected ? "theme-accent" : "text-[var(--panel-fg)]"
            }`}
          >
            {displayName}
          </div>
        </div>
        {showUsername && <div className="text-[11px] theme-muted truncate leading-tight">@{account.Username}</div>}
      </div>

      {description && (
        <div className="min-w-0 max-w-[38%]">
          <Tooltip content={description}>
            <div className="text-[11px] theme-muted truncate leading-tight text-right">{description}</div>
          </Tooltip>
        </div>
      )}

      <div className="text-[11px] w-14 text-right flex-shrink-0 tabular-nums">
        {isJoining ? (
          <span className="inline-flex items-center gap-1 theme-accent">
            <span className="w-2 h-2 border border-[var(--accent-color)] border-t-transparent rounded-full animate-spin" />
            <span>{t("Join")}</span>
          </span>
        ) : (
          <span className="theme-muted">{timeAgo(account.LastUse)}</span>
        )}
      </div>
    </div>
  );
}
