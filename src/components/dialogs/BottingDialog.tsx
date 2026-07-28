import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../store";
import { useModalClose } from "../../hooks/useModalClose";
import { useTr } from "../../i18n/text";
import { Tooltip } from "../ui/Tooltip";
import { NumericInput } from "../ui/NumericInput";
import { X, ChevronDown, Check } from "lucide-react";

interface BottingDialogProps {
  open: boolean;
  onClose: () => void;
}

type BottingRowAction = "disconnect" | "close" | "closeDisconnect" | "restartClient" | "restartLoop";

function ThemedCheckbox({
  checked,
  disabled,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className="theme-check"
    >
      <Check size={11} strokeWidth={3} className="theme-check-icon" />
    </button>
  );
}

function canRunBottingActionOnRow(
  row: { disconnected?: boolean; isPlayer?: boolean } | null,
  action: BottingRowAction
): boolean {
  if (!row) return false;
  if (action === "disconnect" || action === "closeDisconnect") {
    return !row.disconnected && !row.isPlayer;
  }
  if (action === "restartClient") {
    return !row.disconnected;
  }
  return true;
}

function formatCountdown(targetMs: number | null, nowMs: number): string {
  if (targetMs === null) return "--";
  if (targetMs <= nowMs) return "due";
  const secs = Math.ceil((targetMs - nowMs) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDueTime(targetMs: number | null): string {
  if (targetMs === null) return "--";
  return new Date(targetMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function phaseTone(phase: string): string {
  const p = phase.toLowerCase();
  if (p.includes("disconnected")) return "text-zinc-300";
  if (p.includes("player")) return "text-sky-300";
  if (p.includes("retry") || p.includes("backoff")) return "text-amber-300";
  if (p.includes("error")) return "text-red-300";
  if (p.includes("launch") || p.includes("restart")) return "text-violet-300";
  if (p.includes("wait")) return "text-cyan-300";
  return "text-emerald-300";
}

function isMultiRobloxCloseProcessError(message: string | null | undefined): boolean {
  const lower = (message || "").toLowerCase();
  return (
    lower.includes("failed to enable multi roblox") ||
    (lower.includes("multi roblox") && lower.includes("close all roblox process"))
  );
}

export function BottingDialog({ open, onClose }: BottingDialogProps) {
  const t = useTr();
  const store = useStore();
  const { visible, closing, handleClose } = useModalClose(open, onClose);
  const selectedAccounts = store.selectedAccounts;
  const selectedIds = useMemo(
    () => selectedAccounts.map((a) => a.UserID),
    [selectedAccounts]
  );
  const accountById = useMemo(
    () => new Map(store.accounts.map((a) => [a.UserID, a])),
    [store.accounts]
  );
  const status = store.bottingStatus;
  const [placeId, setPlaceId] = useState("");
  const [jobId, setJobId] = useState("");
  const [launchData, setLaunchData] = useState("");
  const [shareLaunchFields, setShareLaunchFields] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(19);
  const [launchDelaySeconds, setLaunchDelaySeconds] = useState(20);
  const [playerGraceMinutes, setPlayerGraceMinutes] = useState(15);
  const [playerUserIds, setPlayerUserIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkSelectedUserIds, setBulkSelectedUserIds] = useState<number[]>([]);
  const [bottingStartError, setBottingStartError] = useState<string | null>(null);
  const [closingRoblox, setClosingRoblox] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [playerMenuOpen, setPlayerMenuOpen] = useState(false);
  const [bottingLayout, setBottingLayout] = useState<"split" | "classic">("split");
  const playerMenuRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      let general = store.settings?.General || {};
      try {
        const fresh = await invoke<Record<string, Record<string, string>>>("get_all_settings");
        if (fresh?.General) {
          general = fresh.General;
        }
      } catch {}
      if (cancelled) return;

      const shouldShareLaunchFields = general.BottingAutoShareLaunchFields === "true";
      const draftPlace = shouldShareLaunchFields
        ? store.placeId || ""
        : general.BottingDraftPlaceId || store.placeId || "";
      const draftJob = shouldShareLaunchFields
        ? store.jobId || ""
        : general.BottingDraftJobId || store.jobId || "";
      const draftData = shouldShareLaunchFields
        ? store.launchData || ""
        : general.BottingDraftLaunchData || store.launchData || "";
      const draftInterval = parseInt(general.BottingDefaultIntervalMinutes || "19", 10);
      const draftDelay = parseInt(general.BottingLaunchDelaySeconds || "20", 10);
      const draftGrace = parseInt(
        general.BottingPlayerGraceMinutes || String(status?.playerGraceMinutes ?? 15),
        10
      );
      const draftPlayerIdsRaw =
        general.BottingDraftPlayerAccountIds || general.BottingDraftPlayerAccountId || "";
      const draftPlayerIds = draftPlayerIdsRaw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
      const dualPanelEnabled = general.BottingDualPanelDialog !== "false";

      setShareLaunchFields(shouldShareLaunchFields);
      setPlaceId(draftPlace);
      setJobId(draftJob);
      setLaunchData(draftData);
      setIntervalMinutes(Number.isFinite(draftInterval) ? draftInterval : 19);
      setLaunchDelaySeconds(Number.isFinite(draftDelay) ? draftDelay : 20);
      setPlayerGraceMinutes(Number.isFinite(draftGrace) ? draftGrace : 15);
      setPlayerUserIds(draftPlayerIds.filter((id) => selectedIds.includes(id)));
      setBottingLayout(dualPanelEnabled ? "split" : "classic");
    })();

    return () => {
      cancelled = true;
    };
  }, [
    selectedIds,
    status?.playerGraceMinutes,
    store.jobId,
    store.launchData,
    store.placeId,
    store.settings,
    visible,
  ]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (!visible || !status?.active) return;
    if (typeof status.playerGraceMinutes === "number" && status.playerGraceMinutes > 0) {
      setPlayerGraceMinutes(status.playerGraceMinutes);
    }
  }, [status?.active, status?.playerGraceMinutes, visible]);

  useEffect(() => {
    if (!visible) return;
    setPlayerMenuOpen(false);
  }, [visible]);

  useEffect(() => {
    if (!playerMenuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (!playerMenuRef.current) return;
      if (!playerMenuRef.current.contains(e.target as Node)) {
        setPlayerMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [playerMenuOpen]);

  async function saveDraft(
    nextPlaceId: string,
    nextJobId: string,
    nextLaunchData: string,
    nextPlayers: number[],
    nextInterval: number,
    nextDelay: number,
    nextGraceMinutes: number
  ) {
    const updates = [
      invoke("update_setting", {
        section: "General",
        key: "BottingDraftPlaceId",
        value: nextPlaceId,
      }),
      invoke("update_setting", {
        section: "General",
        key: "BottingDraftJobId",
        value: nextJobId,
      }),
      invoke("update_setting", {
        section: "General",
        key: "BottingDraftLaunchData",
        value: nextLaunchData,
      }),
      invoke("update_setting", {
        section: "General",
        key: "BottingDraftPlayerAccountIds",
        value: nextPlayers.join(","),
      }),
      invoke("update_setting", {
        section: "General",
        key: "BottingDraftSelectedUserIds",
        value: selectedIds.join(","),
      }),
      invoke("update_setting", {
        section: "General",
        key: "BottingDefaultIntervalMinutes",
        value: String(nextInterval),
      }),
      invoke("update_setting", {
        section: "General",
        key: "BottingLaunchDelaySeconds",
        value: String(nextDelay),
      }),
      invoke("update_setting", {
        section: "General",
        key: "BottingPlayerGraceMinutes",
        value: String(nextGraceMinutes),
      }),
    ];
    await Promise.all(updates.map((p) => p.catch(() => {})));
  }

  async function handleStart() {
    setBottingStartError(null);
    const pid = parseInt(placeId.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      store.addToast(t("Place ID is required"));
      return;
    }
    const multiRbxEnabled = store.settings?.General?.EnableMultiRbx === "true";
    if (!multiRbxEnabled) {
      const msg = t("Botting Mode currently requires Multi Roblox to be enabled");
      setBottingStartError(msg);
      store.addToast(msg);
      return;
    }
    if (selectedIds.length < 2) {
      store.addToast(t("Select at least 2 accounts"));
      return;
    }
    setBusy(true);
    try {
      await saveDraft(
        placeId.trim(),
        jobId.trim(),
        launchData,
        playerUserIds,
        intervalMinutes,
        launchDelaySeconds,
        playerGraceMinutes
      );
      await store.startBottingMode({
        userIds: selectedIds,
        placeId: pid,
        jobId: jobId.trim(),
        launchData,
        playerUserIds,
        intervalMinutes,
        launchDelaySeconds,
        playerGraceMinutes,
      });
    } catch (e) {
      setBottingStartError(String(e));
      store.addToast(
        t("Botting start failed: {{error}}", {
          error: String(e),
        })
      );
    }
    setBusy(false);
  }

  async function handleTogglePlayer(userId: number) {
    const next = playerUserIds.includes(userId)
      ? playerUserIds.filter((id) => id !== userId)
      : [...playerUserIds, userId];
    setPlayerUserIds(next);
    await saveDraft(
      placeId.trim(),
      jobId.trim(),
      launchData,
      next,
      intervalMinutes,
      launchDelaySeconds,
      playerGraceMinutes
    );
    if (status?.active) {
      await store.setBottingPlayerAccounts(next);
    }
  }

  async function runRowAction(userId: number, action: BottingRowAction) {
    if (actionButtonsLocked) return;
    setRowBusy(userId);
    try {
      await store.bottingAccountAction(userId, action);
    } catch (e) {
      store.addToast(
        t("Botting account action failed: {{error}}", {
          error: String(e),
        })
      );
    } finally {
      setRowBusy(null);
    }
  }

  async function runRowFocus(userId: number) {
    if (actionButtonsLocked) return;
    setRowBusy(userId);
    try {
      const focused = await store.focusRobloxClient(userId);
      if (!focused) {
        store.addToast(t("No active Roblox window found for this account"));
      }
    } catch (e) {
      store.addToast(t("Failed to focus client: {{error}}", { error: String(e) }));
    } finally {
      setRowBusy(null);
    }
  }

  async function handleCloseRobloxBannerAction() {
    if (closingRoblox) return;
    setClosingRoblox(true);
    try {
      await store.killAllRobloxProcesses();
      setBottingStartError(null);
    } finally {
      setClosingRoblox(false);
    }
  }

  function handleLayoutModeChange(nextLayout: "split" | "classic") {
    if (nextLayout === bottingLayout) return;
    setBottingLayout(nextLayout);
    void invoke("update_setting", {
      section: "General",
      key: "BottingDualPanelDialog",
      value: nextLayout === "split" ? "true" : "false",
    }).catch(() => {});
  }

  const statusMap = new Map((status?.accounts || []).map((a) => [a.userId, a]));
  const multiRbxEnabled = store.settings?.General?.EnableMultiRbx === "true";
  const useSplitLayout = bottingLayout === "split";
  const liveUserIds = status?.active && (status.userIds?.length || 0) > 0
    ? status.userIds
    : selectedIds;
  const liveRows = liveUserIds.map((userId) => ({
    userId,
    account: accountById.get(userId) || null,
    row: statusMap.get(userId) || null,
  }));
  const uiActionLocked = busy || bulkBusy || rowBusy !== null;
  const canStart = selectedIds.length >= 2 && !!placeId.trim() && !uiActionLocked && multiRbxEnabled;
  const dialogError = bottingStartError || store.error || null;
  const rowConflictError =
    (status?.accounts || [])
      .map((a) => a.lastError)
      .find((msg) => isMultiRobloxCloseProcessError(msg)) || null;
  const closeRobloxAlertMessage = isMultiRobloxCloseProcessError(dialogError)
    ? dialogError
    : rowConflictError;
  const showCloseRobloxAction = !!closeRobloxAlertMessage;
  const playerAccountLabel = playerUserIds.length === 0
    ? t("None")
    : playerUserIds.length === 1
      ? accountById.get(playerUserIds[0])?.Alias ||
        accountById.get(playerUserIds[0])?.Username ||
        t("Unknown")
      : t("{{count}} selected", { count: playerUserIds.length });
  const splitPlayersCount = liveRows.filter(
    ({ userId, row }) => !!row?.isPlayer || playerUserIds.includes(userId)
  ).length;
  const splitDisconnectedCount = liveRows.filter(({ row }) => !!row?.disconnected).length;
  const splitRetryingCount = liveRows.filter(({ row }) => (row?.retryCount || 0) >= 2).length;
  const actionButtonsLocked = uiActionLocked;
  const bulkSelectedSet = useMemo(() => new Set(bulkSelectedUserIds), [bulkSelectedUserIds]);
  const liveUserIdSet = useMemo(() => new Set(liveUserIds), [liveUserIds]);
  const liveRowsByUserId = useMemo(
    () => new Map(liveRows.map(({ userId, row }) => [userId, row])),
    [liveRows]
  );
  const allVisibleBulkSelected =
    liveRows.length > 0 && liveRows.every(({ userId }) => bulkSelectedSet.has(userId));
  const visibleBotRowIds = liveRows
    .filter(({ row }) => !!row && !row.isPlayer)
    .map(({ userId }) => userId);
  const bulkEligibleCounts = useMemo<Record<BottingRowAction, number>>(() => {
    const counts: Record<BottingRowAction, number> = {
      disconnect: 0,
      close: 0,
      closeDisconnect: 0,
      restartClient: 0,
      restartLoop: 0,
    };
    if (!status?.active) return counts;
    for (const userId of bulkSelectedUserIds) {
      const row = liveRowsByUserId.get(userId) || null;
      if (canRunBottingActionOnRow(row, "disconnect")) counts.disconnect += 1;
      if (canRunBottingActionOnRow(row, "close")) counts.close += 1;
      if (canRunBottingActionOnRow(row, "closeDisconnect")) counts.closeDisconnect += 1;
      if (canRunBottingActionOnRow(row, "restartClient")) counts.restartClient += 1;
      if (canRunBottingActionOnRow(row, "restartLoop")) counts.restartLoop += 1;
    }
    return counts;
  }, [bulkSelectedUserIds, liveRowsByUserId, status?.active]);

  function toggleBulkSelected(userId: number) {
    setBulkSelectedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  }

  function setBulkSelected(userIds: number[]) {
    setBulkSelectedUserIds(Array.from(new Set(userIds)));
  }

  async function runBulkAction(action: BottingRowAction) {
    if (!status?.active || actionButtonsLocked) return;
    const eligibleIds = bulkSelectedUserIds.filter((userId) =>
      canRunBottingActionOnRow(liveRowsByUserId.get(userId) || null, action)
    );
    if (eligibleIds.length === 0) {
      store.addToast(t("No selected accounts can run this action"));
      return;
    }

    setBulkBusy(true);
    let succeeded = 0;
    let failed = 0;
    try {
      for (const userId of eligibleIds) {
        setRowBusy(userId);
        try {
          await store.bottingAccountAction(userId, action);
          succeeded += 1;
        } catch {
          failed += 1;
        }
      }
    } finally {
      setRowBusy(null);
      setBulkBusy(false);
    }

    const actionLabel =
      action === "disconnect"
        ? t("Disconnect")
        : action === "close"
          ? t("Close client")
          : action === "restartClient"
            ? t("Restart client")
          : action === "closeDisconnect"
            ? t("Close + Disconnect")
            : t("Restart loop");

    if (failed === 0) {
      store.addToast(t("Applied {{action}} to {{count}} accounts", {
        action: actionLabel,
        count: succeeded,
      }));
    } else {
      store.addToast(t("Applied {{action}}: {{success}} succeeded, {{failed}} failed", {
        action: actionLabel,
        success: succeeded,
        failed,
      }));
    }
  }

  useEffect(() => {
    if (!visible || !showCloseRobloxAction) return;
    const node = contentRef.current;
    if (!node) return;
    node.scrollTo({ top: 0, behavior: "smooth" });
  }, [visible, showCloseRobloxAction, closeRobloxAlertMessage]);

  useEffect(() => {
    setBulkSelectedUserIds((prev) => {
      const next = prev.filter((id) => liveUserIdSet.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [liveUserIdSet]);

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm ${
        closing ? "animate-fade-out" : "animate-fade-in"
      }`}
      onClick={handleClose}
    >
      <div
        className={`theme-panel theme-border rounded-2xl border max-w-[calc(100vw-24px)] max-h-[calc(100vh-24px)] flex flex-col overflow-hidden shadow-2xl ${
          useSplitLayout ? "w-[1120px] h-[720px]" : "w-[820px] h-[640px]"
        } ${
          closing ? "animate-scale-out" : "animate-scale-in"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b theme-border flex items-center justify-between">
          <div className="text-[15px] font-semibold text-[var(--panel-fg)]">{t("Botting Mode")}</div>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-lg border theme-border p-1 theme-soft">
              <button
                type="button"
                onClick={() => handleLayoutModeChange("split")}
                className={`px-2.5 py-1 text-[11px] rounded-md transition ${
                  useSplitLayout
                    ? "theme-accent-bg theme-accent border theme-accent-border"
                    : "theme-muted hover:text-[var(--panel-fg)]"
                }`}
              >
                {t("New View")}
              </button>
              <button
                type="button"
                onClick={() => handleLayoutModeChange("classic")}
                className={`px-2.5 py-1 text-[11px] rounded-md transition ${
                  !useSplitLayout
                    ? "theme-accent-bg theme-accent border theme-accent-border"
                    : "theme-muted hover:text-[var(--panel-fg)]"
                }`}
              >
                {t("Classic")}
              </button>
            </div>
            <span
              className={`px-2 py-1 rounded-full text-[10px] border ${
                status?.active
                  ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300 animate-pulse"
                  : "theme-border theme-soft theme-muted"
              }`}
            >
              {status?.active ? t("RUNNING") : t("IDLE")}
            </span>
            <button
              onClick={handleClose}
              className="p-1 rounded-md theme-muted hover:text-[var(--panel-fg)] transition-colors"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div
          ref={contentRef}
          className={`p-4 md:p-5 flex-1 min-h-0 ${
            useSplitLayout ? "overflow-hidden flex flex-col gap-3" : "overflow-y-auto space-y-3"
          }`}
        >
          {showCloseRobloxAction && closeRobloxAlertMessage && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-300 flex items-center justify-between animate-fade-in">
              <span className="truncate pr-2">{closeRobloxAlertMessage}</span>
              <div className="ml-2 flex items-center gap-2 shrink-0">
                <button
                  onClick={() => {
                    void handleCloseRobloxBannerAction();
                  }}
                  disabled={closingRoblox}
                  className="px-2 py-1 rounded-md bg-red-500/20 border border-red-500/30 text-red-200 hover:bg-red-500/30 active:bg-red-500/40 active:scale-[0.98] transition disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {t("Close Roblox")}
                </button>
                <button
                  onClick={() => {
                    setBottingStartError(null);
                    store.setError(null);
                  }}
                  className="text-red-500/60 hover:text-red-300 transition-colors"
                  aria-label={t("Close")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          )}
          {useSplitLayout ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1 min-h-0">
              <div className="lg:col-span-4 min-h-0 animate-slide-left">
                <div className="theme-surface rounded-2xl border theme-border h-full p-3 shadow-[0_22px_50px_rgba(0,0,0,0.23)] overflow-y-auto space-y-3">
                  <section
                    className={`theme-surface rounded-xl border theme-border p-3 relative ${
                      playerMenuOpen ? "z-30" : "z-10"
                    }`}
                  >
                    <div className="text-[13px] font-medium text-[var(--panel-fg)] mb-2">{t("Targets")}</div>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {selectedAccounts.map((a) => {
                        const isPlayer = playerUserIds.includes(a.UserID) || !!statusMap.get(a.UserID)?.isPlayer;
                        return (
                          <span
                            key={a.UserID}
                            className={[
                              "px-2 py-1 rounded-md text-[11px] border theme-soft",
                              isPlayer ? "theme-accent-bg theme-accent-border theme-accent" : "theme-border text-[var(--panel-fg)]",
                            ].join(" ")}
                          >
                            {a.Alias || a.Username}
                          </span>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] theme-muted w-24 shrink-0">{t("Player Accounts")}</label>
                      <div ref={playerMenuRef} className="relative w-full">
                        <button
                          type="button"
                          onClick={() => setPlayerMenuOpen((v) => !v)}
                          className="sidebar-input text-xs flex items-center justify-between gap-2 hover:brightness-110 transition-all"
                          aria-haspopup="listbox"
                          aria-expanded={playerMenuOpen}
                        >
                          <span className="truncate">{playerAccountLabel}</span>
                          <ChevronDown size={14} strokeWidth={2} className={`theme-muted transition-transform duration-150 ${playerMenuOpen ? "rotate-180" : ""}`} />
                        </button>
                        <div
                          className={`absolute left-0 right-0 top-[calc(100%+6px)] z-20 rounded-lg border theme-border theme-panel shadow-2xl overflow-hidden transition-all duration-150 ${
                            playerMenuOpen
                              ? "opacity-100 translate-y-0 pointer-events-auto"
                              : "opacity-0 -translate-y-1 pointer-events-none"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setPlayerUserIds([]);
                              void saveDraft(
                                placeId.trim(),
                                jobId.trim(),
                                launchData,
                                [],
                                intervalMinutes,
                                launchDelaySeconds,
                                playerGraceMinutes
                              );
                              if (status?.active) void store.setBottingPlayerAccounts([]);
                              setPlayerMenuOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-[12px] transition-colors ${
                              playerUserIds.length === 0
                                ? "theme-accent-bg theme-accent"
                                : "text-[var(--panel-fg)] hover:bg-[var(--panel-soft)]"
                            }`}
                          >
                            {t("None")}
                          </button>
                          <div className="h-px theme-border border-t" />
                          {selectedAccounts.map((a) => {
                            const active = playerUserIds.includes(a.UserID);
                            return (
                              <button
                                key={a.UserID}
                                type="button"
                                onClick={() => {
                                  void handleTogglePlayer(a.UserID);
                                }}
                                className={`w-full text-left px-3 py-2 text-[12px] transition-colors ${
                                  active
                                    ? "theme-accent-bg theme-accent"
                                    : "text-[var(--panel-fg)] hover:bg-[var(--panel-soft)]"
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="truncate">{a.Alias || a.Username}</span>
                                  {active ? (
                                    <span className="text-[11px] opacity-80">{t("Selected")}</span>
                                  ) : null}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </section>

                  <section className="theme-surface rounded-xl border theme-border p-3">
                    <div className="text-[13px] font-medium text-[var(--panel-fg)] mb-2">{t("Server")}</div>
                    <div className="grid grid-cols-1 gap-2">
                      <input
                        value={placeId}
                        onChange={(e) => {
                          const next = e.target.value;
                          setPlaceId(next);
                          if (shareLaunchFields) {
                            store.setPlaceId(next);
                          }
                        }}
                        onBlur={() =>
                          saveDraft(
                            placeId.trim(),
                            jobId.trim(),
                            launchData,
                            playerUserIds,
                            intervalMinutes,
                            launchDelaySeconds,
                            playerGraceMinutes
                          )
                        }
                        placeholder={t("Place ID")}
                        className="sidebar-input text-xs font-mono"
                      />
                      <input
                        value={jobId}
                        onChange={(e) => {
                          const next = e.target.value;
                          setJobId(next);
                          if (shareLaunchFields) {
                            store.setJobId(next);
                          }
                        }}
                        onBlur={() =>
                          saveDraft(
                            placeId.trim(),
                            jobId.trim(),
                            launchData,
                            playerUserIds,
                            intervalMinutes,
                            launchDelaySeconds,
                            playerGraceMinutes
                          )
                        }
                        placeholder={t("Job ID (optional)")}
                        className="sidebar-input text-xs font-mono"
                      />
                      <input
                        value={launchData}
                        onChange={(e) => {
                          const next = e.target.value;
                          setLaunchData(next);
                          if (shareLaunchFields) {
                            store.setLaunchData(next);
                          }
                        }}
                        onBlur={() =>
                          saveDraft(
                            placeId.trim(),
                            jobId.trim(),
                            launchData,
                            playerUserIds,
                            intervalMinutes,
                            launchDelaySeconds,
                            playerGraceMinutes
                          )
                        }
                        placeholder={t("JoinData (optional)")}
                        className="sidebar-input text-xs"
                      />
                    </div>
                    {shareLaunchFields ? (
                      <div className="mt-2 text-[10px] theme-muted">
                        {t("Launch fields are currently synced with Sidebar")}
                      </div>
                    ) : (
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => {
                            setPlaceId(store.placeId);
                            setJobId(store.jobId);
                            setLaunchData(store.launchData);
                          }}
                          className="sidebar-btn-sm"
                        >
                          {t("Use Current Launch Fields")}
                        </button>
                      </div>
                    )}
                  </section>

                  <section className="theme-surface rounded-xl border theme-border p-3">
                    <div className="text-[13px] font-medium text-[var(--panel-fg)] mb-2">{t("Timing")}</div>
                    <div className="grid grid-cols-1 gap-2">
                      <div className="flex items-center gap-2">
                        <label className="text-[11px] theme-muted w-32 shrink-0">{t("Rejoin Interval")}</label>
                        <NumericInput
                          value={intervalMinutes}
                          min={10}
                          max={480}
                          step={1}
                          integer
                          showStepper
                          onChange={setIntervalMinutes}
                          onCommit={(nextInterval) =>
                            saveDraft(
                              placeId.trim(),
                              jobId.trim(),
                              launchData,
                              playerUserIds,
                              nextInterval,
                              launchDelaySeconds,
                              playerGraceMinutes
                            )
                          }
                          className="sidebar-input text-xs pr-10"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-[11px] theme-muted w-32 shrink-0">{t("Launch Delay")}</label>
                        <NumericInput
                          value={launchDelaySeconds}
                          min={5}
                          max={120}
                          step={1}
                          integer
                          showStepper
                          onChange={setLaunchDelaySeconds}
                          onCommit={(nextDelay) =>
                            saveDraft(
                              placeId.trim(),
                              jobId.trim(),
                              launchData,
                              playerUserIds,
                              intervalMinutes,
                              nextDelay,
                              playerGraceMinutes
                            )
                          }
                          className="sidebar-input text-xs pr-10"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-[11px] theme-muted w-32 shrink-0">{t("Player Grace")}</label>
                        <NumericInput
                          value={playerGraceMinutes}
                          min={1}
                          max={90}
                          step={1}
                          integer
                          showStepper
                          onChange={setPlayerGraceMinutes}
                          onCommit={(nextGraceMinutes) =>
                            saveDraft(
                              placeId.trim(),
                              jobId.trim(),
                              launchData,
                              playerUserIds,
                              intervalMinutes,
                              launchDelaySeconds,
                              nextGraceMinutes
                            )
                          }
                          className="sidebar-input text-xs pr-10"
                        />
                      </div>
                    </div>
                    <div className="text-[10px] theme-muted mt-2">
                      {t("Player account demotion grace is {{minutes}} minutes before it enters normal restart cycle.", {
                        minutes: playerGraceMinutes,
                      })}
                    </div>
                    {!multiRbxEnabled ? (
                      <div className="text-[10px] text-amber-300 mt-1">
                        {t("Botting Mode currently requires Multi Roblox to be enabled")}
                      </div>
                    ) : null}
                  </section>

                  <section className="theme-surface rounded-xl border theme-border p-3">
                    <div className="text-[13px] font-medium text-[var(--panel-fg)] mb-2">{t("Controls")}</div>
                    <div className="grid grid-cols-1 gap-1.5">
                      <button
                        onClick={handleStart}
                        disabled={!canStart}
                        className="sidebar-btn-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t("Start Botting Mode")}
                      </button>
                      <button
                        onClick={() => store.stopBottingMode(false)}
                        disabled={actionButtonsLocked}
                        className="sidebar-btn-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t("Stop Botting Mode")}
                      </button>
                      <button
                        onClick={() => store.stopBottingMode(true)}
                        disabled={actionButtonsLocked}
                        className="sidebar-btn-sm text-red-200 border-red-400/40 hover:bg-red-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t("Stop + Close Bot Accounts")}
                      </button>
                    </div>
                  </section>
                </div>
              </div>

              <div className="lg:col-span-8 min-h-0 animate-slide-right">
                <section className="theme-surface rounded-2xl border theme-border h-full p-3 shadow-[0_22px_50px_rgba(0,0,0,0.23)] flex flex-col min-h-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[13px] font-medium text-[var(--panel-fg)]">{t("Live Botting List")}</div>
                      <div className="text-[10px] theme-muted mt-0.5">
                        {t("Track each account cycle, quick actions, and retry pressure in one place")}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <div className="rounded-md border theme-border px-2 py-1 bg-[rgba(16,185,129,0.14)] text-emerald-200">
                        {t("Accounts")}: {liveRows.length}
                      </div>
                      <div className="rounded-md border border-sky-500/25 px-2 py-1 bg-sky-500/12 text-sky-200">
                        {t("Players")}: {splitPlayersCount}
                      </div>
                      <div className="rounded-md border border-zinc-500/25 px-2 py-1 bg-zinc-500/12 text-zinc-200">
                        {t("Disconnected")}: {splitDisconnectedCount}
                      </div>
                      <div className="rounded-md border border-amber-400/25 px-2 py-1 bg-amber-500/12 text-amber-100">
                        {t("Retrying")}: {splitRetryingCount}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 rounded-xl border theme-border theme-soft p-2.5 animate-fade-in-up">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <label className="inline-flex items-center gap-1.5 rounded-md border theme-border px-2 py-1 text-[11px]">
                        <ThemedCheckbox
                          checked={allVisibleBulkSelected}
                          disabled={actionButtonsLocked || liveRows.length === 0}
                          onToggle={() => {
                            if (allVisibleBulkSelected) {
                              setBulkSelected([]);
                            } else {
                              setBulkSelected(liveRows.map(({ userId }) => userId));
                            }
                          }}
                          ariaLabel={t("Toggle all visible")}
                        />
                        <span className="text-[var(--panel-fg)]">{t("All visible")}</span>
                      </label>

                      <button
                        type="button"
                        onClick={() => setBulkSelected(visibleBotRowIds)}
                        disabled={actionButtonsLocked || visibleBotRowIds.length === 0}
                        className="px-2.5 py-1 text-[11px] rounded-md border theme-border bg-[var(--buttons-bg)] text-[var(--buttons-fg)] hover:text-[var(--panel-fg)] hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t("Select bots")}
                      </button>

                      <button
                        type="button"
                        onClick={() => setBulkSelected(liveRows.map(({ userId }) => userId))}
                        disabled={actionButtonsLocked || liveRows.length === 0}
                        className="px-2.5 py-1 text-[11px] rounded-md border theme-border bg-[var(--buttons-bg)] text-[var(--buttons-fg)] hover:text-[var(--panel-fg)] hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t("Select all")}
                      </button>

                      <button
                        type="button"
                        onClick={() => setBulkSelected([])}
                        disabled={actionButtonsLocked || bulkSelectedUserIds.length === 0}
                        className="px-2.5 py-1 text-[11px] rounded-md border theme-border bg-[var(--buttons-bg)] text-[var(--buttons-fg)] hover:text-[var(--panel-fg)] hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {t("Clear")}
                      </button>

                      <div className="ml-auto rounded-md border border-sky-500/30 bg-sky-500/12 text-sky-200 text-[11px] px-2 py-1">
                        {t("Selected")}: {bulkSelectedUserIds.length}
                      </div>
                    </div>

                    <div
                      className={[
                        "mt-2 overflow-hidden transition-[max-height,opacity,transform] duration-220 ease-out",
                        bulkSelectedUserIds.length > 0
                          ? "max-h-28 opacity-100 translate-y-0"
                          : "max-h-0 opacity-0 -translate-y-1 pointer-events-none",
                      ].join(" ")}
                    >
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            void runBulkAction("disconnect");
                          }}
                          disabled={actionButtonsLocked || !status?.active || bulkEligibleCounts.disconnect === 0}
                          className="px-3 py-1 text-[11px] font-medium rounded-lg border theme-border bg-[var(--buttons-bg)] text-[var(--buttons-fg)] hover:text-[var(--panel-fg)] hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t("Disconnect")} ({bulkEligibleCounts.disconnect})
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            void runBulkAction("close");
                          }}
                          disabled={actionButtonsLocked || !status?.active || bulkEligibleCounts.close === 0}
                          className="px-3 py-1 text-[11px] font-medium rounded-lg border theme-border bg-[var(--buttons-bg)] text-[var(--buttons-fg)] hover:text-[var(--panel-fg)] hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t("Close client")} ({bulkEligibleCounts.close})
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            void runBulkAction("restartClient");
                          }}
                          disabled={actionButtonsLocked || !status?.active || bulkEligibleCounts.restartClient === 0}
                          className="px-3 py-1 text-[11px] font-medium rounded-lg border border-emerald-400/30 bg-[rgba(16,185,129,0.10)] text-emerald-100 hover:bg-[rgba(16,185,129,0.18)] hover:border-emerald-300/40 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t("Restart client")} ({bulkEligibleCounts.restartClient})
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            void runBulkAction("restartLoop");
                          }}
                          disabled={actionButtonsLocked || !status?.active || bulkEligibleCounts.restartLoop === 0}
                          className="px-3 py-1 text-[11px] font-medium rounded-lg border border-amber-400/30 bg-[rgba(245,158,11,0.10)] text-amber-100 hover:bg-[rgba(245,158,11,0.18)] hover:border-amber-300/40 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t("Restart loop")} ({bulkEligibleCounts.restartLoop})
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            void runBulkAction("closeDisconnect");
                          }}
                          disabled={actionButtonsLocked || !status?.active || bulkEligibleCounts.closeDisconnect === 0}
                          className="px-3 py-1 text-[11px] font-medium rounded-lg border border-red-400/25 bg-[rgba(239,68,68,0.10)] text-red-200 hover:bg-[rgba(239,68,68,0.18)] hover:border-red-400/35 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t("Close + Disconnect")} ({bulkEligibleCounts.closeDisconnect})
                        </button>
                      </div>
                    </div>

                    <div
                      className={`mt-2 text-[10px] theme-muted transition-opacity duration-220 ease-out ${
                        bulkSelectedUserIds.length > 0 ? "opacity-85" : "opacity-100"
                      }`}
                    >
                      {t("Select rows to run bulk actions. Launch delays and retry rules remain unchanged")}
                    </div>
                  </div>

                  <div
                    className={`flex-1 min-h-0 overflow-y-auto space-y-2 pr-1 transition-[margin-top] duration-220 ease-out ${
                      bulkSelectedUserIds.length > 0 ? "mt-2" : "mt-3"
                    }`}
                  >
                    {liveRows.length === 0 ? (
                      <div className="h-full rounded-xl border theme-border theme-soft flex items-center justify-center text-[12px] theme-muted">
                        {t("No selected accounts")}
                      </div>
                    ) : (
                      liveRows.map(({ userId, account, row }, rowIndex) => {
                        const isRowBusy = rowBusy === userId;
                        const canAct = !!status?.active && !actionButtonsLocked && !!row;
                        const canFocus = canAct && !row?.disconnected && store.launchedByProgram.has(userId);
                        const isBulkSelected = bulkSelectedSet.has(userId);
                        const dueCountdownRaw = row?.disconnected
                          ? "disconnected"
                          : row?.isPlayer
                            ? row.phase || "queued-player"
                            : formatCountdown(row?.nextRestartAtMs ?? null, nowMs);
                        const dueCountdown = dueCountdownRaw.includes(":") || dueCountdownRaw === "--"
                          ? dueCountdownRaw
                          : t(dueCountdownRaw);
                        const dueClock = row && !row.disconnected && !row.isPlayer
                          ? formatDueTime(row.nextRestartAtMs ?? null)
                          : "--";
                        const retryCount = row?.retryCount || 0;
                        const retryTone = retryCount >= 4
                          ? "border-red-500/30 bg-red-500/15 text-red-200"
                          : retryCount >= 2
                            ? "border-amber-400/35 bg-amber-500/15 text-amber-200"
                            : "theme-border bg-[rgba(0,0,0,0.18)] text-[var(--panel-fg)]";
                        const dueTone = !row
                          ? "theme-border bg-[rgba(0,0,0,0.18)] text-[var(--panel-fg)]"
                          : row.disconnected
                            ? "border-zinc-500/35 bg-zinc-500/15 text-zinc-200"
                            : row.isPlayer
                              ? "border-sky-500/30 bg-sky-500/15 text-sky-200"
                              : (row.nextRestartAtMs ?? 0) <= nowMs
                                ? "border-amber-400/35 bg-amber-500/15 text-amber-100"
                                : "border-emerald-500/30 bg-emerald-500/15 text-emerald-200";
                        const avatarUrl = store.avatarUrls.get(userId);
                        return (
                          <div
                            key={userId}
                            className={[
                              "rounded-2xl border p-3 theme-soft animate-fade-in-up",
                              isBulkSelected
                                ? "border-sky-500/45 ring-1 ring-sky-400/30"
                                : row?.disconnected
                                  ? "border-zinc-500/30"
                                  : row?.isPlayer
                                    ? "theme-accent-border"
                                    : "theme-border",
                            ].join(" ")}
                            style={{ animationDelay: `${Math.min(rowIndex * 35, 180)}ms` }}
                          >
                            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                              <div className="min-w-0 flex items-start gap-2.5">
                                <div className="mt-1 inline-flex items-center">
                                  <ThemedCheckbox
                                    checked={isBulkSelected}
                                    disabled={actionButtonsLocked}
                                    onToggle={() => toggleBulkSelected(userId)}
                                    ariaLabel={t("Select account {{id}}", { id: userId })}
                                  />
                                </div>
                                {avatarUrl ? (
                                  <img
                                    src={avatarUrl}
                                    alt=""
                                    className="theme-avatar w-7 h-7 rounded-full bg-[var(--panel-soft)] shrink-0"
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="theme-avatar w-7 h-7 rounded-full bg-[var(--panel-soft)] flex items-center justify-center theme-muted text-[10px] font-medium shrink-0">
                                    {(account?.Username || "?").charAt(0).toUpperCase()}
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <div className="text-[13px] text-[var(--panel-fg)] truncate">
                                    {account?.Alias || account?.Username || `${t("User ID")}: ${userId}`}
                                  </div>
                                  <div className={`text-[11px] ${phaseTone(row?.phase || "idle")}`}>
                                    {t(row?.phase || "idle")}
                                  </div>
                                  {row?.lastError ? (
                                    <div className="text-[11px] text-red-300/90 truncate mt-0.5">
                                      {row.lastError}
                                    </div>
                                  ) : null}
                                </div>
                              </div>

                              <div className="grid grid-cols-3 gap-1.5 w-full xl:w-auto xl:min-w-[300px]">
                                <div className={`rounded-lg border px-2.5 py-1.5 ${dueTone}`}>
                                  <div className="text-[9px] uppercase tracking-[0.08em] opacity-80">{t("due")}</div>
                                  <div className="text-[12px] font-mono leading-tight">{dueCountdown}</div>
                                </div>
                                <div className="rounded-lg border theme-border px-2.5 py-1.5 bg-[rgba(0,0,0,0.18)]">
                                  <div className="text-[9px] uppercase tracking-[0.08em] theme-muted">{t("next")}</div>
                                  <div className="text-[12px] font-mono text-[var(--panel-fg)] leading-tight">{dueClock}</div>
                                </div>
                                <div className={`rounded-lg border px-2.5 py-1.5 ${retryTone}`}>
                                  <div className="text-[9px] uppercase tracking-[0.08em] opacity-80">{t("retries")}</div>
                                  <div className="text-[12px] font-mono leading-tight">{retryCount}</div>
                                </div>
                              </div>
                            </div>

                            <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-xl border theme-border p-1.5 bg-[linear-gradient(95deg,rgba(255,255,255,0.09),rgba(255,255,255,0.02))]">
                              <Tooltip
                                content={
                                  <div className="space-y-0.5">
                                    <div className="font-semibold">{t("Disconnect from loop")}</div>
                                    <div className="theme-muted">
                                      {t("Stops cycling this account without closing Roblox.")}
                                    </div>
                                  </div>
                                }
                              >
                                <span>
                                  <button
                                    type="button"
                                    disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "disconnect")}
                                    className={[
                                      "px-3 py-1 text-[11px] font-medium rounded-lg border theme-border",
                                      "bg-[var(--buttons-bg)] text-[var(--buttons-fg)]",
                                      "hover:text-[var(--panel-fg)] hover:brightness-110 transition",
                                      "disabled:opacity-50 disabled:cursor-not-allowed",
                                    ].join(" ")}
                                    onClick={() => {
                                      void runRowAction(userId, "disconnect");
                                    }}
                                  >
                                    {t("Disconnect")}
                                  </button>
                                </span>
                              </Tooltip>

                              <Tooltip
                                content={
                                  <div className="space-y-0.5">
                                    <div className="font-semibold">{t("Close client")}</div>
                                    <div className="theme-muted">{t("Closes Roblox. If disconnected, it rejoins immediately; otherwise it waits for the next scheduled rejoin.")}</div>
                                  </div>
                                }
                              >
                                <span>
                                  <button
                                    type="button"
                                    disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "close")}
                                    className={[
                                      "px-3 py-1 text-[11px] font-medium rounded-lg border theme-border",
                                      "bg-[var(--buttons-bg)] text-[var(--buttons-fg)]",
                                      "hover:text-[var(--panel-fg)] hover:brightness-110 transition",
                                      "disabled:opacity-50 disabled:cursor-not-allowed",
                                    ].join(" ")}
                                    onClick={() => {
                                      void runRowAction(userId, "close");
                                    }}
                                  >
                                    {t("Close client")}
                                  </button>
                                </span>
                              </Tooltip>

                              <Tooltip
                                content={
                                  <div className="space-y-0.5">
                                    <div className="font-semibold">{t("Restart client")}</div>
                                    <div className="theme-muted">{t("Closes and relaunches this client now while keeping the current loop timing. Works for player accounts too.")}</div>
                                  </div>
                                }
                              >
                                <span>
                                  <button
                                    type="button"
                                    disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "restartClient")}
                                    className={[
                                      "px-3 py-1 text-[11px] font-medium rounded-lg border border-emerald-400/30",
                                      "bg-[rgba(16,185,129,0.10)] text-emerald-100",
                                      "hover:bg-[rgba(16,185,129,0.18)] hover:border-emerald-300/40 transition",
                                      "disabled:opacity-50 disabled:cursor-not-allowed",
                                    ].join(" ")}
                                    onClick={() => {
                                      void runRowAction(userId, "restartClient");
                                    }}
                                  >
                                    {t("Restart client")}
                                  </button>
                                </span>
                              </Tooltip>

                              <Tooltip
                                content={
                                  <div className="space-y-0.5">
                                    <div className="font-semibold">{t("Focus client")}</div>
                                    <div className="theme-muted">{t("Brings this Roblox window to the front and restores it if minimized.")}</div>
                                  </div>
                                }
                              >
                                <span>
                                  <button
                                    type="button"
                                    disabled={!canFocus || isRowBusy}
                                    className={[
                                      "px-3 py-1 text-[11px] font-medium rounded-lg border border-sky-400/25",
                                      "bg-[rgba(56,189,248,0.10)] text-sky-100",
                                      "hover:bg-[rgba(56,189,248,0.18)] hover:border-sky-300/35 transition",
                                      "disabled:opacity-50 disabled:cursor-not-allowed",
                                    ].join(" ")}
                                    onClick={() => {
                                      void runRowFocus(userId);
                                    }}
                                  >
                                    {t("Focus client")}
                                  </button>
                                </span>
                              </Tooltip>

                              <Tooltip
                                content={
                                  <div className="space-y-0.5">
                                    <div className="font-semibold">{t("Restart loop")}</div>
                                    <div className="theme-muted">{t("Closes the current client and relaunches now. Player accounts stay player accounts; non-player accounts continue standard rejoin timing.")}</div>
                                  </div>
                                }
                              >
                                <span>
                                  <button
                                    type="button"
                                    disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "restartLoop")}
                                    className={[
                                      "px-3 py-1 text-[11px] font-medium rounded-lg border border-amber-400/30",
                                      "bg-[rgba(245,158,11,0.10)] text-amber-100",
                                      "hover:bg-[rgba(245,158,11,0.18)] hover:border-amber-300/40 transition",
                                      "disabled:opacity-50 disabled:cursor-not-allowed",
                                    ].join(" ")}
                                    onClick={() => {
                                      void runRowAction(userId, "restartLoop");
                                    }}
                                  >
                                    {t("Restart loop")}
                                  </button>
                                </span>
                              </Tooltip>

                              <Tooltip
                                content={
                                  <div className="space-y-0.5">
                                    <div className="font-semibold">{t("Close + remove from loop")}</div>
                                    <div className="theme-muted">{t("Closes Roblox and excludes the account from cycling.")}</div>
                                  </div>
                                }
                              >
                                <span>
                                  <button
                                    type="button"
                                    disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "closeDisconnect")}
                                    className={[
                                      "px-3 py-1 text-[11px] font-medium rounded-lg border border-red-400/25",
                                      "bg-[rgba(239,68,68,0.10)] text-red-200",
                                      "hover:bg-[rgba(239,68,68,0.18)] hover:border-red-400/35 transition",
                                      "disabled:opacity-50 disabled:cursor-not-allowed",
                                    ].join(" ")}
                                    onClick={() => {
                                      void runRowAction(userId, "closeDisconnect");
                                    }}
                                  >
                                    {t("Close + Disconnect")}
                                  </button>
                                </span>
                              </Tooltip>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>
              </div>
            </div>
          ) : null}
          {!useSplitLayout ? (
            <>
          <section
            className={`theme-surface rounded-xl border theme-border p-3 animate-fade-in relative ${
              playerMenuOpen ? "z-30" : "z-10"
            }`}
          >
            <div className="text-[13px] font-medium text-[var(--panel-fg)] mb-2">{t("Targets")}</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {selectedAccounts.map((a) => {
                const isPlayer = playerUserIds.includes(a.UserID) || !!statusMap.get(a.UserID)?.isPlayer;
                return (
                  <span
                    key={a.UserID}
                    className={[
                      "px-2 py-1 rounded-md text-[11px] border theme-soft",
                      isPlayer ? "theme-accent-bg theme-accent-border theme-accent" : "theme-border text-[var(--panel-fg)]",
                    ].join(" ")}
                  >
                    {a.Alias || a.Username}
                  </span>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] theme-muted w-24 shrink-0">{t("Player Accounts")}</label>
              <div ref={playerMenuRef} className="relative w-full">
                <button
                  type="button"
                  onClick={() => setPlayerMenuOpen((v) => !v)}
                  className="sidebar-input text-xs flex items-center justify-between gap-2 hover:brightness-110 transition-all"
                  aria-haspopup="listbox"
                  aria-expanded={playerMenuOpen}
                >
                  <span className="truncate">{playerAccountLabel}</span>
                  <ChevronDown size={14} strokeWidth={2} className={`theme-muted transition-transform duration-150 ${playerMenuOpen ? "rotate-180" : ""}`} />
                </button>
                <div
                  className={`absolute left-0 right-0 top-[calc(100%+6px)] z-20 rounded-lg border theme-border theme-panel shadow-2xl overflow-hidden transition-all duration-150 ${
                    playerMenuOpen
                      ? "opacity-100 translate-y-0 pointer-events-auto"
                      : "opacity-0 -translate-y-1 pointer-events-none"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setPlayerUserIds([]);
                      void saveDraft(
                        placeId.trim(),
                        jobId.trim(),
                        launchData,
                        [],
                        intervalMinutes,
                        launchDelaySeconds,
                        playerGraceMinutes
                      );
                      if (status?.active) void store.setBottingPlayerAccounts([]);
                      setPlayerMenuOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-[12px] transition-colors ${
                      playerUserIds.length === 0
                        ? "theme-accent-bg theme-accent"
                        : "text-[var(--panel-fg)] hover:bg-[var(--panel-soft)]"
                    }`}
                  >
                    {t("None")}
                  </button>
                  <div className="h-px theme-border border-t" />
                  {selectedAccounts.map((a) => {
                    const active = playerUserIds.includes(a.UserID);
                    return (
                      <button
                        key={a.UserID}
                        type="button"
                        onClick={() => {
                          void handleTogglePlayer(a.UserID);
                        }}
                        className={`w-full text-left px-3 py-2 text-[12px] transition-colors ${
                          active
                            ? "theme-accent-bg theme-accent"
                            : "text-[var(--panel-fg)] hover:bg-[var(--panel-soft)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{a.Alias || a.Username}</span>
                          {active ? (
                            <span className="text-[11px] opacity-80">{t("Selected")}</span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <section className="theme-surface rounded-xl border theme-border p-3 animate-fade-in">
            <div className="text-[13px] font-medium text-[var(--panel-fg)] mb-2">{t("Server")}</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <input
                value={placeId}
                onChange={(e) => {
                  const next = e.target.value;
                  setPlaceId(next);
                  if (shareLaunchFields) {
                    store.setPlaceId(next);
                  }
                }}
                onBlur={() =>
                  saveDraft(
                    placeId.trim(),
                    jobId.trim(),
                    launchData,
                    playerUserIds,
                    intervalMinutes,
                    launchDelaySeconds,
                    playerGraceMinutes
                  )
                }
                placeholder={t("Place ID")}
                className="sidebar-input text-xs font-mono"
              />
              <input
                value={jobId}
                onChange={(e) => {
                  const next = e.target.value;
                  setJobId(next);
                  if (shareLaunchFields) {
                    store.setJobId(next);
                  }
                }}
                onBlur={() =>
                  saveDraft(
                    placeId.trim(),
                    jobId.trim(),
                    launchData,
                    playerUserIds,
                    intervalMinutes,
                    launchDelaySeconds,
                    playerGraceMinutes
                  )
                }
                placeholder={t("Job ID (optional)")}
                className="sidebar-input text-xs font-mono"
              />
              <input
                value={launchData}
                onChange={(e) => {
                  const next = e.target.value;
                  setLaunchData(next);
                  if (shareLaunchFields) {
                    store.setLaunchData(next);
                  }
                }}
                onBlur={() =>
                  saveDraft(
                    placeId.trim(),
                    jobId.trim(),
                    launchData,
                    playerUserIds,
                    intervalMinutes,
                    launchDelaySeconds,
                    playerGraceMinutes
                  )
                }
                placeholder={t("JoinData (optional)")}
                className="sidebar-input text-xs"
              />
            </div>
            {shareLaunchFields ? (
              <div className="mt-2 text-[10px] theme-muted">
                {t("Launch fields are currently synced with Sidebar")}
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => {
                    setPlaceId(store.placeId);
                    setJobId(store.jobId);
                    setLaunchData(store.launchData);
                  }}
                  className="sidebar-btn-sm"
                >
                  {t("Use Current Launch Fields")}
                </button>
              </div>
            )}
          </section>

          <section className="theme-surface rounded-xl border theme-border p-3 animate-fade-in">
            <div className="text-[13px] font-medium text-[var(--panel-fg)] mb-2">{t("Timing")}</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <div className="flex items-center gap-2">
                <label className="text-[11px] theme-muted w-36 shrink-0">{t("Rejoin Interval (minutes)")}</label>
                <NumericInput
                  value={intervalMinutes}
                  min={10}
                  max={480}
                  step={1}
                  integer
                  showStepper
                  onChange={setIntervalMinutes}
                  onCommit={(nextInterval) =>
                    saveDraft(
                      placeId.trim(),
                      jobId.trim(),
                      launchData,
                      playerUserIds,
                      nextInterval,
                      launchDelaySeconds,
                      playerGraceMinutes
                    )
                  }
                  className="sidebar-input text-xs pr-10"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] theme-muted w-36 shrink-0">{t("Launch Delay (seconds)")}</label>
                <NumericInput
                  value={launchDelaySeconds}
                  min={5}
                  max={120}
                  step={1}
                  integer
                  showStepper
                  onChange={setLaunchDelaySeconds}
                  onCommit={(nextDelay) =>
                    saveDraft(
                      placeId.trim(),
                      jobId.trim(),
                      launchData,
                      playerUserIds,
                      intervalMinutes,
                      nextDelay,
                      playerGraceMinutes
                    )
                  }
                  className="sidebar-input text-xs pr-10"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] theme-muted w-36 shrink-0">{t("Player Grace (minutes)")}</label>
                <NumericInput
                  value={playerGraceMinutes}
                  min={1}
                  max={90}
                  step={1}
                  integer
                  showStepper
                  onChange={setPlayerGraceMinutes}
                  onCommit={(nextGraceMinutes) =>
                    saveDraft(
                      placeId.trim(),
                      jobId.trim(),
                      launchData,
                      playerUserIds,
                      intervalMinutes,
                      launchDelaySeconds,
                      nextGraceMinutes
                    )
                  }
                  className="sidebar-input text-xs pr-10"
                />
              </div>
            </div>
            <div className="text-[10px] theme-muted mt-2">
              {t("Player account demotion grace is {{minutes}} minutes before it enters normal restart cycle.", {
                minutes: playerGraceMinutes,
              })}
            </div>
            {!multiRbxEnabled ? (
              <div className="text-[10px] text-amber-300 mt-1">
                {t("Botting Mode currently requires Multi Roblox to be enabled")}
              </div>
            ) : null}
          </section>

          <section className="theme-surface rounded-xl border theme-border p-3 animate-fade-in">
            <div className="text-[13px] font-medium text-[var(--panel-fg)] mb-2">{t("Live Cycle")}</div>
            <div className="space-y-1.5">
              {liveRows.map(({ userId, account, row }) => {
                const isRowBusy = rowBusy === userId;
                const canAct = !!status?.active && !actionButtonsLocked && !!row;
                const canFocus = canAct && !row?.disconnected && store.launchedByProgram.has(userId);
                const dueCountdownRaw = row?.disconnected
                  ? "disconnected"
                  : row?.isPlayer
                    ? row.phase || "queued-player"
                    : formatCountdown(row?.nextRestartAtMs ?? null, nowMs);
                const dueCountdown = dueCountdownRaw.includes(":") || dueCountdownRaw === "--"
                  ? dueCountdownRaw
                  : t(dueCountdownRaw);
                const dueClock = row && !row.disconnected && !row.isPlayer
                  ? formatDueTime(row.nextRestartAtMs ?? null)
                  : "--";
                const retryCount = row?.retryCount || 0;
                const retryTone = retryCount >= 4
                  ? "border-red-500/30 bg-red-500/15 text-red-200"
                  : retryCount >= 2
                    ? "border-amber-400/35 bg-amber-500/15 text-amber-200"
                    : "theme-border bg-[rgba(0,0,0,0.18)] text-[var(--panel-fg)]";
                const dueTone = !row
                  ? "theme-border bg-[rgba(0,0,0,0.18)] text-[var(--panel-fg)]"
                  : row.disconnected
                  ? "border-zinc-500/35 bg-zinc-500/15 text-zinc-200"
                  : row.isPlayer
                    ? "border-sky-500/30 bg-sky-500/15 text-sky-200"
                    : (row.nextRestartAtMs ?? 0) <= nowMs
                      ? "border-amber-400/35 bg-amber-500/15 text-amber-100"
                      : "border-emerald-500/30 bg-emerald-500/15 text-emerald-200";
                return (
                  <div
                    key={userId}
                    className={[
                      "rounded-xl border px-3 py-2.5 theme-soft",
                      row?.disconnected
                        ? "border-zinc-500/30"
                        : row?.isPlayer
                          ? "theme-accent-border"
                          : "theme-border",
                    ].join(" ")}
                  >
                    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-[var(--panel-fg)] truncate">
                          {account?.Alias || account?.Username || `${t("User ID")}: ${userId}`}
                        </div>
                        <div className={`text-[11px] ${phaseTone(row?.phase || "idle")}`}>
                          {t(row?.phase || "idle")}
                          {row?.lastError ? ` - ${row.lastError}` : ""}
                        </div>
                      </div>
                      <div className="flex w-full flex-col gap-1.5 md:w-auto md:items-end">
                        <div
                          className={[
                            "flex flex-wrap items-center gap-1.5 rounded-xl border theme-border p-1.5",
                            "bg-[linear-gradient(95deg,rgba(255,255,255,0.09),rgba(255,255,255,0.02))]",
                          ].join(" ")}
                        >
                          <Tooltip
                            content={
                              <div className="space-y-0.5">
                                <div className="font-semibold">{t("Disconnect from loop")}</div>
                                <div className="theme-muted">
                                  {t("Stops cycling this account without closing Roblox.")}
                                </div>
                              </div>
                            }
                          >
                            <span>
                              <button
                                type="button"
                                disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "disconnect")}
                                className={[
                                  "px-3 py-1 text-[11px] font-medium rounded-lg border theme-border",
                                  "bg-[var(--buttons-bg)] text-[var(--buttons-fg)]",
                                  "hover:text-[var(--panel-fg)] hover:brightness-110 transition",
                                  "disabled:opacity-50 disabled:cursor-not-allowed",
                                ].join(" ")}
                                onClick={() => {
                                  void runRowAction(userId, "disconnect");
                                }}
                              >
                                {t("Disconnect")}
                              </button>
                            </span>
                          </Tooltip>

                          <Tooltip
                            content={
                              <div className="space-y-0.5">
                                <div className="font-semibold">{t("Close client")}</div>
                                <div className="theme-muted">{t("Closes Roblox. If disconnected, it rejoins immediately; otherwise it waits for the next scheduled rejoin.")}</div>
                              </div>
                            }
                          >
                            <span>
                              <button
                                type="button"
                                disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "close")}
                                className={[
                                  "px-3 py-1 text-[11px] font-medium rounded-lg border theme-border",
                                  "bg-[var(--buttons-bg)] text-[var(--buttons-fg)]",
                                  "hover:text-[var(--panel-fg)] hover:brightness-110 transition",
                                  "disabled:opacity-50 disabled:cursor-not-allowed",
                                ].join(" ")}
                                onClick={() => {
                                  void runRowAction(userId, "close");
                                }}
                              >
                                {t("Close client")}
                              </button>
                            </span>
                          </Tooltip>

                          <Tooltip
                            content={
                              <div className="space-y-0.5">
                                <div className="font-semibold">{t("Restart client")}</div>
                                <div className="theme-muted">{t("Closes and relaunches this client now while keeping the current loop timing. Works for player accounts too.")}</div>
                              </div>
                            }
                          >
                            <span>
                              <button
                                type="button"
                                disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "restartClient")}
                                className={[
                                  "px-3 py-1 text-[11px] font-medium rounded-lg border border-emerald-400/30",
                                  "bg-[rgba(16,185,129,0.10)] text-emerald-100",
                                  "hover:bg-[rgba(16,185,129,0.18)] hover:border-emerald-300/40 transition",
                                  "disabled:opacity-50 disabled:cursor-not-allowed",
                                ].join(" ")}
                                onClick={() => {
                                  void runRowAction(userId, "restartClient");
                                }}
                              >
                                {t("Restart client")}
                              </button>
                            </span>
                          </Tooltip>

                          <Tooltip
                            content={
                              <div className="space-y-0.5">
                                <div className="font-semibold">{t("Focus client")}</div>
                                <div className="theme-muted">{t("Brings this Roblox window to the front and restores it if minimized.")}</div>
                              </div>
                            }
                          >
                            <span>
                              <button
                                type="button"
                                disabled={!canFocus || isRowBusy}
                                className={[
                                  "px-3 py-1 text-[11px] font-medium rounded-lg border border-sky-400/25",
                                  "bg-[rgba(56,189,248,0.10)] text-sky-100",
                                  "hover:bg-[rgba(56,189,248,0.18)] hover:border-sky-300/35 transition",
                                  "disabled:opacity-50 disabled:cursor-not-allowed",
                                ].join(" ")}
                                onClick={() => {
                                  void runRowFocus(userId);
                                }}
                              >
                                {t("Focus client")}
                              </button>
                            </span>
                          </Tooltip>

                          <Tooltip
                            content={
                              <div className="space-y-0.5">
                                <div className="font-semibold">{t("Restart loop")}</div>
                                <div className="theme-muted">{t("Closes the current client and relaunches now. Player accounts stay player accounts; non-player accounts continue standard rejoin timing.")}</div>
                              </div>
                            }
                          >
                            <span>
                              <button
                                type="button"
                                disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "restartLoop")}
                                className={[
                                  "px-3 py-1 text-[11px] font-medium rounded-lg border border-amber-400/30",
                                  "bg-[rgba(245,158,11,0.10)] text-amber-100",
                                  "hover:bg-[rgba(245,158,11,0.18)] hover:border-amber-300/40 transition",
                                  "disabled:opacity-50 disabled:cursor-not-allowed",
                                ].join(" ")}
                                onClick={() => {
                                  void runRowAction(userId, "restartLoop");
                                }}
                              >
                                {t("Restart loop")}
                              </button>
                            </span>
                          </Tooltip>

                          <Tooltip
                            content={
                              <div className="space-y-0.5">
                                <div className="font-semibold">{t("Close + remove from loop")}</div>
                                <div className="theme-muted">{t("Closes Roblox and excludes the account from cycling.")}</div>
                              </div>
                            }
                          >
                            <span>
                              <button
                                type="button"
                                disabled={!canAct || isRowBusy || !canRunBottingActionOnRow(row, "closeDisconnect")}
                                className={[
                                  "px-3 py-1 text-[11px] font-medium rounded-lg border border-red-400/25",
                                  "bg-[rgba(239,68,68,0.10)] text-red-200",
                                  "hover:bg-[rgba(239,68,68,0.18)] hover:border-red-400/35 transition",
                                  "disabled:opacity-50 disabled:cursor-not-allowed",
                                ].join(" ")}
                                onClick={() => {
                                  void runRowAction(userId, "closeDisconnect");
                                }}
                              >
                                {t("Close + Disconnect")}
                              </button>
                            </span>
                          </Tooltip>
                        </div>

                        <div className="grid grid-cols-3 gap-1.5 w-full md:min-w-[300px]">
                          <div className={`rounded-lg border px-2.5 py-1.5 ${dueTone}`}>
                            <div className="text-[9px] uppercase tracking-[0.08em] opacity-80">{t("due")}</div>
                            <div className="text-[12px] font-mono leading-tight">
                              {dueCountdown}
                            </div>
                          </div>
                          <div className="rounded-lg border theme-border px-2.5 py-1.5 bg-[rgba(0,0,0,0.18)]">
                            <div className="text-[9px] uppercase tracking-[0.08em] theme-muted">{t("next")}</div>
                            <div className="text-[12px] font-mono text-[var(--panel-fg)] leading-tight">
                              {dueClock}
                            </div>
                          </div>
                          <div className={`rounded-lg border px-2.5 py-1.5 ${retryTone}`}>
                            <div className="text-[9px] uppercase tracking-[0.08em] opacity-80">{t("retries")}</div>
                            <div className="text-[12px] font-mono leading-tight">
                              {retryCount}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
            </>
          ) : null}
        </div>

        {!useSplitLayout ? (
        <div className="px-5 py-4 border-t theme-border flex flex-wrap items-center gap-2 justify-end">
          <button
            onClick={handleStart}
            disabled={!canStart}
            className="sidebar-btn-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("Start Botting Mode")}
          </button>
          <button
            onClick={() => store.stopBottingMode(false)}
            disabled={actionButtonsLocked}
            className="sidebar-btn-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("Stop Botting Mode")}
          </button>
          <button
            onClick={() => store.stopBottingMode(true)}
            disabled={actionButtonsLocked}
            className="sidebar-btn-sm text-red-200 border-red-400/40 hover:bg-red-500/15 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("Stop + Close Bot Accounts")}
          </button>
        </div>
        ) : null}
      </div>
    </div>
  );
}
