import { useState } from "react";
import type { RecentJobEntry, RecentJobKind } from "./types";
import { loadRecentJobs, saveRecentJobs, updateRecentJob, removeRecentJob } from "./types";
import { useTr } from "../../i18n/text";
import { Pin, X, Pencil, Check } from "lucide-react";

export interface RecentJobsListProps {
  onSelect: (raw: string) => void;
}

function kindBadge(kind: RecentJobKind, t: (s: string) => string): { label: string; className: string } {
  switch (kind) {
    case "vip":
      return { label: "VIP", className: "border-amber-500/30 bg-amber-500/10 text-amber-300" };
    case "link":
      return { label: t("Link"), className: "border-violet-500/30 bg-violet-500/10 text-violet-300" };
    default:
      return { label: t("Job"), className: "border-zinc-600/40 bg-zinc-700/20 text-zinc-400" };
  }
}

function shortRaw(raw: string): string {
  if (raw.length <= 26) return raw;
  return `${raw.slice(0, 12)}…${raw.slice(-10)}`;
}

export function RecentJobsList({ onSelect }: RecentJobsListProps) {
  const t = useTr();
  const [entries, setEntries] = useState<RecentJobEntry[]>(loadRecentJobs);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  function refresh() {
    setEntries(loadRecentJobs());
  }

  function commitEdit(raw: string, kind: RecentJobKind) {
    updateRecentJob(raw, kind, { label: editValue.trim() });
    setEditing(null);
    refresh();
  }

  function handleClear() {
    saveRecentJobs(loadRecentJobs().filter((e) => e.pinned));
    refresh();
  }

  function formatTime(ts: number) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return t("{{count}}d ago", { count: days });
    if (hours > 0) return t("{{count}}h ago", { count: hours });
    if (mins > 0) return t("{{count}}m ago", { count: mins });
    return t("just now");
  }

  const sorted = [...entries].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.lastUsed - a.lastUsed;
  });

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-8">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="text-zinc-800 mb-3">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <p className="text-xs text-zinc-700">{t("No recent servers")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-[10px] text-zinc-600">
          {t("{{count}} saved", { count: sorted.length })}
        </span>
        <button
          onClick={handleClear}
          className="text-[10px] text-zinc-600 hover:text-red-400 transition-colors"
        >
          {t("Clear unpinned")}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-1 px-1 pb-1">
          {sorted.map((entry) => {
            const badge = kindBadge(entry.kind, t);
            const key = `${entry.kind}:${entry.raw}`;
            const isEditing = editing === key;
            return (
              <div
                key={key}
                className="group flex w-full items-center gap-2 rounded-lg p-2 transition-colors hover:bg-zinc-800/50"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => onSelect(entry.raw)}
                  title={entry.raw}
                >
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium ${badge.className}`}>
                    {badge.label}
                  </span>
                  <span className="min-w-0 flex-1">
                    {isEditing ? null : (
                      <>
                        <span className="block truncate text-[12px] leading-tight text-zinc-200">
                          {entry.label ||
                            (entry.kind === "job"
                              ? t("Job ID")
                              : t("Private server"))}
                          {entry.placeId ? (
                            <span className="text-zinc-600"> · {entry.placeId}</span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-600">
                          {shortRaw(entry.raw)}
                        </span>
                      </>
                    )}
                  </span>
                </button>
                {isEditing ? (
                  <>
                    <input
                      value={editValue}
                      autoFocus
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit(entry.raw, entry.kind);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      placeholder={t("Name")}
                      className="sidebar-input flex-1 min-w-0 text-[11px]"
                    />
                    <button
                      type="button"
                      onClick={() => commitEdit(entry.raw, entry.kind)}
                      className="shrink-0 p-1 rounded text-emerald-400 hover:bg-emerald-500/10"
                      aria-label={t("Save name")}
                    >
                      <Check size={12} strokeWidth={2} />
                    </button>
                  </>
                ) : (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <span className="whitespace-nowrap text-[10px] tabular-nums text-zinc-600 group-hover:hidden">
                      {formatTime(entry.lastUsed)}
                    </span>
                    <span className="hidden items-center gap-0.5 group-hover:flex">
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(key);
                          setEditValue(entry.label || "");
                        }}
                        className="p-1 rounded text-zinc-500 hover:text-zinc-200"
                        aria-label={t("Rename")}
                      >
                        <Pencil size={11} strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          updateRecentJob(entry.raw, entry.kind, { pinned: !entry.pinned });
                          refresh();
                        }}
                        className={`p-1 rounded ${
                          entry.pinned ? "text-amber-300" : "text-zinc-500 hover:text-zinc-200"
                        }`}
                        aria-label={entry.pinned ? t("Unpin") : t("Pin")}
                      >
                        <Pin size={11} strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          removeRecentJob(entry.raw, entry.kind);
                          refresh();
                        }}
                        className="p-1 rounded text-zinc-500 hover:text-red-400"
                        aria-label={t("Remove")}
                      >
                        <X size={11} strokeWidth={1.75} />
                      </button>
                    </span>
                  </span>
                )}
                {entry.pinned && !isEditing ? (
                  <Pin size={10} strokeWidth={2} className="shrink-0 text-amber-300 group-hover:hidden" />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
