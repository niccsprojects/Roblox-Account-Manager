import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../store";
import { usePrompt } from "../../hooks/usePrompt";
import { Tooltip } from "../ui/Tooltip";
import { tr, useTr } from "../../i18n/text";
import { ENABLE_NEXUS } from "../../featureFlags";
import { Search, X, SquareX, SquareCheckBig, PanelRight, Plus, ChevronDown, Globe, KeyRound, File, FileText, Palette, Layers, Settings, TerminalSquare, Sparkles, Package, ArrowUpDown } from "lucide-react";

export function Toolbar() {
  const t = useTr();
  const store = useStore();
  const prompt = usePrompt();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const activeToggleStyle = "theme-accent theme-accent-bg theme-accent-border";

  useEffect(() => {
    if (!addMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (addRef.current && !addRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [addMenuOpen]);

  function handleBrowserLogin() {
    setAddMenuOpen(false);
    store.openLoginBrowser();
  }

  function handleUserPassLogin() {
    setAddMenuOpen(false);
    store.setImportDialogTab("userpass");
    store.setImportDialogOpen(true);
  }

  function handleImportCookie() {
    setAddMenuOpen(false);
    store.setImportDialogTab("cookie");
    store.setImportDialogOpen(true);
  }

  function handleImportOldAccountData() {
    setAddMenuOpen(false);
    store.setImportDialogTab("legacy");
    store.setImportDialogOpen(true);
  }

  function handleOpenGenerator() {
    setAddMenuOpen(false);
    store.setGeneratorDialogOpen(true);
  }

  function handleOpenVersions() {
    setAddMenuOpen(false);
    store.setVersionsDialogOpen(true);
  }

  async function handleQuickAdd() {
    setAddMenuOpen(false);
    const input = await prompt(tr("Cookie or username"));
    if (!input?.trim()) return;
    const value = input.trim();

    try {
      if (value.includes("_|WARNING:-DO-NOT-SHARE")) {
        await store.addAccountByCookie(value);
        return;
      }

      const user = await invoke<{ id: number; name: string }>("lookup_user", { username: value });
      await invoke("add_account", {
        securityToken: "",
        username: user.name,
        userId: user.id,
      });
      await store.loadAccounts();
      store.addToast(tr("Added {{name}}", { name: user.name }));
    } catch (e) {
      store.addToast(tr("Add failed: {{error}}", { error: String(e) }));
    }
  }

  return (
    <div className="theme-panel theme-border flex items-center gap-3 px-4 py-2 border-b shrink-0">
      <div className="relative flex-1 max-w-xs">
        <Search size={15} strokeWidth={2} className="absolute left-3 top-1/2 -translate-y-1/2 theme-muted" />
        <input
          type="text"
          value={store.searchQuery}
          onChange={(e) => store.setSearchQuery(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          placeholder={t("Filter accounts...")}
          autoComplete="off"
          spellCheck={false}
          className="theme-input w-full pl-9 pr-3 py-1.5 rounded-lg text-sm transition-colors"
        />
        {store.searchQuery && (
          <Tooltip content={t("Clear search")} side="bottom">
            <button
              onClick={() => store.setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 theme-muted hover:opacity-100"
            >
              <X size={14} strokeWidth={2} />
            </button>
          </Tooltip>
        )}
      </div>

      <div className="flex items-center gap-1.5 ml-auto">
        <Tooltip content={store.selectedIds.size > 0 ? t("Deselect all ({{count}})", { count: store.selectedIds.size }) : t("Select all")} side="bottom">
          <button
            onClick={() => store.toggleSelectAll()}
            className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              store.selectedIds.size > 0
                ? activeToggleStyle
                : "theme-btn-ghost"
            }`}
          >
            {store.selectedIds.size > 0 ? (
              <SquareX size={14} strokeWidth={2} />
            ) : (
              <SquareCheckBig size={14} strokeWidth={2} />
            )}
          </button>
        </Tooltip>

        <button
          onClick={() => store.setHideUsernames(!store.hideUsernames)}
          className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
            store.hideUsernames
              ? activeToggleStyle
              : "theme-btn-ghost"
          }`}
        >
          {store.hideUsernames ? t("Hidden") : t("Names")}
        </button>

        {store.settings?.General?.ReorderStyle === "mode" && (
          <Tooltip content={store.reorderMode ? t("Done reordering") : t("Reorder accounts")} side="bottom">
            <button
              onClick={() => store.setReorderMode(!store.reorderMode)}
              aria-pressed={store.reorderMode}
              className={`p-1.5 rounded-lg border transition-colors ${
                store.reorderMode ? activeToggleStyle : "theme-btn-ghost"
              }`}
            >
              <ArrowUpDown size={16} strokeWidth={1.5} />
            </button>
          </Tooltip>
        )}

        <Tooltip content={store.sidebarOpen ? t("Hide panel") : t("Show panel")} side="bottom">
          <button
            onClick={() => store.setSidebarOpen(!store.sidebarOpen)}
            className={`p-1.5 rounded-lg border transition-colors ${
              store.sidebarOpen
                ? activeToggleStyle
                : "theme-btn-ghost"
            }`}
          >
            <PanelRight size={16} strokeWidth={1.5} />
          </button>
        </Tooltip>

        <div className="w-px h-5 mx-1 bg-[var(--border-color)]" />

        <div ref={addRef} className="relative">
          <button
            onClick={() => setAddMenuOpen(!addMenuOpen)}
            data-tour="toolbar-add"
            className="theme-btn flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors"
          >
            <Plus size={14} strokeWidth={2.5} />
            {t("Add")}
            <ChevronDown size={10} strokeWidth={2.5} />
          </button>
          {addMenuOpen && (
            <div className="theme-panel theme-border absolute right-0 top-full mt-1.5 w-52 border rounded-xl shadow-2xl z-50 animate-scale-in py-1">
              <button
                onClick={handleQuickAdd}
                className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-[var(--panel-fg)] hover:bg-[var(--panel-soft)] text-left"
              >
                <Plus size={14} strokeWidth={1.5} className="theme-muted" />
                {t("Quick Add")}
              </button>
              <button
                onClick={handleBrowserLogin}
                data-tour="add-browser-login"
                className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-[var(--panel-fg)] hover:bg-[var(--panel-soft)] text-left"
              >
                <Globe size={14} strokeWidth={1.5} className="theme-muted" />
                {t("Browser Login")}
              </button>
              <button
                onClick={handleUserPassLogin}
                className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-[var(--panel-fg)] hover:bg-[var(--panel-soft)] text-left"
              >
                <KeyRound size={14} strokeWidth={1.5} className="theme-muted" />
                {t("User:Pass Login")}
              </button>
              <div className="my-1 border-t theme-border" />
              <button
                onClick={handleImportCookie}
                className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-[var(--panel-fg)] hover:bg-[var(--panel-soft)] text-left"
              >
                <File size={14} strokeWidth={1.5} className="theme-muted" />
                {t("Import Cookie")}
              </button>
              <button
                onClick={handleImportOldAccountData}
                className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-[var(--panel-fg)] hover:bg-[var(--panel-soft)] text-left"
              >
                <FileText size={14} strokeWidth={1.5} className="theme-muted" />
                {t("Import Old Account Data")}
              </button>
              <div className="my-1 border-t theme-border" />
              <button
                onClick={handleOpenGenerator}
                className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-[var(--panel-fg)] hover:bg-[var(--panel-soft)] text-left"
              >
                <Sparkles size={14} strokeWidth={1.5} className="theme-muted" />
                {t("Account Generator")}
              </button>
              <button
                onClick={handleOpenVersions}
                className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-[var(--panel-fg)] hover:bg-[var(--panel-soft)] text-left"
              >
                <Package size={14} strokeWidth={1.5} className="theme-muted" />
                {t("Roblox Versions")}
              </button>
            </div>
          )}
        </div>

        <Tooltip content={t("Theme")} side="bottom">
          <button
            onClick={() => store.setThemeEditorOpen(true)}
            className="theme-btn-ghost p-1.5 rounded-lg transition-colors"
          >
            <Palette size={16} strokeWidth={1.5} />
          </button>
        </Tooltip>

        {ENABLE_NEXUS && (
          <Tooltip content="Nexus" side="bottom">
            <button
              onClick={() => store.setNexusOpen(true)}
              className="theme-btn-ghost p-1.5 rounded-lg transition-colors"
            >
              <Layers size={16} strokeWidth={1.5} />
            </button>
          </Tooltip>
        )}

        <Tooltip content={t("Scripts")} side="bottom">
          <button
            onClick={() => store.setScriptsOpen(true)}
            className="theme-btn-ghost p-1.5 rounded-lg transition-colors"
          >
            <TerminalSquare size={16} strokeWidth={1.5} />
          </button>
        </Tooltip>

        <Tooltip content={t("Settings")} side="bottom">
          <button
            onClick={() => store.setSettingsOpen(true)}
            data-tour="toolbar-settings"
            className="theme-btn-ghost p-1.5 rounded-lg transition-colors"
          >
            <Settings size={16} strokeWidth={1.5} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
