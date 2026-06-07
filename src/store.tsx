import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Account,
  ThemeData,
  ThumbnailData,
  ParsedGroup,
  PlatformCapabilities,
} from "./types";
import { parseGroupName } from "./types";
import { applyThemeCssVariables, normalizeTheme, DEFAULT_THEME } from "./theme";
import i18n, { normalizeLanguage } from "./i18n";
import { tr } from "./i18n/text";
import {
  type UpdaterReleaseChannel,
  type UpdaterFeatureChannel,
  normalizeUpdaterReleaseChannel,
  normalizeUpdaterFeatureChannel,
  getUpdaterSkipVersionKey,
} from "./updaterChannels";
import { recordRecentGame } from "./components/server-list/types";

interface PresenceEntry {
  userId?: number;
  userPresenceType?: number;
  user_id?: number;
  user_presence_type?: number;
}

interface RunningInstanceEntry {
  userId?: number;
  user_id?: number;
  pid?: number;
}

interface OptimizationWarningPayload {
  pid?: number;
  message?: string;
}

interface LaunchProgressState {
  mode: "single" | "multi";
  current: number;
  total: number;
  userId: number | null;
}

type ActionStatusTone = "info" | "success" | "warn" | "error";

interface ActionStatusState {
  message: string;
  tone: ActionStatusTone;
  at: number;
}

export interface BottingAccountStatus {
  userId: number;
  isPlayer: boolean;
  disconnected: boolean;
  phase: string;
  retryCount: number;
  nextRestartAtMs: number | null;
  playerGraceUntilMs: number | null;
  lastError: string | null;
}

export interface BottingStatus {
  active: boolean;
  startedAtMs: number | null;
  placeId: number;
  jobId: string;
  launchData: string;
  intervalMinutes: number;
  launchDelaySeconds: number;
  playerGraceMinutes: number;
  playerUserIds: number[];
  userIds: number[];
  accounts: BottingAccountStatus[];
}

export interface BottingStartConfig {
  userIds: number[];
  placeId: number;
  jobId: string;
  launchData: string;
  playerUserIds: number[];
  intervalMinutes: number;
  launchDelaySeconds: number;
  playerGraceMinutes: number;
}

export interface GeneratorStatus {
  active: boolean;
  startedAtMs: number | null;
  provider: string;
  endpoint: string;
  accountType: string;
  extraDelaySeconds: number;
  targetGroup: string;
  maxAccounts: number;
  phase: string;
  nextAttemptAtMs: number | null;
  totalGenerated: number;
  lastUsername: string | null;
  lastUserId: number | null;
  lastError: string | null;
  lastGeneratedAtMs: number | null;
}

export interface GeneratorStartConfig {
  provider: string;
  endpoint: string;
  apiKey: string;
  accountType: string;
  extraDelaySeconds: number;
  targetGroup: string;
  maxAccounts: number;
}

export interface StoreValue {
  accounts: Account[];
  groups: ParsedGroup[];
  loadAccounts: () => Promise<void>;
  saveAccounts: () => Promise<void>;
  addAccountByCookie: (cookie: string) => Promise<void>;
  removeAccounts: (userIds: number[]) => Promise<void>;
  updateAccount: (account: Account) => Promise<void>;

  selectedIds: Set<number>;
  selectedAccount: Account | null;
  selectedAccounts: Account[];
  handleSelect: (userId: number, e: React.MouseEvent) => void;
  selectSingle: (userId: number) => void;
  selectAll: () => void;
  deselectAll: () => void;
  toggleSelectAll: () => void;
  setSelectedIds: (ids: Set<number>) => void;
  navigateSelection: (direction: "up" | "down", shift: boolean) => void;
  orderedUserIds: number[];

  searchQuery: string;
  setSearchQuery: (q: string) => void;
  showGroups: boolean;
  setShowGroups: (show: boolean) => void;
  collapsedGroups: Set<string>;
  toggleGroup: (group: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  hideUsernames: boolean;
  setHideUsernames: (hide: boolean) => void;
  hiddenNameLetters: number;
  showAvatarsWhenHidden: boolean;
  hideRobuxWhenHidden: boolean;

  placeId: string;
  setPlaceId: (id: string) => void;
  jobId: string;
  setJobId: (id: string) => void;
  launchData: string;
  setLaunchData: (data: string) => void;
  shuffleJobId: boolean;
  setShuffleJobId: (shuffle: boolean) => void;

  contextMenu: { x: number; y: number } | null;
  openContextMenu: (x: number, y: number) => void;
  closeContextMenu: () => void;

  settings: Record<string, Record<string, string>> | null;
  platformCapabilities: PlatformCapabilities | null;
  theme: ThemeData | null;
  applyThemePreview: (theme: ThemeData) => void;
  saveTheme: (theme: ThemeData) => Promise<void>;
  devMode: boolean;

  avatarUrls: Map<number, string>;
  presenceByUserId: Map<number, number>;
  launchedByProgram: Set<number>;

  joinServer: (userId: number) => Promise<void>;
  launchMultiple: (userIds: number[]) => Promise<void>;
  restartRobloxClients: (userIds: number[]) => Promise<void>;
  focusRobloxClient: (userId: number) => Promise<boolean>;
  killAllRobloxProcesses: () => Promise<void>;
  startBottingMode: (config: BottingStartConfig) => Promise<void>;
  stopBottingMode: (closeBotAccounts: boolean) => Promise<void>;
  addBottingAccounts: (userIds: number[]) => Promise<void>;
  setBottingPlayerAccounts: (userIds: number[]) => Promise<void>;
  bottingAccountAction: (
    userId: number,
    action: "disconnect" | "close" | "closeDisconnect" | "restartClient" | "restartLoop"
  ) => Promise<void>;
  refreshBottingStatus: () => Promise<void>;
  startGenerator: (config: GeneratorStartConfig) => Promise<GeneratorStatus>;
  stopGenerator: () => Promise<void>;
  refreshGeneratorStatus: () => Promise<void>;
  refreshCookie: (userId: number) => Promise<boolean>;
  moveToGroup: (userIds: number[], group: string) => Promise<void>;
  sortGroupAlphabetically: (groupKey: string) => void;
  reorderAccounts: (draggedUserId: number, targetUserId: number) => Promise<void>;
  joiningAccounts: Set<number>;
  launchProgress: LaunchProgressState | null;

  dragState: { userId: number; sourceGroup: string } | null;
  setDragState: (s: { userId: number; sourceGroup: string } | null) => void;

  toasts: string[];
  addToast: (msg: string) => void;
  actionStatus: ActionStatusState | null;
  modal: { title: string; content: string } | null;
  showModal: (title: string, content: string) => void;
  closeModal: () => void;

  error: string | null;
  setError: (e: string | null) => void;
  needsPassword: boolean;
  unlocking: boolean;
  unlock: (password: string) => Promise<void>;
  encryptionSetupOpen: boolean;
  encryptionSetupMode: "firstRun" | "settings";
  accountsEncrypted: boolean | null;
  applyingEncryption: boolean;
  encryptionSetupError: string | null;
  openEncryptionSetupFromSettings: () => void;
  closeEncryptionSetup: () => void;
  applyEncryptionMethod: (method: "default" | "password", password?: string) => Promise<void>;
  firstRunWalkthroughOpen: boolean;
  firstRunWalkthroughMode: "firstRun" | "manual";
  openFirstRunWalkthroughFromSettings: () => void;
  closeFirstRunWalkthrough: () => void;
  completeFirstRunWalkthrough: () => Promise<void>;
  skipFirstRunWalkthrough: () => Promise<void>;
  initialized: boolean;

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  reloadSettings: () => Promise<void>;

  serverListOpen: boolean;
  setServerListOpen: (open: boolean) => void;

  accountUtilsOpen: boolean;
  setAccountUtilsOpen: (open: boolean) => void;
  accountFieldsOpen: boolean;
  setAccountFieldsOpen: (open: boolean) => void;
  importDialogOpen: boolean;
  setImportDialogOpen: (open: boolean) => void;
  importDialogTab: "cookie" | "userpass" | "legacy";
  setImportDialogTab: (tab: "cookie" | "userpass" | "legacy") => void;
  themeEditorOpen: boolean;
  setThemeEditorOpen: (open: boolean) => void;
  bottingDialogOpen: boolean;
  setBottingDialogOpen: (open: boolean) => void;
  bottingStatus: BottingStatus | null;
  generatorDialogOpen: boolean;
  setGeneratorDialogOpen: (open: boolean) => void;
  generatorStatus: GeneratorStatus | null;
  versionsDialogOpen: boolean;
  setVersionsDialogOpen: (open: boolean) => void;
  setDefaultVersion: (versionId: string | null) => void;
  missingAssets: { userId: number; username: string; assetIds: number[] } | null;
  setMissingAssets: (v: { userId: number; username: string; assetIds: number[] } | null) => void;

  nexusOpen: boolean;
  setNexusOpen: (open: boolean) => void;
  scriptsOpen: boolean;
  setScriptsOpen: (open: boolean) => void;

  updateInfo: {
    version: string;
    currentVersion: string;
    date: string;
    body: string;
    releaseChannel: UpdaterReleaseChannel;
    featureChannel: UpdaterFeatureChannel;
  } | null;
  updateDialogOpen: boolean;
  setUpdateDialogOpen: (open: boolean) => void;
  checkForUpdates: (
    manual?: boolean,
    channels?: { releaseChannel?: string; featureChannel?: string }
  ) => Promise<void>;
  openUpdatePreviewDialog: () => void;

  openLoginBrowser: () => Promise<void>;
  openAccountBrowser: (userId: number) => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore requires StoreProvider");
  return ctx;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showGroups, setShowGroups] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [placeId, _setPlaceId] = useState("");
  const [jobId, _setJobId] = useState("");
  const [launchData, _setLaunchData] = useState("");

