import { useEffect, useRef } from "react";
import { StoreProvider, useStore } from "./store";
import { PromptProvider } from "./hooks/usePrompt";
import { PasswordScreen } from "./components/layout/PasswordScreen";
import { EncryptionSetupScreen } from "./components/layout/EncryptionSetupScreen";
import { FirstRunWalkthrough } from "./components/layout/FirstRunWalkthrough";
import { AppErrorBoundary } from "./components/layout/AppErrorBoundary";
import { TitleBar } from "./components/layout/TitleBar";
import { ModalWindowControls } from "./components/layout/ModalWindowControls";
import { UpdateBanner } from "./components/layout/UpdateBanner";
import { Toolbar } from "./components/layout/Toolbar";
import { AccountList } from "./components/accounts/AccountList";
import { ContextMenu } from "./components/menus/ContextMenu";
import { DetailSidebar } from "./components/accounts/DetailSidebar";
import { StatusBar } from "./components/layout/StatusBar";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ServerListDialog } from "./components/server-list/ServerListDialog";
import { ImportDialog } from "./components/dialogs/ImportDialog";
import { AccountFieldsDialog } from "./components/dialogs/AccountFieldsDialog";
import { AccountUtilsDialog } from "./components/dialogs/AccountUtilsDialog";
import { MissingAssetsDialog } from "./components/dialogs/MissingAssetsDialog";
import { ThemeEditorDialog } from "./components/dialogs/ThemeEditorDialog";
import { UpdateDialog } from "./components/dialogs/UpdateDialog";
import { NexusDialog } from "./components/dialogs/NexusDialog";
import { BottingDialog } from "./components/dialogs/BottingDialog";
import { GeneratorDialog } from "./components/dialogs/GeneratorDialog";
import { VersionsDialog } from "./components/dialogs/VersionsDialog";
import { IsolationProgressOverlay } from "./components/IsolationProgressOverlay";
import { ScriptsDialog } from "./components/dialogs/ScriptsDialog";
import { useTr } from "./i18n/text";
import { ENABLE_NEXUS } from "./featureFlags";

function AppContent() {
  const t = useTr();
  const store = useStore();
  const hasCheckedForUpdatesRef = useRef(false);
  const errorLower = (store.error || "").toLowerCase();
  const showCloseRobloxAction =
    errorLower.includes("failed to enable multi roblox") ||
    (errorLower.includes("multi roblox") && errorLower.includes("close all roblox process"));
  const anyModalOpen =
    store.settingsOpen ||
    store.serverListOpen ||
    store.importDialogOpen ||
    store.accountFieldsOpen ||
    store.accountUtilsOpen ||
    !!store.missingAssets ||
    store.themeEditorOpen ||
    store.bottingDialogOpen ||
    store.generatorDialogOpen ||
    (ENABLE_NEXUS && store.nexusOpen) ||
    store.scriptsOpen ||
    store.updateDialogOpen ||
    store.firstRunWalkthroughOpen ||
    !!store.modal;

  useEffect(() => {
    if (!store.initialized || store.needsPassword || store.firstRunWalkthroughOpen) return;
    if (hasCheckedForUpdatesRef.current) return;
    hasCheckedForUpdatesRef.current = true;
    store.checkForUpdates();
  }, [store.checkForUpdates, store.firstRunWalkthroughOpen, store.initialized, store.needsPassword]);

  if (!store.initialized) {
    return (
      <div className="theme-app flex h-screen items-center justify-center">
        <div className="text-sm theme-muted">{t("Loading...")}</div>
      </div>
    );
  }

  if (store.needsPassword) {
    return <PasswordScreen />;
  }

  if (store.encryptionSetupOpen) {
    return <EncryptionSetupScreen />;
  }

  return (
    <div className="theme-app flex h-screen flex-col">
      <ModalWindowControls visible={anyModalOpen} />
      <TitleBar controlsHidden={anyModalOpen} />
      <UpdateBanner />
      <Toolbar />

      {store.error && (
        <div className="mx-4 mt-2 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-2 text-sm text-red-400 flex items-center justify-between animate-fade-in">
          <span className="truncate">{store.error}</span>
          <div className="ml-2 flex items-center gap-2 shrink-0">
            {showCloseRobloxAction && (
              <button
                onClick={() => store.killAllRobloxProcesses()}
                className="px-2 py-1 rounded-md bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 transition-colors animate-pulse"
              >
                {t("Close Roblox")}
              </button>
            )}
            <button
              onClick={() => store.setError(null)}
              className="text-red-500/60 hover:text-red-400 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <AccountList />
        {store.sidebarOpen && <DetailSidebar />}
      </div>

      <StatusBar />

      <ContextMenu />

      {store.toasts.length > 0 && (
        <div className="fixed bottom-10 right-4 z-[60] flex flex-col gap-1.5">
          {store.toasts.map((msg, i) => (
            <div
              key={i}
              className="theme-panel theme-border backdrop-blur-lg px-4 py-2 rounded-lg text-xs shadow-xl animate-toast"
            >
              {msg}
            </div>
          ))}
        </div>
      )}

      <SettingsDialog
        open={store.settingsOpen}
        onClose={() => store.setSettingsOpen(false)}
        onSettingsChanged={store.reloadSettings}
        onRequestEncryptionSetup={() => {
          store.setSettingsOpen(false);
          store.openEncryptionSetupFromSettings();
        }}
      />

      <ServerListDialog
        open={store.serverListOpen}
        onClose={() => store.setServerListOpen(false)}
      />

      <ImportDialog
        open={store.importDialogOpen}
        onClose={() => store.setImportDialogOpen(false)}
        defaultTab={store.importDialogTab}
      />

      <AccountFieldsDialog
        open={store.accountFieldsOpen}
        onClose={() => store.setAccountFieldsOpen(false)}
      />

      <AccountUtilsDialog
        open={store.accountUtilsOpen}
        onClose={() => store.setAccountUtilsOpen(false)}
      />

      <MissingAssetsDialog />

      <ThemeEditorDialog
        open={store.themeEditorOpen}
        onClose={() => store.setThemeEditorOpen(false)}
      />

      <BottingDialog
        open={store.bottingDialogOpen}
        onClose={() => store.setBottingDialogOpen(false)}
      />

      <GeneratorDialog
        open={store.generatorDialogOpen}
        onClose={() => store.setGeneratorDialogOpen(false)}
      />

      <VersionsDialog
        open={store.versionsDialogOpen}
        onClose={() => store.setVersionsDialogOpen(false)}
      />

      <IsolationProgressOverlay />

      {ENABLE_NEXUS && (
        <NexusDialog
          open={store.nexusOpen}
          onClose={() => store.setNexusOpen(false)}
        />
      )}

      <ScriptsDialog
        open={store.scriptsOpen}
        onClose={() => store.setScriptsOpen(false)}
      />

      <UpdateDialog />

      {store.firstRunWalkthroughOpen && <FirstRunWalkthrough />}

      {store.modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={store.closeModal}
        >
          <div
            className="theme-panel theme-border rounded-xl p-5 max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col shadow-2xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--panel-fg)]">{store.modal.title}</h3>
              <button
                onClick={store.closeModal}
                className="theme-muted hover:opacity-100 transition-opacity"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <pre className="theme-input text-xs font-mono rounded-lg p-4 overflow-auto flex-1">
              {store.modal.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <AppErrorBoundary>
      <StoreProvider>
        <PromptProvider>
          <AppContent />
        </PromptProvider>
      </StoreProvider>
    </AppErrorBoundary>
  );
}

export default App;
