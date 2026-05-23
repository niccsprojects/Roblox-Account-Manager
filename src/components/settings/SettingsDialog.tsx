import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useSettings } from "../../hooks/useSettings";
import { useModalClose } from "../../hooks/useModalClose";
import { TabBar } from "./TabBar";
import { TabContent } from "./TabContent";
import { useTr } from "../../i18n/text";
import { ENABLE_WEBSERVER } from "../../featureFlags";
import { Settings as SettingsIcon, Code, Gauge, Server, Eye, Sparkles, ShieldCheck, Package, MoreHorizontal, X } from "lucide-react";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSettingsChanged?: () => void;
  onRequestEncryptionSetup?: () => void;
}

export type TabId =
  | "general"
  | "developer"
  | "webserver"
  | "watcher"
  | "generator"
  | "isolation"
  | "versions"
  | "optimization"
  | "miscellaneous";

export const TAB_ORDER: TabId[] = ENABLE_WEBSERVER
  ? ["general", "developer", "webserver", "watcher", "generator", "isolation", "versions", "optimization", "miscellaneous"]
  : ["general", "developer", "watcher", "generator", "isolation", "versions", "optimization", "miscellaneous"];

export interface TabDef {
  id: TabId;
  label: string;
  icon: ReactNode;
  hidden?: boolean;
}

export function SettingsDialog({
  open,
  onClose,
  onSettingsChanged,
  onRequestEncryptionSetup,
}: SettingsDialogProps) {
  const t = useTr();
  const closeAndNotify = useCallback(() => {
    onClose();
    onSettingsChanged?.();
  }, [onClose, onSettingsChanged]);
  const { visible, closing, handleClose } = useModalClose(open, closeAndNotify);
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const s = useSettings();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      s.load();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleClose]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [activeTab]);

  const devMode = s.getBool("Developer", "DevMode");
  const wsEnabled = s.getBool("Developer", "EnableWebServer");

  const tabs: TabDef[] = [
    {
      id: "general",
      label: "General",
      icon: <SettingsIcon size={15} strokeWidth={1.5} />,
    },
    {
      id: "developer",
      label: "Developer",
      icon: <Code size={15} strokeWidth={1.5} />,
    },
    {
      id: "webserver",
      label: "WebServer",
      icon: <Server size={15} strokeWidth={1.5} />,
      hidden: !ENABLE_WEBSERVER || (!devMode && !wsEnabled),
    },
    {
      id: "watcher",
      label: "Watcher",
      icon: <Eye size={15} strokeWidth={1.5} />,
    },
    {
      id: "generator",
      label: "Generator",
      icon: <Sparkles size={15} strokeWidth={1.5} />,
    },
    {
      id: "isolation",
      label: "Isolation",
      icon: <ShieldCheck size={15} strokeWidth={1.5} />,
    },
    {
      id: "versions",
      label: "Versions",
      icon: <Package size={15} strokeWidth={1.5} />,
    },
    {
      id: "optimization",
      label: "Optimization",
      icon: <Gauge size={15} strokeWidth={1.5} />,
    },
    {
      id: "miscellaneous",
      label: "Misc",
      icon: <MoreHorizontal size={15} strokeWidth={1.5} />,
    },
  ];

  const visibleTabs = tabs.filter((t) => !t.hidden);

  useEffect(() => {
    if (!open || visibleTabs.length === 0) return;
    if (!visibleTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab(visibleTabs[0].id);
    }
  }, [open, activeTab, visibleTabs]);

  if (!visible) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      onClick={handleClose}
    >
      <div
        data-tour="settings-modal"
        className={`theme-modal-scope theme-panel theme-border bg-zinc-900 border border-zinc-800/80 rounded-2xl shadow-2xl w-[520px] h-[85vh] max-h-[760px] flex flex-col overflow-hidden ${closing ? "animate-scale-out" : "animate-scale-in"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 shrink-0">
          <h2 className="text-[15px] font-semibold text-zinc-100 tracking-tight">{t("Settings")}</h2>
          <div className="flex items-center gap-2">
            {s.saving && (
              <span className="text-[10px] text-zinc-600 animate-pulse">{t("saving...")}</span>
            )}
            <button
              onClick={handleClose}
              className="p-1 rounded-md text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors"
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

        <TabBar tabs={visibleTabs} activeTab={activeTab} onTabChange={setActiveTab} />

        <div className="h-px bg-zinc-800/60 mx-5 mt-2.5" />

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-3 min-h-0">
          <TabContent
            activeTab={activeTab}
            s={s}
            loaded={s.loaded}
            onRequestEncryptionSetup={onRequestEncryptionSetup}
          />
        </div>

        <div className="h-px bg-zinc-800/60 mx-5" />
        <div className="flex items-center justify-between px-5 py-3 shrink-0">
          <span className="text-[10px] text-zinc-600">
            {t("Changes are saved automatically")}
          </span>
          <button
            onClick={handleClose}
            className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/60 rounded-lg text-[12px] text-zinc-300 font-medium transition-colors"
          >
            {t("Done")}
          </button>
        </div>
      </div>
    </div>
  );
}
