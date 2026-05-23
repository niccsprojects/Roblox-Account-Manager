import { useRef, useState, useLayoutEffect } from "react";
import type { TabId, TabDef } from "./SettingsDialog";
import { useTr } from "../../i18n/text";

export function TabBar({
  tabs,
  activeTab,
  onTabChange,
}: {
  tabs: TabDef[];
  activeTab: TabId;
  onTabChange: (id: TabId) => void;
}) {
  const t = useTr();
  const tabRefs = useRef<Map<TabId, HTMLButtonElement>>(new Map());
  const [pillStyle, setPillStyle] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const hasInitialized = useRef(false);

  useLayoutEffect(() => {
    const el = tabRefs.current.get(activeTab);
    if (!el) return;
    setPillStyle({
      left: el.offsetLeft,
      top: el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
    });
    hasInitialized.current = true;
  }, [activeTab, tabs.length]);

  return (
    <div className="relative flex flex-wrap gap-1 px-5 pb-0 shrink-0">
      <div
        className="absolute rounded-lg bg-zinc-800 shadow-sm"
        style={{
          left: pillStyle.left,
          top: pillStyle.top,
          width: pillStyle.width,
          height: pillStyle.height,
          transition: hasInitialized.current
            ? "left 180ms cubic-bezier(0.22, 1, 0.36, 1), top 180ms cubic-bezier(0.22, 1, 0.36, 1), width 150ms cubic-bezier(0.22, 1, 0.36, 1), height 150ms cubic-bezier(0.22, 1, 0.36, 1)"
            : "none",
        }}
      />
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(el) => {
            if (el) tabRefs.current.set(tab.id, el);
          }}
          onClick={() => onTabChange(tab.id)}
          className={`relative z-[1] flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors duration-200 ${
            activeTab === tab.id
              ? "text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <span
            className="transition-colors duration-200"
            style={{ color: activeTab === tab.id ? "rgb(56, 189, 248)" : undefined }}
          >
            {tab.icon}
          </span>
          {t(tab.label)}
        </button>
      ))}
    </div>
  );
}