  const setPlaceId = useCallback((v: string) => {
    _setPlaceId(v);
    invoke("update_setting", { section: "General", key: "SavedPlaceId", value: v }).catch(() => {});
  }, []);
  const setJobId = useCallback((v: string) => {
    _setJobId(v);
    invoke("update_setting", { section: "General", key: "SavedJobId", value: v }).catch(() => {});
  }, []);
  const setLaunchData = useCallback((v: string) => {
    _setLaunchData(v);
    invoke("update_setting", { section: "General", key: "SavedLaunchData", value: v }).catch(() => {});
  }, []);
  const [hideUsernamesState, setHideUsernamesState] = useState(false);
  const hideUsernames = hideUsernamesState;
  const setHideUsernames = useCallback((hide: boolean) => {
    setHideUsernamesState(hide);
    invoke("update_setting", {
      section: "General",
      key: "HideUsernames",
      value: hide ? "true" : "false",
    }).catch(() => {});
  }, []);
  const [shuffleJobId, setShuffleJobId] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settings, setSettings] = useState<Record<string, Record<string, string>> | null>(null);
  const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapabilities | null>(null);
  const [theme, setThemeState] = useState<ThemeData | null>(null);
  const [avatarUrls, setAvatarUrls] = useState<Map<number, string>>(new Map());
  const [presenceByUserId, setPresenceByUserId] = useState<Map<number, number>>(new Map());
  const [launchedByProgram, setLaunchedByProgram] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [encryptionSetupOpen, setEncryptionSetupOpen] = useState(false);
  const [encryptionSetupMode, setEncryptionSetupMode] = useState<"firstRun" | "settings">("firstRun");
  const [accountsEncrypted, setAccountsEncrypted] = useState<boolean | null>(null);
  const [applyingEncryption, setApplyingEncryption] = useState(false);
  const [encryptionSetupError, setEncryptionSetupError] = useState<string | null>(null);
  const [firstRunWalkthroughOpen, setFirstRunWalkthroughOpen] = useState(false);
  const [firstRunWalkthroughMode, setFirstRunWalkthroughMode] = useState<"firstRun" | "manual">("firstRun");
  const [initialized, setInitialized] = useState(false);
  const [dragState, setDragState] = useState<{ userId: number; sourceGroup: string } | null>(null);
  const [toasts, setToasts] = useState<string[]>([]);
  const [modal, setModal] = useState<{ title: string; content: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverListOpen, setServerListOpen] = useState(false);
  const [accountUtilsOpen, setAccountUtilsOpen] = useState(false);
  const [accountFieldsOpen, setAccountFieldsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importDialogTab, setImportDialogTab] = useState<"cookie" | "userpass" | "legacy">("cookie");
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const [bottingDialogOpen, setBottingDialogOpen] = useState(false);
  const [bottingStatus, setBottingStatus] = useState<BottingStatus | null>(null);
  const [generatorDialogOpen, setGeneratorDialogOpen] = useState(false);
  const [generatorStatus, setGeneratorStatus] = useState<GeneratorStatus | null>(null);
  const [versionsDialogOpen, setVersionsDialogOpen] = useState(false);
  const [missingAssets, setMissingAssets] = useState<{ userId: number; username: string; assetIds: number[] } | null>(null);
  const [nexusOpen, setNexusOpen] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    currentVersion: string;
    date: string;
    body: string;
    releaseChannel: UpdaterReleaseChannel;
    featureChannel: UpdaterFeatureChannel;
  } | null>(null);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [joiningAccounts, setJoiningAccounts] = useState<Set<number>>(new Set());
  const [launchProgress, setLaunchProgress] = useState<LaunchProgressState | null>(null);
  const [actionStatus, setActionStatus] = useState<ActionStatusState | null>(null);

  const avatarLoadingRef = useRef<Set<number>>(new Set());
  const launchClearTimeoutRef = useRef<number | null>(null);
  const actionStatusTimeoutRef = useRef<number | null>(null);
  const walkthroughOpenTimeoutRef = useRef<number | null>(null);

  const devMode = settings?.Developer?.DevMode === "true";
  const hiddenNameLetters = parseInt(settings?.General?.HiddenNameLetters || "0") || 0;
  const showAvatarsWhenHidden = settings?.General?.ShowAvatarsWhenHidden === "true";
  const hideRobuxWhenHidden = settings?.General?.HideRobuxWhenHidden === "true";

  const filteredAccounts = useMemo(() => {
    if (!searchQuery) return accounts;
    const q = searchQuery.toLowerCase();
    return accounts.filter(
      (a) =>
        (a.Username || "").toLowerCase().includes(q) ||
        (a.Alias || "").toLowerCase().includes(q) ||
        (a.Description || "").toLowerCase().includes(q) ||
        (a.Group || "").toLowerCase().includes(q)
    );
  }, [accounts, searchQuery]);

  const groups = useMemo(() => {
    if (!showGroups) {
      return [
        {
          key: "__all__",
          displayName: tr("Accounts"),
          sortKey: 0,
          accounts: filteredAccounts,
        },
      ];
    }

    const groupMap = new Map<string, Account[]>();
    for (const account of filteredAccounts) {
      const group = account.Group || "Default";
      if (!groupMap.has(group)) groupMap.set(group, []);
      groupMap.get(group)!.push(account);
    }
    const parsed: ParsedGroup[] = [];
    for (const [key, accts] of groupMap) {
      const { sortKey, displayName } = parseGroupName(key);
      parsed.push({ key, displayName, sortKey, accounts: accts });
    }
    parsed.sort((a, b) => a.sortKey - b.sortKey || a.displayName.localeCompare(b.displayName));
    return parsed;
  }, [filteredAccounts, showGroups]);

  const orderedUserIds = useMemo(() => {
    const ids: number[] = [];
    for (const group of groups) {
      if (!showGroups || !collapsedGroups.has(group.key)) {
        for (const account of group.accounts) ids.push(account.UserID);
      }
    }
    return ids;
  }, [groups, collapsedGroups, showGroups]);

  const selectedAccount = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const id = [...selectedIds][0];
    return accounts.find((a) => a.UserID === id) || null;
  }, [accounts, selectedIds]);

  const selectedAccounts = useMemo(
    () => accounts.filter((a) => selectedIds.has(a.UserID)),
    [accounts, selectedIds]
  );

  const handleSelect = useCallback(
    (userId: number, e: React.MouseEvent) => {
      const toggle = e.altKey || e.ctrlKey || e.metaKey;
      if (e.shiftKey && lastClickedId !== null) {
        const startIdx = orderedUserIds.indexOf(lastClickedId);
        const endIdx = orderedUserIds.indexOf(userId);
        if (startIdx >= 0 && endIdx >= 0) {
          const lo = Math.min(startIdx, endIdx);
          const hi = Math.max(startIdx, endIdx);
          const range = new Set(orderedUserIds.slice(lo, hi + 1));
          if (toggle) {
            setSelectedIds((prev) => new Set([...prev, ...range]));
          } else {
            setSelectedIds(range);
          }
        }
      } else if (toggle) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(userId)) next.delete(userId);
          else next.add(userId);
          return next;
        });
      } else {
        setSelectedIds(new Set([userId]));
      }
      setLastClickedId(userId);
    },
    [lastClickedId, orderedUserIds]
  );

  const selectSingle = useCallback((userId: number) => {
    setSelectedIds(new Set([userId]));
    setLastClickedId(userId);
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(filteredAccounts.map((a) => a.UserID)));
  }, [filteredAccounts]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size > 0) return new Set();
      return new Set(filteredAccounts.map((a) => a.UserID));
    });
  }, [filteredAccounts]);

  const navigateSelection = useCallback(
    (direction: "up" | "down", shift: boolean) => {
      if (orderedUserIds.length === 0) return;

      const anchorId = lastClickedId ?? orderedUserIds[0];
      const currentIdx = orderedUserIds.indexOf(anchorId);
      if (currentIdx < 0) return;

      const nextIdx = direction === "up"
        ? Math.max(0, currentIdx - 1)
        : Math.min(orderedUserIds.length - 1, currentIdx + 1);
      const nextId = orderedUserIds[nextIdx];

      if (shift) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          next.add(nextId);
          return next;
        });
      } else {
        setSelectedIds(new Set([nextId]));
      }
      setLastClickedId(nextId);
    },
    [lastClickedId, orderedUserIds]
  );

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const setActionStatusMessage = useCallback(
    (message: string, tone: ActionStatusTone = "info", timeoutMs = 3500) => {
      // `message` is usually an i18n key, but some call sites pass an already-localized string.
      const localized = i18n.exists(message) ? tr(message) : message;
      if (actionStatusTimeoutRef.current !== null) {
        window.clearTimeout(actionStatusTimeoutRef.current);
        actionStatusTimeoutRef.current = null;
      }
      setActionStatus({
        message: localized,
        tone,
        at: Date.now(),
      });
      if (timeoutMs > 0) {
        actionStatusTimeoutRef.current = window.setTimeout(() => {
          setActionStatus((prev) => (prev?.message === localized ? null : prev));
          actionStatusTimeoutRef.current = null;
        }, timeoutMs);
      }
    },
    []
  );

  const addToast = useCallback((msg: string) => {
    // `msg` is usually an i18n key, but some call sites pass an already-localized string (interpolated).
    const localized = i18n.exists(msg) ? tr(msg) : msg;
    setToasts((prev) => [...prev, localized]);
    setTimeout(() => setToasts((prev) => prev.slice(1)), 2500);
    const lower = msg.toLowerCase();
    let tone: ActionStatusTone = "info";
    if (lower.includes("error") || lower.includes("failed")) tone = "error";
    else if (lower.includes("saved") || lower.includes("updated") || lower.includes("launched")) tone = "success";
    else if (lower.includes("warning")) tone = "warn";
    setActionStatusMessage(msg, tone);
  }, [setActionStatusMessage]);

  function clearLaunchTimeout() {
    if (launchClearTimeoutRef.current !== null) {
      window.clearTimeout(launchClearTimeoutRef.current);
      launchClearTimeoutRef.current = null;
    }
  }

  const showModal = useCallback((title: string, content: string) => {
    setModal({ title, content });
  }, []);

  const closeModal = useCallback(() => setModal(null), []);

  const openContextMenu = useCallback((x: number, y: number) => {
    setContextMenu({ x, y });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  async function loadAvatars(accts: Account[]) {
    const ids = accts
      .map((a) => a.UserID)
      .filter((id) => !avatarUrls.has(id) && !avatarLoadingRef.current.has(id));
    if (ids.length === 0) return;
    ids.forEach((id) => avatarLoadingRef.current.add(id));
    try {
      const results = await invoke<ThumbnailData[]>("batched_get_avatar_headshots", {
        userIds: ids,
        size: "48x48",
      });
      setAvatarUrls((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (r.imageUrl) next.set(r.targetId, r.imageUrl);
        }
        return next;
      });
    } catch {
    } finally {
      ids.forEach((id) => avatarLoadingRef.current.delete(id));
    }
  }

  async function loadAccounts() {
    try {
      const result = await invoke<Account[]>("get_accounts");
      setAccounts(result);
      setError(null);
      loadAvatars(result);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveAccounts() {
    try {
      await invoke("save_accounts");
      addToast(tr("Accounts saved"));
    } catch (e) {
      setError(String(e));
    }
  }

  async function addAccountByCookie(cookie: string) {
    try {
      const info = await invoke<{ user_id: number; name: string }>("validate_cookie", {
        cookie,
      });
      const alreadyExists = accounts.some((a) => a.UserID === info.user_id);
      await invoke("add_account", {
        securityToken: cookie,
        username: info.name,
        userId: info.user_id,
      });
      await loadAccounts();
      addToast(tr(alreadyExists ? "Updated {{name}}" : "Added {{name}}", { name: info.name }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeAccounts(userIds: number[]) {
    try {
      for (const id of userIds) {
        await invoke("remove_account", { userId: id });
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        userIds.forEach((id) => next.delete(id));
        return next;
      });
      await loadAccounts();
      addToast(tr("Removed {{count}} account(s)", { count: userIds.length }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function updateAccount(account: Account) {
    try {
      await invoke("update_account", { account });
      setAccounts((prev) => prev.map((a) => (a.UserID === account.UserID ? account : a)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshCookie(userId: number): Promise<boolean> {
    const ok = await invoke<boolean>("refresh_cookie", { userId });
    await loadAccounts();
    return ok;
  }

  async function moveToGroup(userIds: number[], group: string) {
    const updated = accounts.map((a) =>
      userIds.includes(a.UserID) ? { ...a, Group: group } : a
    );
    setAccounts(updated);
    for (const a of updated) {
      if (userIds.includes(a.UserID)) {
        await invoke("update_account", { account: a }).catch(() => {});
      }
    }
    addToast(tr("Moved to {{group}}", { group: parseGroupName(group).displayName }));
  }

  function sortGroupAlphabetically(groupKey: string) {
    setAccounts((prev) => {
      const targetIndices: number[] = [];
      const targetAccounts: Account[] = [];

      prev.forEach((acc, idx) => {
        if ((acc.Group || "Default") === groupKey) {
          targetIndices.push(idx);
          targetAccounts.push(acc);
        }
      });

      if (targetAccounts.length <= 1) {
        return prev;
      }

      targetAccounts.sort((a, b) => {
        const na = a.Alias || a.Username;
        const nb = b.Alias || b.Username;
        return na.localeCompare(nb);
      });

      const next = [...prev];
      targetIndices.forEach((idx, i) => {
        next[idx] = targetAccounts[i];
      });

      invoke("reorder_accounts", {
        userIds: next.map((a) => a.UserID),
      }).catch(() => {});

      return next;
    });
    addToast(tr("Sorted {{group}}", { group: parseGroupName(groupKey).displayName }));
  }

  async function reorderAccounts(draggedUserId: number, targetUserId: number) {
    if (draggedUserId === targetUserId) return;

    const next = [...accounts];
    const from = next.findIndex((a) => a.UserID === draggedUserId);
    const to = next.findIndex((a) => a.UserID === targetUserId);
    if (from < 0 || to < 0) return;

    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);

    setAccounts(next);

    try {
      await invoke("reorder_accounts", {
        userIds: next.map((a) => a.UserID),
      });
    } catch (e) {
      setError(String(e));
    }
  }

  async function openLoginBrowser() {
    try {
      await invoke("open_login_browser");
    } catch (e) {
      setError(String(e));
    }
  }

  async function openAccountBrowser(userId: number) {
    try {
      await invoke("open_account_browser", { userId });
    } catch (e) {
      setError(String(e));
    }
  }

  async function joinServer(userId: number) {
    clearLaunchTimeout();
    setJoiningAccounts(new Set([userId]));
    setLaunchProgress({
      mode: "single",
      current: 1,
      total: 1,
      userId,
    });
    const launchAccount = accounts.find((a) => a.UserID === userId);
    const accountName = launchAccount?.Alias || launchAccount?.Username || String(userId);
    setActionStatusMessage(tr("Launching {{name}}...", { name: accountName }), "info", 5000);

    try {
      const pid = parseInt(placeId) || 5315046213;
      const rawJobId = jobId.trim();
      let resolvedJobId = rawJobId;
      let joinVip = false;
      let linkCode = "";

      const vipPrefix = rawJobId.match(/^vip:\s*(.+)$/i);
      if (vipPrefix?.[1]) {
        joinVip = true;
        linkCode = vipPrefix[1].trim();
        resolvedJobId = "";
      } else {
        const linkLike = rawJobId.match(/(?:privateServerLinkCode|linkCode|code)=([^&\s]+)/i);
        if (linkLike?.[1]) {
          resolvedJobId = "";
          try {
            linkCode = decodeURIComponent(linkLike[1]);
          } catch {
            linkCode = linkLike[1];
          }
        }
      }

      await invoke("launch_roblox", {
        userId,
        placeId: pid,
        jobId: resolvedJobId,
        launchData,
        followUser: false,
        joinVip,
        linkCode,
        shuffleJob: shuffleJobId,
      });
      await loadAccounts();
      void recordRecentGame(pid, userId, parseInt(settings?.General?.MaxRecentGames || "8") || 8).catch(() => {});
      addToast(tr("Launching game..."));
    } catch (e) {
      setJoiningAccounts((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      setLaunchProgress((prev) => (prev?.mode === "single" && prev.userId === userId ? null : prev));
      setError(String(e));
      setActionStatusMessage(tr("Launch failed: {{error}}", { error: String(e) }), "error", 5000);
      return;
    }

    launchClearTimeoutRef.current = window.setTimeout(() => {
      setJoiningAccounts((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      setLaunchProgress((prev) => (prev?.mode === "single" && prev.userId === userId ? null : prev));
      launchClearTimeoutRef.current = null;
    }, 7000);
  }

  async function launchMultiple(userIds: number[]) {
    if (userIds.length === 0) return;
    if (userIds.length > 1 && platformCapabilities?.os === "linux" && !platformCapabilities.supportsMultiLaunch) {
      const message =
        platformCapabilities.reasons[0] ||
        platformCapabilities.warnings[0] ||
        "Linux multi-launch requires a compatible custom runner and experimental Multi Roblox";
      setError(message);
      setActionStatusMessage(message, "error", 5000);
      throw new Error(message);
    }

    clearLaunchTimeout();
    setJoiningAccounts(new Set([userIds[0]]));
    setLaunchProgress({
      mode: "multi",
      current: 0,
      total: userIds.length,
      userId: userIds[0],
    });
    setActionStatusMessage(tr("Launching {{count}} accounts...", { count: userIds.length }), "info", 5000);

    try {
      const pid = parseInt(placeId) || 5315046213;
      await invoke("launch_multiple", {
        userIds,
        placeId: pid,
        jobId,
        launchData,
      });
      await loadAccounts();
      void recordRecentGame(pid, userIds[0], parseInt(settings?.General?.MaxRecentGames || "8") || 8).catch(() => {});
      addToast(tr("Launching {{count}} accounts...", { count: userIds.length }));
    } catch (e) {
      setJoiningAccounts(new Set());
      setLaunchProgress(null);
      setError(String(e));
      setActionStatusMessage(tr("Launch failed: {{error}}", { error: String(e) }), "error", 5000);
      throw e;
    }
  }

  async function killAllRobloxProcesses() {
    try {
      const killed = await invoke<number>("cmd_kill_all_roblox");
      addToast(killed > 0
        ? tr(killed === 1 ? "Closed {{count}} Roblox process" : "Closed {{count}} Roblox processes", { count: killed })
        : tr("No open Roblox processes found"));
      setError(null);
    } catch (e) {
      setError(String(e));
      setActionStatusMessage(tr("Failed to close Roblox: {{error}}", { error: String(e) }), "error", 5000);
    }
  }

  async function focusRobloxClient(userId: number): Promise<boolean> {
    try {
      return await invoke<boolean>("focus_roblox_window", { userId });
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }

  async function restartRobloxClients(userIds: number[]) {
    const uniqueIds = Array.from(new Set(userIds));
    const launchedIds = uniqueIds.filter((userId) => launchedByProgram.has(userId));
    if (launchedIds.length === 0) {
      addToast(tr("No launched Roblox clients selected"));
      return;
    }

    let closeFailures = 0;
    for (const userId of launchedIds) {
      try {
        const closed = await invoke<boolean>("cmd_kill_roblox", { userId });
        if (!closed) closeFailures += 1;
      } catch {
        closeFailures += 1;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    if (closeFailures > 0) {
      addToast(tr("Some clients could not be closed before restart"));
    }

    if (launchedIds.length === 1) {
      await joinServer(launchedIds[0]);
      return;
    }

    try {
      await launchMultiple(launchedIds);
    } catch {
    }
  }

  async function refreshBottingStatus() {
    try {
      const status = await invoke<BottingStatus>("get_botting_mode_status");
      setBottingStatus(status);
    } catch (e) {
      setError(String(e));
    }
  }

  async function startBottingMode(config: BottingStartConfig) {
    if (platformCapabilities?.os === "linux" && !platformCapabilities.supportsBotting) {
      const message =
        platformCapabilities.reasons[0] ||
        platformCapabilities.warnings[0] ||
        "Botting Mode is unavailable for the active Linux runner";
      setError(message);
      throw new Error(message);
    }
    try {
      const status = await invoke<BottingStatus>("start_botting_mode", {
        userIds: config.userIds,
        placeId: config.placeId,
        jobId: config.jobId,
        launchData: config.launchData,
        playerUserIds: config.playerUserIds,
        intervalMinutes: config.intervalMinutes,
        launchDelaySeconds: config.launchDelaySeconds,
        playerGraceMinutes: config.playerGraceMinutes,
      });
      setBottingStatus(status);
      addToast(tr("Botting Mode started ({{count}} accounts)", { count: config.userIds.length }));
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }

  async function stopBottingMode(closeBotAccounts: boolean) {
    try {
      await invoke("stop_botting_mode", { closeBotAccounts });
      await refreshBottingStatus();
      addToast(tr(closeBotAccounts
        ? "Botting Mode stopped and bot accounts closed"
        : "Botting Mode stopped"));
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }

  async function addBottingAccounts(userIds: number[]) {
    if (userIds.length === 0) return;
    try {
      const status = await invoke<BottingStatus>("add_botting_accounts", {
        userIds,
      });
      setBottingStatus(status);
      addToast(
        tr(
          userIds.length === 1
            ? "Added {{count}} account to Botting Mode"
            : "Added {{count}} accounts to Botting Mode",
          { count: userIds.length }
        )
      );
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }

  async function setBottingPlayerAccounts(userIds: number[]) {
    try {
      const status = await invoke<BottingStatus>("set_botting_player_accounts", {
        playerUserIds: userIds,
      });
      setBottingStatus(status);
      addToast(tr(userIds.length === 0 ? "Player accounts cleared" : "Player accounts updated"));
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }

  async function bottingAccountAction(
    userId: number,
    action: "disconnect" | "close" | "closeDisconnect" | "restartClient" | "restartLoop"
  ) {
    try {
      const status = await invoke<BottingStatus>("botting_account_action", {
        userId,
        action,
      });
      setBottingStatus(status);
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }

  async function refreshGeneratorStatus() {
    try {
      const status = await invoke<GeneratorStatus>("get_generator_status");
      setGeneratorStatus(status);
    } catch (e) {
      setError(String(e));
    }
  }

  async function startGenerator(config: GeneratorStartConfig) {
    try {
      const status = await invoke<GeneratorStatus>("start_generator", {
        provider: config.provider,
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        accountType: config.accountType,
        extraDelaySeconds: config.extraDelaySeconds,
        targetGroup: config.targetGroup,
        maxAccounts: config.maxAccounts,
      });
      setGeneratorStatus(status);
      addToast(tr("Account generator started"));
      return status;
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }

  async function stopGenerator() {
    try {
      await invoke("stop_generator");
      await refreshGeneratorStatus();
      addToast(tr("Account generator stopped"));
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }

  const applyThemePreview = useCallback((nextTheme: ThemeData) => {
    const normalized = normalizeTheme(nextTheme);
    setThemeState(normalized);
    applyThemeCssVariables(normalized);
  }, []);

  const saveTheme = useCallback(async (nextTheme: ThemeData) => {
    const normalized = normalizeTheme(nextTheme);
    await invoke("update_theme", { theme: normalized });
    setThemeState(normalized);
    applyThemeCssVariables(normalized);
  }, []);

  async function reloadSettings() {
    try {
      const s = await invoke<Record<string, Record<string, string>>>("get_all_settings");
      setSettings(s);
      void i18n.changeLanguage(normalizeLanguage(s?.General?.Language));
      try {
        const capabilities = await invoke<PlatformCapabilities>("get_platform_capabilities");
        setPlatformCapabilities(capabilities);
      } catch {
      }
    } catch {}
  }

  const refreshPlatformCapabilities = useCallback(async () => {
    try {
      const capabilities = await invoke<PlatformCapabilities>("get_platform_capabilities");
      setPlatformCapabilities(capabilities);
    } catch {
    }
  }, []);

  const refreshEncryptionState = useCallback(async () => {
    try {
      const encrypted = await invoke<boolean>("is_accounts_encrypted");
      setAccountsEncrypted(encrypted);
    } catch {}
  }, []);

  const openEncryptionSetupFromSettings = useCallback(() => {
    setEncryptionSetupError(null);
    setEncryptionSetupMode("settings");
    setEncryptionSetupOpen(true);
    void refreshEncryptionState();
  }, [refreshEncryptionState]);

  const closeEncryptionSetup = useCallback(() => {
    if (encryptionSetupMode === "firstRun") return;
    setEncryptionSetupOpen(false);
    setEncryptionSetupError(null);
  }, [encryptionSetupMode]);

  const openFirstRunWalkthroughFromSettings = useCallback(() => {
    if (walkthroughOpenTimeoutRef.current !== null) {
      window.clearTimeout(walkthroughOpenTimeoutRef.current);
      walkthroughOpenTimeoutRef.current = null;
    }
    setSettingsOpen(false);
    setFirstRunWalkthroughMode("manual");
    setFirstRunWalkthroughOpen(false);
    walkthroughOpenTimeoutRef.current = window.setTimeout(() => {
      setFirstRunWalkthroughOpen(true);
      walkthroughOpenTimeoutRef.current = null;
    }, 120);
  }, []);

  const closeFirstRunWalkthrough = useCallback(() => {
    if (walkthroughOpenTimeoutRef.current !== null) {
      window.clearTimeout(walkthroughOpenTimeoutRef.current);
      walkthroughOpenTimeoutRef.current = null;
    }
    setFirstRunWalkthroughOpen(false);
    setFirstRunWalkthroughMode("manual");
  }, []);

  const setDefaultVersion = useCallback(
    async (versionId: string | null) => {
      const value = versionId ?? "";
      const previous = settings?.Versions?.DefaultVersion ?? "";
      setSettings((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          Versions: {
            ...(prev.Versions || {}),
            DefaultVersion: value,
          },
        };
      });
      try {
        await invoke("versions_set_default", { versionId });
      } catch (e) {
        setSettings((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            Versions: {
              ...(prev.Versions || {}),
              DefaultVersion: previous,
            },
          };
        });
        addToast(tr("Failed to set version: {{error}}", { error: String(e) }));
      }
    },
    [addToast, settings]
  );

  const setFirstRunWalkthroughStateLocal = useCallback((state: "completed" | "skipped") => {
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        General: {
          ...(prev.General || {}),
          FirstRunWalkthroughState: state,
        },
      };
    });
  }, []);

  const persistFirstRunWalkthroughState = useCallback(async (state: "completed" | "skipped") => {
    await invoke("update_setting", {
      section: "General",
      key: "FirstRunWalkthroughState",
      value: state,
    }).catch(() => {});
  }, []);

  const completeFirstRunWalkthrough = useCallback(async () => {
    const shouldPersist =
      firstRunWalkthroughMode === "firstRun" ||
      settings?.General?.FirstRunWalkthroughState === "pending";

    if (shouldPersist) {
      setFirstRunWalkthroughStateLocal("completed");
    }
    setFirstRunWalkthroughOpen(false);

    if (shouldPersist) {
      await persistFirstRunWalkthroughState("completed");
      addToast(tr("First-Time Walkthrough complete"));
    }
    setFirstRunWalkthroughMode("manual");
  }, [
    addToast,
    firstRunWalkthroughMode,
    persistFirstRunWalkthroughState,
    setFirstRunWalkthroughStateLocal,
    settings?.General?.FirstRunWalkthroughState,
  ]);

  const skipFirstRunWalkthrough = useCallback(async () => {
    const shouldPersist =
      firstRunWalkthroughMode === "firstRun" ||
      settings?.General?.FirstRunWalkthroughState === "pending";

    if (shouldPersist) {
      setFirstRunWalkthroughStateLocal("skipped");
    }
    setFirstRunWalkthroughOpen(false);

    if (shouldPersist) {
      await persistFirstRunWalkthroughState("skipped");
      addToast(tr("First-Time Walkthrough skipped"));
    }
    setFirstRunWalkthroughMode("manual");
  }, [
    addToast,
    firstRunWalkthroughMode,
    persistFirstRunWalkthroughState,
    setFirstRunWalkthroughStateLocal,
    settings?.General?.FirstRunWalkthroughState,
  ]);

  const applyEncryptionMethod = useCallback(async (method: "default" | "password", password?: string) => {
    setApplyingEncryption(true);
    setEncryptionSetupError(null);
    setError(null);
    try {
      if (method === "password") {
        await invoke("set_encryption_password", {
          password: password ?? "",
        });
      } else {
        await invoke("set_encryption_password", { password: null });
      }

      await Promise.all([
        invoke("update_setting", {
          section: "General",
          key: "EncryptionOnboardingState",
          value: "completed",
        }),
        invoke("update_setting", {
          section: "General",
          key: "EncryptionMethod",
          value: method,
        }),
      ]);

      setSettings((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          General: {
            ...(prev.General || {}),
            EncryptionOnboardingState: "completed",
            EncryptionMethod: method,
          },
        };
      });

      await refreshEncryptionState();
      await loadAccounts();
      setEncryptionSetupOpen(false);
      setEncryptionSetupMode("settings");
      if (
        encryptionSetupMode === "firstRun" &&
        (settings?.General?.FirstRunWalkthroughState ?? "pending") === "pending"
      ) {
        setFirstRunWalkthroughMode("firstRun");
        setFirstRunWalkthroughOpen(true);
      }
      addToast(method === "password" ? tr("Password lock enabled") : tr("Default encryption enabled"));
    } catch (e) {
      setEncryptionSetupError(String(e));
      throw e;
    } finally {
      setApplyingEncryption(false);
    }
  }, [
    addToast,
    encryptionSetupMode,
    loadAccounts,
    refreshEncryptionState,
    settings?.General?.FirstRunWalkthroughState,
  ]);

  async function unlock(password: string) {
    setUnlocking(true);
    setError(null);
    try {
      await invoke("unlock_accounts", { password });
      setNeedsPassword(false);
      await loadAccounts();
      await refreshEncryptionState();
    } catch (e) {
      setError(String(e));
    } finally {
      setUnlocking(false);
    }
  }

  useEffect(() => {
    (async () => {
      // Apply defaults immediately so the UI has a consistent baseline while we load persisted theme.
      applyThemePreview(DEFAULT_THEME);
      let needs = false;
      let loadedAccounts: Account[] = [];
      let accountsLoaded = false;
      try {
        needs = await invoke<boolean>("needs_password");
        setNeedsPassword(needs);
        if (!needs) {
          loadedAccounts = await invoke<Account[]>("get_accounts");
          setAccounts(loadedAccounts);
          setError(null);
          loadAvatars(loadedAccounts);
          accountsLoaded = true;
        }
      } catch (e) {
        setError(String(e));
      }

      let loadedSettings: Record<string, Record<string, string>> | null = null;
      try {
        const s = await invoke<Record<string, Record<string, string>>>("get_all_settings");
        loadedSettings = s;
        setSettings(s);
        try {
          const capabilities = await invoke<PlatformCapabilities>("get_platform_capabilities");
          setPlatformCapabilities(capabilities);
        } catch {
        }
        void i18n.changeLanguage(normalizeLanguage(s?.General?.Language));
        if (s?.General?.HideUsernames === "true") setHideUsernamesState(true);
        if (s?.General?.ShuffleJobId === "true") setShuffleJobId(true);
        if (s?.General?.SavedPlaceId) _setPlaceId(s.General.SavedPlaceId);
        if (s?.General?.SavedJobId) _setJobId(s.General.SavedJobId);
        if (s?.General?.SavedLaunchData) _setLaunchData(s.General.SavedLaunchData);
      } catch {}

      await refreshEncryptionState();

      if (
        !needs &&
        accountsLoaded &&
        loadedAccounts.length === 0 &&
        loadedSettings?.General?.EncryptionOnboardingState === "pending"
      ) {
        setEncryptionSetupError(null);
        setEncryptionSetupMode("firstRun");
        setEncryptionSetupOpen(true);
      }

      if (
        !needs &&
        loadedSettings?.General?.FirstRunWalkthroughState === "pending" &&
        loadedSettings?.General?.EncryptionOnboardingState !== "pending"
      ) {
        setFirstRunWalkthroughMode("firstRun");
        setFirstRunWalkthroughOpen(true);
      }

      try {
        const t = await invoke<ThemeData>("get_theme");
        applyThemePreview(t);
      } catch {}
      setInitialized(true);
    })();
  }, [applyThemePreview, refreshEncryptionState]);

  useEffect(() => {
    if (!initialized || needsPassword) return;
    if (encryptionSetupOpen || firstRunWalkthroughOpen) return;
    if (settings?.General?.FirstRunWalkthroughState !== "pending") return;
    if (settings?.General?.EncryptionOnboardingState === "pending") return;
    setFirstRunWalkthroughMode("firstRun");
    setFirstRunWalkthroughOpen(true);
  }, [
    encryptionSetupOpen,
    firstRunWalkthroughOpen,
    initialized,
    needsPassword,
    settings?.General?.EncryptionOnboardingState,
    settings?.General?.FirstRunWalkthroughState,
  ]);

  useEffect(() => {
    void i18n.changeLanguage(normalizeLanguage(settings?.General?.Language));
  }, [settings?.General?.Language]);

  useEffect(() => {
    if (!initialized) return;
    void refreshPlatformCapabilities();
  }, [
    initialized,
    refreshPlatformCapabilities,
    settings?.Linux?.PreferredRunner,
    settings?.Linux?.CustomLaunchCommand,
    settings?.Linux?.CustomProcessMatch,
    settings?.Linux?.CustomLogDir,
    settings?.Linux?.EnableExperimentalMultiRbx,
    settings?.Linux?.WindowControlBackend,
  ]);

  useEffect(() => {
    if (!theme) return;
    const normalized = normalizeTheme(theme);
    const themedNavbar = settings?.General?.ThemeWindowsNavbar === "true";
    const style = document.documentElement.style;

    if (themedNavbar) {
      style.setProperty("--titlebar-bg", normalized.forms_background);
      style.setProperty("--titlebar-fg", normalized.forms_foreground);
    } else {
      style.setProperty("--titlebar-bg", normalized.dark_top_bar ? "#09090b" : normalized.forms_background);
      style.setProperty("--titlebar-fg", normalized.dark_top_bar ? "#a1a1aa" : normalized.forms_foreground);
    }
  }, [theme, settings?.General?.ThemeWindowsNavbar]);

  useEffect(() => {
    if (!initialized) return;
    void invoke("sync_windows_navbar_theme").catch(() => {});
  }, [initialized, settings?.General?.ThemeWindowsNavbar, theme?.dark_top_bar]);

  useEffect(() => {
    const unlisten = listen("browser-login-detected", async () => {
      let cookie = "";
      for (let i = 0; i < 8; i++) {
        try {
          cookie = await invoke<string>("extract_browser_cookie");
          if (cookie.trim().length > 0) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 350));
      }

      if (cookie.trim().length === 0) {
        addToast("No .ROBLOSECURITY cookie found after login. Please try again.");
        await invoke("close_login_browser").catch(() => {});
        return;
      }

      await addAccountByCookie(cookie);
      await invoke("close_login_browser").catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ stage: string; downloaded: number; total: number }>(
      "chromium-download-progress",
      (e) => {
        const { stage, downloaded, total } = e.payload;
        if (stage === "downloading") {
          const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          setActionStatusMessage(tr("Downloading browser ({{percent}}%)", { percent: pct }), "info", 4000);
        } else if (stage === "extracting") {
          setActionStatusMessage(tr("Preparing browser..."), "info", 4000);
        } else if (stage === "ready") {
          setActionStatusMessage(tr("Browser ready"), "success", 3000);
        }
      }
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setActionStatusMessage]);

  useEffect(() => {
    if (needsPassword || !initialized) return;

    const unsubs: Array<() => void> = [];

    const listeners = [
      listen<{ userId: number; index: number; total: number }>("launch-progress", (e) => {
        const current = (e.payload.index ?? 0) + 1;
        const total = Math.max(1, e.payload.total ?? 1);
        const userId = e.payload.userId ?? null;
        setLaunchProgress({
          mode: "multi",
          current: Math.min(current, total),
          total,
          userId,
        });
        setJoiningAccounts(userId !== null ? new Set([userId]) : new Set());
        setActionStatusMessage(tr("Launching account {{current}}/{{total}}...", { current, total }), "info", 2000);
      }),
      listen("launch-complete", () => {
        setJoiningAccounts(new Set());
        setLaunchProgress((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            current: prev.total,
          };
        });
        setActionStatusMessage(tr("Launch sequence complete"), "success", 3000);
        clearLaunchTimeout();
        launchClearTimeoutRef.current = window.setTimeout(() => {
          setLaunchProgress((prev) => (prev?.mode === "multi" ? null : prev));
          launchClearTimeoutRef.current = null;
        }, 1500);
      }),
      listen<OptimizationWarningPayload>("roblox-optimization-warning", (e) => {
        const pid = typeof e.payload?.pid === "number" ? e.payload.pid : null;
        const message =
          typeof e.payload?.message === "string" && e.payload.message.trim().length > 0
            ? e.payload.message.trim()
            : tr("Unknown");
        addToast(
          pid !== null
            ? tr("Optimization warning for PID {{pid}}: {{message}}", { pid, message })
            : tr("Optimization warning: {{message}}", { message })
        );
      }),
    ];

    Promise.all(listeners).then((fns) => fns.forEach((fn) => unsubs.push(fn)));

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [needsPassword, initialized, setActionStatusMessage, addToast]);

  useEffect(() => {
    if (needsPassword || !initialized) return;

    refreshBottingStatus();
    refreshGeneratorStatus();
    const unsubs: Array<() => void> = [];
    const listeners = [
      listen<BottingStatus>("botting-status", (e) => {
        setBottingStatus(e.payload);
      }),
      listen<GeneratorStatus>("generator-status", (e) => {
        setGeneratorStatus(e.payload);
      }),
      listen("generator-account-added", () => {
        loadAccounts();
      }),
      listen("generator-stopped", () => {
        setGeneratorStatus((prev) => (prev ? { ...prev, active: false } : prev));
      }),
      listen("botting-stopped", () => {
        setBottingStatus((prev) =>
          prev
            ? { ...prev, active: false }
            : {
                active: false,
                startedAtMs: null,
                placeId: 0,
                jobId: "",
                launchData: "",
                intervalMinutes: 19,
                launchDelaySeconds: 20,
                playerGraceMinutes: 15,
                playerUserIds: [],
                userIds: [],
                accounts: [],
              }
        );
      }),
      listen<{ userId?: number; ok?: boolean; error?: string | null }>("botting-account-cycle", (e) => {
        const uid = e.payload?.userId;
        const ok = e.payload?.ok;
        if (typeof uid === "number" && ok === false) {
          const errorText =
            typeof e.payload?.error === "string" && e.payload.error.trim().length > 0
              ? `: ${e.payload.error}`
              : "";
          setActionStatusMessage(
            `${tr("Botting rejoin failed for {{userId}}", { userId: uid })}${errorText}`,
            "warn",
            3500
          );
        }
      }),
    ];
    Promise.all(listeners).then((fns) => fns.forEach((fn) => unsubs.push(fn)));

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [needsPassword, initialized, setActionStatusMessage]);

  useEffect(() => {
    if (needsPassword || !initialized) return;

    let cancelled = false;
    const refreshRunningInstances = async () => {
      try {
        const rows = await invoke<RunningInstanceEntry[]>("get_running_instances");
        const next = new Set<number>();
        for (const row of rows) {
          const userId = row.userId ?? row.user_id;
          if (typeof userId === "number") {
            next.add(userId);
          }
        }
        if (!cancelled) {
          setLaunchedByProgram(next);
        }
      } catch {
      }
    };

    refreshRunningInstances();
    const timer = window.setInterval(refreshRunningInstances, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [needsPassword, initialized]);

  useEffect(() => {
    function onActionStatus(event: Event) {
      const custom = event as CustomEvent<{ message?: string; tone?: ActionStatusTone; timeoutMs?: number }>;
      if (!custom.detail?.message) return;
      setActionStatusMessage(
        custom.detail.message,
        custom.detail.tone || "success",
        custom.detail.timeoutMs ?? 2800
      );
    }
    window.addEventListener("ram-action-status", onActionStatus as EventListener);
    return () => {
      window.removeEventListener("ram-action-status", onActionStatus as EventListener);
    };
  }, [setActionStatusMessage]);

  useEffect(() => {
    if (needsPassword || !initialized) return;

    if (settings?.General?.ShowPresence !== "true") {
      setPresenceByUserId(new Map());
      return;
    }

    let cancelled = false;
    const userIds = accounts.map((a) => a.UserID);
    const intervalMinutes = Math.max(
      1,
      parseInt(settings?.General?.PresenceUpdateRate || "5", 10) || 5
    );
    const intervalMs = Math.max(30_000, intervalMinutes * 60 * 1000);

    const refreshPresence = async () => {
      if (userIds.length === 0) {
        if (!cancelled) setPresenceByUserId(new Map());
        return;
      }

      const next = new Map<number, number>();
      try {
        for (let i = 0; i < userIds.length; i += 100) {
          const chunk = userIds.slice(i, i + 100);
          const result = await invoke<PresenceEntry[]>("get_presence", { userIds: chunk });
          for (const presence of result) {
            const userId = presence.userId ?? presence.user_id;
            const presenceType = presence.userPresenceType ?? presence.user_presence_type ?? 0;
            if (typeof userId === "number") {
              next.set(userId, presenceType);
            }
          }
        }
        if (!cancelled) {
          setPresenceByUserId(next);
        }
      } catch {
      }
    };

    refreshPresence();
    const timer = window.setInterval(refreshPresence, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    accounts,
    settings?.General?.ShowPresence,
    settings?.General?.PresenceUpdateRate,
    needsPassword,
    initialized,
  ]);

  useEffect(() => {
    if (needsPassword || !initialized) return;
    const autoRefresh = settings?.General?.AutoCookieRefresh;
    if (autoRefresh === "false") return;

    const interval = window.setInterval(async () => {
      const now = Date.now();
      for (const account of accounts) {
        if (account.Fields?.NoCookieRefresh === "true") continue;
        const daysSinceUse = (now - new Date(account.LastUse).getTime()) / 86400000;
        if (daysSinceUse < 20) continue;
        const daysSinceRefresh =
          (now - new Date(account.LastAttemptedRefresh).getTime()) / 86400000;
        if (daysSinceRefresh < 7) continue;
        await refreshCookie(account.UserID);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [accounts, needsPassword, initialized, settings]);

  useEffect(() => {
    if (needsPassword || !initialized) return;
    if (settings?.Watcher?.Enabled !== "true") {
      invoke("stop_watcher").catch(() => {});
      return;
    }

    let disposed = false;
    const unsubs: Array<() => void> = [];
    invoke("start_watcher").catch(() => {});

    const listeners = [
      listen<{ userId: number }>("roblox-process-died", (e) => {
        addToast(tr("Watcher: process closed for {{userId}}", { userId: e.payload.userId }));
      }),
      listen<{ userId: number; memoryMb: number }>("roblox-low-memory", (e) => {
        addToast(tr("Watcher: low memory {{memoryMb}}MB ({{userId}})", { memoryMb: e.payload.memoryMb, userId: e.payload.userId }));
      }),
      listen<{ userId: number; expected: string }>("roblox-title-mismatch", (e) => {
        addToast(tr("Watcher: title mismatch for {{userId}} ({{expected}})", { userId: e.payload.userId, expected: e.payload.expected }));
      }),
      listen<{ userId: number; title: string }>("roblox-beta-detected", (e) => {
        addToast(tr("Watcher: beta build detected for {{userId}}", { userId: e.payload.userId }));
      }),
      listen<{ userId: number; timeout: number }>("roblox-no-connection", (e) => {
        addToast(tr("Watcher: no connection timeout ({{timeout}}s) for {{userId}}", { timeout: e.payload.timeout, userId: e.payload.userId }));
      }),
    ];

    Promise.all(listeners)
      .then((fns) => {
        if (disposed) {
          fns.forEach((fn) => fn());
          return;
        }
        fns.forEach((fn) => unsubs.push(fn));
      })
      .catch(() => {});

    return () => {
      disposed = true;
      invoke("stop_watcher").catch(() => {});
      unsubs.forEach((fn) => fn());
    };
  }, [needsPassword, initialized, settings?.Watcher?.Enabled, addToast]);

  useEffect(() => {
    return () => {
      clearLaunchTimeout();
      if (actionStatusTimeoutRef.current !== null) {
        window.clearTimeout(actionStatusTimeoutRef.current);
        actionStatusTimeoutRef.current = null;
      }
      if (walkthroughOpenTimeoutRef.current !== null) {
        window.clearTimeout(walkthroughOpenTimeoutRef.current);
        walkthroughOpenTimeoutRef.current = null;
      }
    };
  }, []);

  const checkForUpdates = useCallback(async (
    manual?: boolean,
    channels?: { releaseChannel?: string; featureChannel?: string }
  ) => {
    if (!manual && settings?.General?.CheckForUpdates === "false") return;

    const releaseChannel = normalizeUpdaterReleaseChannel(
      channels?.releaseChannel ?? settings?.General?.UpdaterReleaseChannel ?? "beta"
    );
    const featureChannel = normalizeUpdaterFeatureChannel(
      channels?.featureChannel ?? settings?.General?.UpdaterFeatureChannel ?? "standard"
    );

    try {
      const update = await invoke<{
        version: string;
        currentVersion: string;
        date: string;
        body: string;
        releaseChannel: UpdaterReleaseChannel;
        featureChannel: UpdaterFeatureChannel;
      } | null>("check_for_updates_with_channels", {
        releaseChannel,
        featureChannel,
      });

      if (!update) {
        if (manual) addToast(tr("No updates available"));
        return;
      }

      const resolvedReleaseChannel = normalizeUpdaterReleaseChannel(update.releaseChannel);
      const resolvedFeatureChannel = normalizeUpdaterFeatureChannel(update.featureChannel);
      const skipped = localStorage.getItem(
        getUpdaterSkipVersionKey(resolvedReleaseChannel, resolvedFeatureChannel)
      );
      if (!manual && skipped === update.version) return;

      setUpdateInfo({
        version: update.version,
        currentVersion: update.currentVersion,
        date: update.date ?? "",
        body: update.body ?? "",
        releaseChannel: resolvedReleaseChannel,
        featureChannel: resolvedFeatureChannel,
      });
      setUpdateDialogOpen(true);
    } catch (e) {
      if (manual) addToast(tr("Update check failed"));
    }
  }, [
    settings?.General?.CheckForUpdates,
    settings?.General?.UpdaterFeatureChannel,
    settings?.General?.UpdaterReleaseChannel,
    addToast,
  ]);

  const openUpdatePreviewDialog = useCallback(() => {
    const previewBody = [
      "> [!WARNING]",
      "> This is a beta release. Missing features, bugs and crashes are possible. Run at your own risk.",
      "",
      "Channel: Beta",
      "Release commit: d9530e6",
      "Release commit message: Merge pull request #21 from niccsprojects/fix/windows-client-settings-runtime-overrides",
      "App version: 4.2.6",
      "",
      "## What's Changed",
      "",
      "\\* fix(client-settings): add Windows runtime overrides via GlobalBasicSettings_13.xml by @niccdevs in #21",
      "* fix(update-dialog): render release notes with GitHub-style bullets, callouts, and links",
      "* chore(ui): improve update modal note spacing for long changelogs",
      "",
      "Full Changelog: https://github.com/niccsprojects/Roblox-Account-Manager/compare/v4.2.5-beta...v4.2.6-beta",
      "",
      "## Contributors",
      "",
      "<a href=\"https://github.com/niccdevs\"><img src=\"https://github.com/niccdevs.png?size=64\" width=\"32\" height=\"32\" alt=\"@niccdevs\" /></a>",
      "",
      "[@niccdevs](https://github.com/niccdevs)",
    ].join("\n");

    setUpdateInfo({
      version: "4.2.6-beta",
      currentVersion: "4.2.5",
      date: new Date().toISOString(),
      body: previewBody,
      releaseChannel: "beta",
      featureChannel: "standard",
    });
    setUpdateDialogOpen(true);
  }, []);

  const value: StoreValue = {
    accounts,
    groups,
    loadAccounts,
    saveAccounts,
    addAccountByCookie,
    removeAccounts,
    updateAccount,
    selectedIds,
    selectedAccount,
    selectedAccounts,
    handleSelect,
    selectSingle,
    selectAll,
    deselectAll,
    toggleSelectAll,
    setSelectedIds,
    navigateSelection,
    orderedUserIds,
    searchQuery,
    setSearchQuery,
    showGroups,
    setShowGroups,
    collapsedGroups,
    toggleGroup,
    sidebarOpen,
    setSidebarOpen,
    hideUsernames,
    setHideUsernames,
    hiddenNameLetters,
    showAvatarsWhenHidden,
    hideRobuxWhenHidden,
    placeId,
    setPlaceId,
    jobId,
    setJobId,
    launchData,
    setLaunchData,
    shuffleJobId,
    setShuffleJobId,
    contextMenu,
    openContextMenu,
    closeContextMenu,
    settings,
    platformCapabilities,
    theme,
    applyThemePreview,
    saveTheme,
    devMode,
    avatarUrls,
    presenceByUserId,
    launchedByProgram,
    joinServer,
    launchMultiple,
    restartRobloxClients,
    focusRobloxClient,
    killAllRobloxProcesses,
    startBottingMode,
    stopBottingMode,
    addBottingAccounts,
    setBottingPlayerAccounts,
    bottingAccountAction,
    refreshBottingStatus,
    startGenerator,
    stopGenerator,
    refreshGeneratorStatus,
    refreshCookie,
    moveToGroup,
    sortGroupAlphabetically,
    reorderAccounts,
    joiningAccounts,
    launchProgress,
    dragState,
    setDragState,
    toasts,
    addToast,
    actionStatus,
    modal,
    showModal,
    closeModal,
    error,
    setError,
    needsPassword,
    unlocking,
    unlock,
    encryptionSetupOpen,
    encryptionSetupMode,
    accountsEncrypted,
    applyingEncryption,
    encryptionSetupError,
    openEncryptionSetupFromSettings,
    closeEncryptionSetup,
    applyEncryptionMethod,
    firstRunWalkthroughOpen,
    firstRunWalkthroughMode,
    openFirstRunWalkthroughFromSettings,
    closeFirstRunWalkthrough,
    completeFirstRunWalkthrough,
    skipFirstRunWalkthrough,
    initialized,
    settingsOpen,
    setSettingsOpen,
    reloadSettings,
    serverListOpen,
    setServerListOpen,
    accountUtilsOpen,
    setAccountUtilsOpen,
    accountFieldsOpen,
    setAccountFieldsOpen,
    importDialogOpen,
    setImportDialogOpen,
    importDialogTab,
    setImportDialogTab,
    themeEditorOpen,
    setThemeEditorOpen,
    bottingDialogOpen,
    setBottingDialogOpen,
    bottingStatus,
    generatorDialogOpen,
    setGeneratorDialogOpen,
    generatorStatus,
    versionsDialogOpen,
    setVersionsDialogOpen,
    setDefaultVersion,
    missingAssets,
    setMissingAssets,
    nexusOpen,
    setNexusOpen,
    scriptsOpen,
    setScriptsOpen,
    updateInfo,
    updateDialogOpen,
    setUpdateDialogOpen,
    checkForUpdates,
    openUpdatePreviewDialog,
    openLoginBrowser,
    openAccountBrowser,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
