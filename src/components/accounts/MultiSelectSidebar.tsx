import { useState, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Save, Shuffle, History } from "lucide-react";
import { useStore, needsFollowWarning } from "../../store";
import { usePrompt, useConfirm } from "../../hooks/usePrompt";
import { useJoinOnlineWarning } from "../../hooks/useJoinOnlineWarning";
import { parseGroupName } from "../../types";
import { SidebarSection } from "./SidebarSection";
import { AccountChip } from "./AccountChip";
import { Tooltip } from "../ui/Tooltip";
import { RecentGamesPopover } from "../server-list/RecentGamesPopover";
import { RecentJobsPopover } from "../server-list/RecentJobsPopover";
import { tr, useTr } from "../../i18n/text";

export function MultiSelectSidebar() {
  const t = useTr();
  const store = useStore();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const confirmJoinOnline = useJoinOnlineWarning();
  const accounts = store.selectedAccounts;
  const count = accounts.length;
  const [refreshing, setRefreshing] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [savingLaunchFields, setSavingLaunchFields] = useState(false);
  const [settingDisplayName, setSettingDisplayName] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const recentsRef = useRef<HTMLButtonElement>(null);
  const recentJobsRef = useRef<HTMLButtonElement>(null);
  const [recentJobsOpen, setRecentJobsOpen] = useState(false);
  const [followUser, setFollowUser] = useState("");
  const [following, setFollowing] = useState(false);
  const maxRecent = parseInt(store.settings?.General?.MaxRecentGames || "8") || 8;
  const launching = store.launchProgress?.mode === "multi";

  const previewAccounts = accounts.slice(0, 5);
  const remaining = count - previewAccounts.length;
  const hasManySelected = count > 5;
  const shownAccounts = accountsExpanded ? accounts : previewAccounts;
  const bottingEnabled = store.settings?.General?.BottingEnabled === "true";
  const showBottingButton = bottingEnabled || store.bottingStatus?.active === true;
  const bottingActive = store.bottingStatus?.active === true;
  const activeBottingUserIds = useMemo(() => new Set(store.bottingStatus?.userIds || []), [store.bottingStatus?.userIds]);
  const addableBottingIds = useMemo(
    () => accounts.map((a) => a.UserID).filter((id) => !activeBottingUserIds.has(id)),
    [accounts, activeBottingUserIds]
  );
  const addableBottingCount = addableBottingIds.length;
  const launchedSelectedIds = useMemo(
    () => accounts.map((a) => a.UserID).filter((id) => store.launchedByProgram.has(id)),
    [accounts, store.launchedByProgram]
  );
  const launchedSelectedCount = launchedSelectedIds.length;
  const errorLower = (store.error || "").toLowerCase();
  const pulseCloseAction =
    errorLower.includes("failed to enable multi roblox") ||
    (errorLower.includes("multi roblox") && errorLower.includes("close all roblox process"));

  const allGroups = useMemo(() => {
    const set = new Set<string>();
    store.accounts.forEach((a) => set.add(a.Group || "Default"));
    return [...set].sort();
  }, [store.accounts]);

  async function handleJoin() {
    const ids = accounts.map((a) => a.UserID);
    if (!(await confirmJoinOnline(ids))) return;
    try {
      await store.launchMultiple(ids);
    } catch (e) {
      store.addToast(tr("Launch failed: {{error}}", { error: String(e) }));
    }
  }

  async function handleFollow() {
    const username = followUser.trim();
    if (!username || following || launching) return;
    const ids = accounts.map((a) => a.UserID);
    setFollowing(true);
    try {
      const target = await store.resolveFollowTarget(username, ids[0]);
      if (needsFollowWarning(target)) {
        if (!(await confirm(tr("{{name}} is not in a game. Try anyway?", { name: target.name })))) return;
      }
      if (!(await confirmJoinOnline(ids))) return;
      await store.launchMultiple(ids, { follow: target });
    } catch (e) {
      store.addToast(tr("Follow failed: {{error}}", { error: String(e) }));
    } finally {
      setFollowing(false);
    }
  }

  async function handleRefreshAll() {
    setRefreshing(true);
    let ok = 0;
    let fail = 0;
    for (const a of accounts) {
      const result = await store.refreshCookie(a.UserID).catch(() => false);
      if (result) ok++;
      else fail++;
      await new Promise((r) => setTimeout(r, 2000));
    }
    setRefreshing(false);
    store.addToast(tr("Refreshed: {{ok}} ok, {{fail}} failed", { ok, fail }));
  }

  async function handleCopyCookies() {
    const cookies = accounts.map((a) => a.SecurityToken).filter(Boolean);
    await navigator.clipboard.writeText(cookies.join("\n"));
    store.addToast(tr("Copied {{count}} cookies", { count: cookies.length }));
  }

  async function handleCopyCombo() {
    const lines = accounts
      .filter((a) => a.Username && a.Password && a.SecurityToken)
      .map((a) => `${a.Username}:${a.Password}:${a.SecurityToken}`);
    await navigator.clipboard.writeText(lines.join("\n"));
    store.addToast(tr("Copied {{count}} user:pass:cookie", { count: lines.length }));
  }

  async function handleSetDisplayName() {
    if (settingDisplayName) return;
    const name = await prompt(tr("New display name:"));
    if (name === null || !name.trim()) return;
    if (!(await confirm(tr("Change display name for {{count}} accounts?", { count })))) return;
    setSettingDisplayName(true);
    let ok = 0;
    let fail = 0;
    for (const a of accounts) {
      try {
        await invoke("set_display_name", { userId: a.UserID, displayName: name.trim() });
        ok++;
      } catch {
        fail++;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    setSettingDisplayName(false);
    store.addToast(tr("Display name: {{ok}} ok, {{fail}} failed", { ok, fail }));
  }

  async function handleMoveToGroup(group: string) {
    setMoveOpen(false);
    await store.moveToGroup(
      accounts.map((a) => a.UserID),
      group
    );
  }

  async function handleNewGroup() {
    setMoveOpen(false);
    const name = await prompt(tr("New group name:"));
    if (!name?.trim()) return;
    await store.moveToGroup(
      accounts.map((a) => a.UserID),
      name.trim()
    );
  }

  async function handleSaveLaunchFields() {
    if (accounts.length === 0 || savingLaunchFields) return;
    setSavingLaunchFields(true);
    try {
      await Promise.all(
        accounts.map((account) =>
          store.updateAccount({
            ...account,
            Fields: {
              ...(account.Fields || {}),
              SavedPlaceId: store.placeId,
              SavedJobId: store.jobId,
              SavedLaunchData: store.launchData,
            },
          })
        )
      );
      store.addToast(tr("Saved launch fields to {{count}} account(s)", { count: accounts.length }));
    } catch (e) {
      store.addToast(tr("Failed to save launch fields: {{error}}", { error: String(e) }));
    } finally {
      setSavingLaunchFields(false);
    }
  }

  async function handleAddToBottingMode() {
    if (!bottingActive) {
      store.addToast(t("Botting Mode is not running"));
      return;
    }
    if (addableBottingCount <= 0) {
      store.addToast(t("Selected accounts are already in Botting Mode"));
      return;
    }
    try {
      await store.addBottingAccounts(addableBottingIds);
    } catch (e) {
      store.addToast(t("Botting account action failed: {{error}}", { error: String(e) }));
    }
  }

  async function handleRestartLaunchedClients() {
    await store.restartRobloxClients(launchedSelectedIds);
  }

  return (
    <div data-tour="launch-sidebar" className="theme-surface theme-border w-72 border-l flex flex-col shrink-0 animate-slide-right">
      <div className="p-4 border-b theme-border">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-[var(--panel-fg)]">
              {count} selected
            </div>
            <div className="theme-muted text-[11px] mt-0.5">
              {t("Ctrl+click to toggle, Shift+click for range")}
            </div>
          </div>
          <button
            onClick={store.deselectAll}
            className="theme-btn-ghost text-[11px] transition-colors px-2 py-0.5 rounded"
          >
            {t("Clear")}
          </button>
        </div>

        <div
          className={`mt-3 flex flex-col gap-1 overflow-hidden transition-[max-height,opacity] duration-200 ease-out ${
            accountsExpanded
              ? "max-h-56 overflow-y-auto pr-1 opacity-100"
              : "max-h-44 opacity-95"
          }`}
        >
          {shownAccounts.map((a) => (
            <AccountChip
              key={a.UserID}
              account={a}
              avatarUrl={store.avatarUrls.get(a.UserID)}
              onRemove={() => {
                store.handleSelect(a.UserID, { ctrlKey: true, shiftKey: false, metaKey: false } as unknown as React.MouseEvent);
              }}
            />
          ))}
          {!accountsExpanded && remaining > 0 && (
            <div className="theme-muted text-[11px] px-1 py-0.5">
              {t("+{{count}} more", { count: remaining })}
            </div>
          )}
        </div>
        {hasManySelected && (
          <button
            onClick={() => setAccountsExpanded((v) => !v)}
            className="mt-2 w-full theme-btn-ghost text-[11px] px-2 py-1 rounded flex items-center justify-center gap-1.5 transition-colors"
          >
            <ChevronDown
              size={12}
              strokeWidth={2}
              className={`transition-transform duration-200 ${accountsExpanded ? "rotate-180" : "rotate-0"}`}
            />
            {accountsExpanded ? (
              <>
                <span>{t("Show less")}</span>
              </>
            ) : (
              <>
                <span>{t("Show all ({{count}})", { count })}</span>
              </>
            )}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        <SidebarSection title={t("Launch")}>
          {store.launchProgress?.mode === "multi" && (
            <div className="theme-accent-bg theme-accent-border mb-2 rounded-lg border px-2.5 py-1.5 animate-fade-in">
              <div className="theme-accent flex items-center gap-2 text-[11px]">
                <span className="w-2 h-2 rounded-full bg-[var(--accent-color)] animate-pulse" />
                <span className="font-medium">
                  {t("Joining {{current}}/{{total}}", {
                    current: store.launchProgress.current,
                    total: store.launchProgress.total,
                  })}
                </span>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <label className="theme-label text-[10px] w-10 shrink-0">{t("Place")}</label>
              <input
                value={store.placeId}
                onChange={(e) => store.setPlaceId(e.target.value)}
                placeholder={t("Place ID")}
                className="sidebar-input flex-1 font-mono text-xs"
              />
              <Tooltip content={t("Recent games")}>
                <button
                  ref={recentsRef}
                  onClick={() => setRecentsOpen((v) => !v)}
                  aria-label={t("Recent games")}
                  aria-expanded={recentsOpen}
                  aria-haspopup="menu"
                  className="theme-muted p-1 rounded hover:text-[var(--panel-fg)]"
                >
                  <History size={14} strokeWidth={1.5} />
                </button>
              </Tooltip>
              <RecentGamesPopover
                open={recentsOpen}
                onClose={() => setRecentsOpen(false)}
                anchorRef={recentsRef}
                userId={accounts[0]?.UserID ?? null}
                maxRecent={maxRecent}
                onSelect={(placeId) => store.setPlaceId(String(placeId))}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="theme-label text-[10px] w-10 shrink-0">{t("Job")}</label>
              <input
                value={store.jobId}
                onChange={(e) => store.setJobId(e.target.value)}
                placeholder={t("Job ID")}
                className="sidebar-input flex-1 font-mono text-xs"
              />
              <Tooltip content={t("Shuffle Job ID")}>
                <button
                  onClick={() => store.setShuffleJobId(!store.shuffleJobId)}
                  aria-label={t("Shuffle Job ID")}
                  aria-pressed={store.shuffleJobId}
                  className={`p-1 rounded text-xs ${
                    store.shuffleJobId
                      ? "text-emerald-400 bg-emerald-500/10"
                      : "theme-muted hover:text-[var(--panel-fg)]"
                  }`}
                >
                  <Shuffle size={14} strokeWidth={1.5} />
                </button>
              </Tooltip>
              <Tooltip content={t("Recent servers")}>
                <button
                  ref={recentJobsRef}
                  onClick={() => setRecentJobsOpen((v) => !v)}
                  aria-label={t("Recent servers")}
                  aria-expanded={recentJobsOpen}
                  aria-haspopup="menu"
                  className="theme-muted p-1 rounded hover:text-[var(--panel-fg)]"
                >
                  <History size={14} strokeWidth={1.5} />
                </button>
              </Tooltip>
              <RecentJobsPopover
                open={recentJobsOpen}
                onClose={() => setRecentJobsOpen(false)}
                anchorRef={recentJobsRef}
                onSelect={(raw) => store.setJobId(raw)}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <label className="theme-label text-[10px] w-10 shrink-0">{t("Data")}</label>
              <input
                value={store.launchData}
                onChange={(e) => store.setLaunchData(e.target.value)}
                placeholder={t("Launch Data")}
                className="sidebar-input flex-1 text-xs"
              />
              <button
                onClick={handleSaveLaunchFields}
                disabled={savingLaunchFields}
                className="theme-muted p-1 rounded hover:text-[var(--panel-fg)] disabled:opacity-50 disabled:cursor-not-allowed"
                title={t("Save to selected accounts")}
              >
                <Save size={14} strokeWidth={1.5} />
              </button>
            </div>
          </div>
          <button
            onClick={handleJoin}
            disabled={launching || following}
            className="sidebar-btn theme-btn mt-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {launching ? t("Joining...") : t("Join All ({{count}})", { count })}
          </button>
          <button
            onClick={handleRestartLaunchedClients}
            disabled={launchedSelectedCount === 0 || store.launchProgress?.mode === "multi"}
            className="sidebar-btn theme-btn mt-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {launchedSelectedCount <= 1
              ? t("Restart launched client")
              : t("Restart launched clients ({{count}})", { count: launchedSelectedCount })}
          </button>
          {showBottingButton && (
            <button
              onClick={() => store.setBottingDialogOpen(true)}
              className="sidebar-btn theme-btn mt-1.5 bg-[var(--buttons-bg)]/80 border-[var(--buttons-bc)] animate-fade-in"
            >
              {t("Open Botting Mode")}
            </button>
          )}
          {bottingActive && (
            <button
              onClick={handleAddToBottingMode}
              disabled={addableBottingCount <= 0}
              className="sidebar-btn theme-btn mt-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {addableBottingCount <= 0
                ? t("Already in Botting Mode")
                : t(
                    addableBottingCount === 1
                      ? "Add {{count}} account to Botting Mode"
                      : "Add {{count}} accounts to Botting Mode",
                    { count: addableBottingCount }
                  )}
            </button>
          )}
          <button
            onClick={() => store.killAllRobloxProcesses()}
            className={`sidebar-btn theme-btn mt-1.5 text-amber-200 hover:bg-amber-500/15 ${
              pulseCloseAction ? "animate-pulse" : ""
            }`}
          >
            {t("Close All Roblox")}
          </button>
        </SidebarSection>

        <SidebarSection title={t("Follow")}>
          <div className="flex gap-1.5">
            <input
              value={followUser}
              onChange={(e) => setFollowUser(e.target.value)}
              placeholder={t("Username")}
              className="sidebar-input flex-1 min-w-0"
              onKeyDown={(e) => e.key === "Enter" && handleFollow()}
            />
            <button
              onClick={handleFollow}
              disabled={following || launching}
              className="sidebar-btn-sm shrink-0 whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {following ? t("Following...") : t("Follow All ({{count}})", { count })}
            </button>
          </div>
        </SidebarSection>

        <SidebarSection title={t("Batch Actions")}>
          <div className="flex flex-col gap-1.5">
            <button
              onClick={handleRefreshAll}
              disabled={refreshing}
              className="sidebar-btn theme-btn disabled:opacity-50"
            >
              {refreshing ? t("Refreshing...") : t("Refresh Cookies ({{count}})", { count })}
            </button>
            <button onClick={handleCopyCookies} className="sidebar-btn theme-btn">
              {t("Copy All Cookies")}
            </button>
            <button onClick={handleCopyCombo} className="sidebar-btn theme-btn">
              {t("Copy User:Pass:Cookie")}
            </button>
            <button
              onClick={handleSetDisplayName}
              disabled={settingDisplayName}
              className="sidebar-btn theme-btn disabled:opacity-50"
            >
              {settingDisplayName
                ? t("Setting display names...")
                : t("Set Display Name ({{count}})", { count })}
            </button>

            <div className="relative">
              <button
                onClick={() => setMoveOpen(!moveOpen)}
                className="sidebar-btn theme-btn flex items-center justify-between"
              >
                <span>{t("Move to Group")}</span>
                <ChevronDown size={12} strokeWidth={2} className="theme-muted" />
              </button>
              {moveOpen && (
                <div className="theme-panel theme-border absolute left-0 right-0 top-full mt-1 border rounded-lg shadow-xl z-20 py-1 max-h-40 overflow-y-auto animate-scale-in">
                  {allGroups.map((g) => (
                    <button
                      key={g}
                      onClick={() => handleMoveToGroup(g)}
                      className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--panel-fg)] hover:bg-[var(--panel-soft)] truncate"
                    >
                      {parseGroupName(g).displayName}
                    </button>
                  ))}
                  <div className="theme-border h-px border-t my-1" />
                  <button
                    onClick={handleNewGroup}
                    className="theme-accent w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--panel-soft)]"
                  >
                    {t("+ New Group...")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </SidebarSection>

        <SidebarSection title={t("Danger Zone")}>
          <button
            onClick={async () => {
              if (await confirm(tr("Remove {{count}} accounts?", { count }), true)) {
                store.removeAccounts(accounts.map((a) => a.UserID));
              }
            }}
            className="sidebar-btn theme-btn text-red-300/80 hover:bg-red-500/15 hover:text-red-300"
          >
            {t("Remove All ({{count}})", { count })}
          </button>
        </SidebarSection>
      </div>
    </div>
  );
}
