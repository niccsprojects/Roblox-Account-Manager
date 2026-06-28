import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X, Download, Trash2, FolderOpen, Star, StarOff, Pencil, RefreshCw } from "lucide-react";
import { useModalClose } from "../../hooks/useModalClose";
import { useTr } from "../../i18n/text";
import { useStore } from "../../store";

interface VersionEntry {
  channel: string;
  versionHash: string;
  binaryType: string;
  displayVersion: string | null;
  installPath: string;
  installSizeBytes: number;
  installedAt: string | null;
  lastLaunchedAt: string | null;
  userLabel: string | null;
  exists: boolean;
}

interface RemoteVersionEntry {
  binaryType: string;
  versionHash: string;
  displayVersion: string | null;
  deployDate: string | null;
  channel: string;
}

interface RemoteCatalog {
  current: RemoteVersionEntry[];
  past: RemoteVersionEntry[];
  pastError?: string | null;
}

interface InstallProgress {
  installId: string;
  channel: string;
  versionHash: string;
  stage: string;
  package: string | null;
  current: number;
  total: number;
  message: string | null;
}

type TabId = "installed" | "browse" | "manual";

interface VersionsDialogProps {
  open: boolean;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function shortHash(hash: string): string {
  return hash.startsWith("version-") ? hash.slice(8, 16) : hash.slice(0, 8);
}

export function VersionsDialog({ open, onClose }: VersionsDialogProps) {
  const t = useTr();
  const store = useStore();
  const { visible, closing, handleClose } = useModalClose(open, onClose);
  const [tab, setTab] = useState<TabId>("installed");
  const [installed, setInstalled] = useState<VersionEntry[]>([]);
  const [remote, setRemote] = useState<RemoteCatalog | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [progressById, setProgressById] = useState<Record<string, InstallProgress>>({});
  const [activeInstalls, setActiveInstalls] = useState<Set<string>>(new Set());
  const [manualChannel, setManualChannel] = useState("LIVE");
  const [manualHash, setManualHash] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [defaultVersion, setDefaultVersion] = useState<string>("");
  const [renaming, setRenaming] = useState<{ versionId: string; value: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    autoFetchedRemoteRef.current = false;
    setActiveInstalls(new Set());
    setProgressById({});
    void refreshInstalled();
    void invoke<Record<string, Record<string, string>>>("get_all_settings").then((s) => {
      setDefaultVersion(s?.Versions?.DefaultVersion ?? "");
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const unlisten = listen<InstallProgress>("version-install-progress", (e) => {
      const p = e.payload;
      setProgressById((prev) => ({ ...prev, [p.installId]: p }));
      if (p.stage === "ready") {
        setActiveInstalls((prev) => {
          const next = new Set(prev);
          next.delete(p.installId);
          return next;
        });
        void refreshInstalled();
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [open]);

  async function refreshInstalled() {
    try {
      const list = await invoke<VersionEntry[]>("versions_list_installed");
      setInstalled(list);
    } catch {
    }
  }

  const autoFetchedRemoteRef = useRef(false);

  async function refreshRemote(isManual = false) {
    if (isManual) {
      autoFetchedRemoteRef.current = false;
    }
    setRemoteLoading(true);
    try {
      const catalog = await invoke<RemoteCatalog>("versions_list_remote");
      setRemote(catalog);
      autoFetchedRemoteRef.current = true;
    } catch (e) {
      store.addToast(String(e));
      autoFetchedRemoteRef.current = true;
    } finally {
      setRemoteLoading(false);
    }
  }

  useEffect(() => {
    if (tab !== "browse") return;
    if (autoFetchedRemoteRef.current) return;
    if (remoteLoading) return;
    void refreshRemote();
  }, [tab, remoteLoading]);

  async function startInstall(channel: string, versionHash: string, label?: string) {
    const trimmedHash = versionHash.trim();
    if (!trimmedHash.toLowerCase().startsWith("version-")) {
      store.addToast(t("Version hash must look like version-<16 hex chars>"));
      return;
    }
    const installId = `install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setActiveInstalls((prev) => {
      const next = new Set(prev);
      next.add(installId);
      return next;
    });
    setProgressById((prev) => ({
      ...prev,
      [installId]: {
        installId,
        channel,
        versionHash: trimmedHash,
        stage: "queued",
        package: null,
        current: 0,
        total: 0,
        message: null,
      },
    }));
    try {
      await invoke("versions_install", {
        installId,
        channel,
        versionHash: trimmedHash,
        label: label ?? null,
      });
    } catch (e) {
      store.addToast(t("Install failed: {{error}}", { error: String(e) }));
      setActiveInstalls((prev) => {
        const next = new Set(prev);
        next.delete(installId);
        return next;
      });
    }
  }

  async function handleUninstall(entry: VersionEntry) {
    if (!window.confirm(t("Delete {{label}}?", { label: entry.userLabel ?? entry.versionHash }))) {
      return;
    }
    try {
      await invoke("versions_uninstall", {
        channel: entry.channel,
        versionHash: entry.versionHash,
      });
      await refreshInstalled();
    } catch (e) {
      store.addToast(String(e));
    }
  }

  async function handleSetDefault(entry: VersionEntry | null) {
    const id = entry ? `${entry.channel}:${entry.versionHash}` : null;
    try {
      await invoke("versions_set_default", { versionId: id });
      setDefaultVersion(id ?? "");
    } catch (e) {
      store.addToast(String(e));
    }
  }

  async function handleOpenFolder(entry: VersionEntry) {
    try {
      await invoke("versions_open_folder", {
        channel: entry.channel,
        versionHash: entry.versionHash,
      });
    } catch (e) {
      store.addToast(String(e));
    }
  }

  async function handleSaveLabel(entry: VersionEntry, label: string) {
    try {
      await invoke("versions_set_label", {
        channel: entry.channel,
        versionHash: entry.versionHash,
        label: label.trim() || null,
      });
      await refreshInstalled();
      setRenaming(null);
    } catch (e) {
      store.addToast(String(e));
    }
  }

  function renderProgressLine(installId: string) {
    const p = progressById[installId];
    if (!p) return null;
    const pct =
      p.total > 0 &&
      (p.stage === "downloading" ||
        p.stage === "extracting" ||
        p.stage === "installing")
        ? Math.round((p.current / p.total) * 100)
        : 0;
    return (
      <div className="rounded-md bg-zinc-950/50 px-2.5 py-2 text-[11px] text-zinc-300">
        <div className="flex items-center justify-between">
          <span>
            {t("Installing")} <span className="font-mono text-zinc-400">{shortHash(p.versionHash)}</span>
          </span>
          <span className="text-zinc-500">{p.stage}</span>
        </div>
        {p.total > 0 && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-zinc-800">
            <div
              className="h-full bg-sky-500/70 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        {p.package && (
          <div className="mt-1 truncate text-[10px] text-zinc-500">{p.package}</div>
        )}
      </div>
    );
  }

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm ${
        closing ? "animate-fade-out" : "animate-fade-in"
      }`}
      onClick={handleClose}
    >
      <div
        className={`theme-modal-scope theme-panel theme-border bg-zinc-900 border border-zinc-800/80 rounded-2xl shadow-2xl w-[720px] h-[85vh] max-h-[820px] flex flex-col overflow-hidden ${
          closing ? "animate-scale-out" : "animate-scale-in"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
          <h2 className="text-[15px] font-semibold text-zinc-100 tracking-tight">
            {t("Roblox Versions")}
          </h2>
          <button
            onClick={handleClose}
            className="p-1 rounded-md text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="flex gap-1 px-5 pb-0 shrink-0">
          {(["installed", "browse", "manual"] as TabId[]).map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors ${
                tab === id
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t(id === "installed" ? "Installed" : id === "browse" ? "Browse" : "Manual install")}
            </button>
          ))}
        </div>

        <div className="h-px bg-zinc-800/60 mx-5 mt-2.5" />

        <div className="flex-1 overflow-y-auto px-5 py-3 min-h-0 space-y-3">
          {tab === "installed" && (
            <div className="space-y-2">
              {Array.from(activeInstalls).map((id) => (
                <div key={id}>{renderProgressLine(id)}</div>
              ))}
              {installed.length === 0 && activeInstalls.size === 0 && (
                <div className="text-[12px] text-zinc-500 py-8 text-center">
                  {t("No versions installed yet. Switch to Browse or Manual install to add one.")}
                </div>
              )}
              {installed.map((entry) => {
                const versionId = `${entry.channel}:${entry.versionHash}`;
                const isDefault = defaultVersion === versionId;
                const isRenaming = renaming?.versionId === versionId;
                return (
                  <div
                    key={versionId}
                    className="rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-2.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {isRenaming ? (
                          <div className="flex items-center gap-2">
                            <input
                              autoFocus
                              value={renaming.value}
                              onChange={(e) =>
                                setRenaming({ versionId, value: e.target.value })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void handleSaveLabel(entry, renaming.value);
                                if (e.key === "Escape") setRenaming(null);
                              }}
                              className="px-2 py-1 rounded text-[12px] bg-zinc-800 border border-zinc-700/60 text-zinc-200 focus:outline-none focus:border-sky-500/40"
                              placeholder={t("Nickname")}
                            />
                            <button
                              onClick={() => void handleSaveLabel(entry, renaming.value)}
                              className="text-[11px] text-sky-400 hover:text-sky-300"
                            >
                              {t("Save")}
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] text-zinc-200 truncate">
                              {entry.userLabel ?? entry.displayVersion ?? shortHash(entry.versionHash)}
                            </span>
                            {isDefault && (
                              <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-[10px] text-sky-400">
                                {t("Default")}
                              </span>
                            )}
                            {!entry.exists && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-[10px] text-amber-400">
                                {t("Missing files")}
                              </span>
                            )}
                          </div>
                        )}
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500 font-mono truncate">
                          <span>{entry.channel}</span>
                          <span>•</span>
                          <span className="truncate">{entry.versionHash}</span>
                          <span>•</span>
                          <span>{formatSize(entry.installSizeBytes)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleSetDefault(isDefault ? null : entry)}
                          className="p-1.5 rounded text-zinc-400 hover:text-sky-400 hover:bg-zinc-800 transition-colors"
                          title={isDefault ? t("Unset as default") : t("Set as default")}
                        >
                          {isDefault ? (
                            <Star size={14} strokeWidth={1.5} fill="currentColor" />
                          ) : (
                            <StarOff size={14} strokeWidth={1.5} />
                          )}
                        </button>
                        <button
                          onClick={() =>
                            setRenaming({
                              versionId,
                              value: entry.userLabel ?? "",
                            })
                          }
                          className="p-1.5 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                          title={t("Rename")}
                        >
                          <Pencil size={14} strokeWidth={1.5} />
                        </button>
                        <button
                          onClick={() => void handleOpenFolder(entry)}
                          className="p-1.5 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                          title={t("Open folder")}
                        >
                          <FolderOpen size={14} strokeWidth={1.5} />
                        </button>
                        <button
                          onClick={() => void handleUninstall(entry)}
                          className="p-1.5 rounded text-rose-400 hover:bg-rose-900/40 transition-colors"
                          title={t("Uninstall")}
                        >
                          <Trash2 size={14} strokeWidth={1.5} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {tab === "browse" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] text-zinc-500">
                  {t("Versions exposed by weao.xyz/api/versions")}
                </div>
                <button
                  onClick={() => refreshRemote(true)}
                  disabled={remoteLoading}
                  className="flex items-center gap-1.5 text-[11px] text-sky-400 hover:text-sky-300 disabled:opacity-60"
                >
                  <RefreshCw size={11} strokeWidth={2} />
                  {remoteLoading ? t("Loading...") : t("Refresh")}
                </button>
              </div>
              {remoteLoading && !remote && (
                <div className="text-[12px] text-zinc-500 py-6 text-center">
                  {t("Loading remote catalog...")}
                </div>
              )}
              {remote && (
                <>
                  <div className="text-[10px] uppercase tracking-widest text-zinc-600 font-medium pt-2">
                    {t("Current")}
                  </div>
                  {remote.current
                    .filter((v) => v.binaryType.startsWith("Windows"))
                    .map((entry) => (
                      <RemoteRow
                        key={`current-${entry.binaryType}-${entry.versionHash}`}
                        entry={entry}
                        installed={installed.some(
                          (i) => i.channel === entry.channel && i.versionHash === entry.versionHash
                        )}
                        onInstall={() => startInstall(entry.channel, entry.versionHash)}
                      />
                    ))}
                  <div className="text-[10px] uppercase tracking-widest text-zinc-600 font-medium pt-2">
                    {t("Previous")}
                  </div>
                  {remote.pastError && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
                      {t("Could not load previous versions: {{error}}", { error: remote.pastError })}
                    </div>
                  )}
                  {remote.past
                    .filter((v) => v.binaryType.startsWith("Windows"))
                    .map((entry) => (
                      <RemoteRow
                        key={`past-${entry.binaryType}-${entry.versionHash}`}
                        entry={entry}
                        installed={installed.some(
                          (i) => i.channel === entry.channel && i.versionHash === entry.versionHash
                        )}
                        onInstall={() => startInstall(entry.channel, entry.versionHash)}
                      />
                    ))}
                </>
              )}
              {Array.from(activeInstalls).map((id) => (
                <div key={id}>{renderProgressLine(id)}</div>
              ))}
            </div>
          )}

          {tab === "manual" && (
            <div className="space-y-3">
              <div className="text-[11px] text-zinc-500">
                {t(
                  "Paste an arbitrary Roblox version hash to install older builds that don't appear in the catalog."
                )}
              </div>
              <div className="space-y-2">
                <label className="block">
                  <span className="text-[11px] text-zinc-500">{t("Channel")}</span>
                  <input
                    value={manualChannel}
                    onChange={(e) => setManualChannel(e.target.value)}
                    placeholder="LIVE"
                    className="mt-1 w-full px-2.5 py-1 rounded-md text-[13px] font-mono bg-zinc-800/60 border border-zinc-700/60 text-zinc-200 focus:outline-none focus:border-sky-500/40"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-zinc-500">{t("Version hash")}</span>
                  <input
                    value={manualHash}
                    onChange={(e) => setManualHash(e.target.value)}
                    placeholder="version-abcdef0123456789"
                    className="mt-1 w-full px-2.5 py-1 rounded-md text-[13px] font-mono bg-zinc-800/60 border border-zinc-700/60 text-zinc-200 focus:outline-none focus:border-sky-500/40"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-zinc-500">{t("Nickname (optional)")}</span>
                  <input
                    value={manualLabel}
                    onChange={(e) => setManualLabel(e.target.value)}
                    placeholder={t("Pre-Hyperion")}
                    className="mt-1 w-full px-2.5 py-1 rounded-md text-[13px] bg-zinc-800/60 border border-zinc-700/60 text-zinc-200 focus:outline-none focus:border-sky-500/40"
                  />
                </label>
                <button
                  onClick={() => {
                    if (!manualHash.trim()) return;
                    void startInstall(
                      manualChannel.trim() || "LIVE",
                      manualHash.trim(),
                      manualLabel.trim() || undefined
                    );
                    setManualHash("");
                    setManualLabel("");
                  }}
                  className="flex items-center gap-1.5 rounded-lg border border-sky-700/50 bg-sky-900/30 px-3 py-1.5 text-[12px] font-medium text-sky-200 transition-colors hover:bg-sky-900/50"
                >
                  <Download size={13} strokeWidth={2} />
                  {t("Install")}
                </button>
              </div>
              {Array.from(activeInstalls).map((id) => (
                <div key={id}>{renderProgressLine(id)}</div>
              ))}
            </div>
          )}
        </div>

        <div className="h-px bg-zinc-800/60 mx-5" />
        <div className="px-5 py-3 shrink-0">
          <div className="rounded-md border border-zinc-800/70 bg-zinc-900/35 px-3 py-2 text-[10px] text-zinc-500">
            {t("Downloader logic adapted from")}{" "}
            <a
              href="https://github.com/latte-soft/rdd"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              latte-soft/rdd
            </a>
            {" "}
            ({t("MIT")}). {t("Version catalog via")}{" "}
            <a
              href="https://weao.xyz"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:text-sky-300"
            >
              weao.xyz
            </a>
            .
          </div>
        </div>
      </div>
    </div>
  );
}

function RemoteRow({
  entry,
  installed,
  onInstall,
}: {
  entry: RemoteVersionEntry;
  installed: boolean;
  onInstall: () => void;
}) {
  const t = useTr();
  return (
    <div className="flex items-center justify-between rounded-lg border border-zinc-800/70 bg-zinc-900/35 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-zinc-200">
            {entry.displayVersion ?? "—"}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            {entry.binaryType}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] font-mono text-zinc-500 truncate">
          {entry.versionHash}
          {entry.deployDate ? ` · ${entry.deployDate}` : ""}
        </div>
      </div>
      <button
        onClick={onInstall}
        disabled={installed}
        className="rounded-lg border border-zinc-700/70 bg-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-50"
      >
        {installed ? t("Installed") : t("Install")}
      </button>
    </div>
  );
}
