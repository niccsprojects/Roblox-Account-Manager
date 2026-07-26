import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../store";
import { useTr } from "../../i18n/text";
import { Select } from "../ui/Select";

interface WalkthroughStep {
  id: string;
  title: string;
  summary: string;
  highlights: string[];
  targets?: string[];
  missingTargetHint?: string;
  actionLabel?: string;
  onAction?: () => void;
}

const LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "de", label: "German" },
];

export function FirstRunWalkthrough() {
  const t = useTr();
  const store = useStore();
  const panelRef = useRef<HTMLDivElement>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [languageSaving, setLanguageSaving] = useState(false);
  const [panelPosition, setPanelPosition] = useState({ left: 16, top: 16 });
  const isFirstRunMode = store.firstRunWalkthroughMode === "firstRun";
  const currentLanguage = store.settings?.General?.Language || "en";
  const isLanguageStep = stepIndex === 0;
  const languageSelected = LANGUAGE_OPTIONS.some(({ value }) => value === currentLanguage);

  const handleLanguageChange = async (value: string) => {
    setLanguageSaving(true);
    try {
      await invoke("update_setting", {
        section: "General",
        key: "Language",
        value,
      });
      await store.reloadSettings();
    } catch {
      store.addToast(t("Failed to change language"));
    } finally {
      setLanguageSaving(false);
    }
  };

  const steps = useMemo<WalkthroughStep[]>(
    () => [
      {
        id: "language",
        title: t("Select language"),
        summary: t("Choose your language first, then continue with the guided setup."),
        highlights: [
          t("Walkthrough text updates in your selected language"),
          t("You can change this later in Settings at any time"),
        ],
      },
      {
        id: "add-account",
        title: t("Add your first account"),
        summary: t("Browser Login is the easiest and safest way to start."),
        highlights: [
          t("Use Add in the top toolbar for Quick Add, Browser Login, and imports"),
          t("When the list is empty, the center Add shortcut works too"),
        ],
        targets: ["[data-tour='toolbar-add']", "[data-tour='empty-add']"],
        actionLabel: t("Open Login Browser"),
        onAction: () => {
          void store.openLoginBrowser();
        },
      },
      {
        id: "list-signals",
        title: t("Learn the account list signals"),
        summary: t("Status dots and selection shortcuts help you manage large account sets."),
        highlights: [
          t("Red means invalid session, amber means aged, sky/green/violet means presence"),
          t("Ctrl/Cmd click toggles accounts, Shift click selects a range"),
        ],
        targets: ["[data-tour='accounts-list']"],
      },
      ...(store.accounts.length > 0
        ? [
            {
              id: "launch-sidebar",
              title: t("Use the launch panel"),
              summary: t("Select one account to reveal launch controls on the right."),
              highlights: [
                t("Place ID is required, Job ID and Launch Data are optional"),
                t("Save launch fields to the account once your target is dialed in"),
              ],
              targets: ["[data-tour='launch-sidebar']"],
              missingTargetHint: t("Select one account to reveal the launch sidebar, then continue"),
              actionLabel: t("Show Launch Panel"),
              onAction: () => {
                store.setSidebarOpen(true);
              },
            },
          ]
        : []),
      {
        id: "safety",
        title: t("Power settings, used carefully"),
        summary: t("Only enable advanced features after your basic launch flow is stable."),
        highlights: [
          t("Multi Roblox and Botting are powerful but higher risk"),
          t("Keep online-join warnings enabled until you fully trust your routine"),
        ],
        targets: ["[data-tour='settings-modal']", "[data-tour='toolbar-settings']"],
        actionLabel: t("Open Settings"),
        onAction: () => {
          store.setSettingsOpen(true);
        },
      },
      {
        id: "ready",
        title: t("You're ready to roll"),
        summary: t("Run this quick checklist before scaling up."),
        highlights: [
          t("Add one valid account and confirm a single launch works"),
          t("Then move to multi-launch, grouping, and optional automation"),
        ],
        targets: ["[data-tour='status-bar']"],
      },
    ],
    [
      store.openLoginBrowser,
      store.accounts.length,
      store.setSettingsOpen,
      store.setSidebarOpen,
      t,
    ]
  );

  const activeStep = steps[Math.min(stepIndex, steps.length - 1)];

  const panelAnchor = useMemo<"bottom-right" | "bottom-left" | "top-left">(() => {
    if (activeStep?.id === "launch-sidebar") return "bottom-left";
    if (activeStep?.id === "ready") return "top-left";
    return "bottom-right";
  }, [activeStep?.id]);

  const resolveActiveTarget = useCallback(() => {
    if (!activeStep?.targets || activeStep.targets.length === 0) return null;

    if (activeStep.id === "add-account") {
      const browserLoginButton = document.querySelector<HTMLElement>("[data-tour='add-browser-login']");
      if (browserLoginButton) return browserLoginButton;

      const addButton = document.querySelector<HTMLElement>("[data-tour='toolbar-add']");
      if (addButton) return addButton;

      const emptyAddButton = document.querySelector<HTMLElement>("[data-tour='empty-add']");
      if (emptyAddButton) return emptyAddButton;

      return null;
    }

    const selectors =
      activeStep.id === "safety"
        ? store.settingsOpen
          ? ["[data-tour='settings-modal']", "[data-tour='toolbar-settings']"]
          : ["[data-tour='toolbar-settings']", "[data-tour='settings-modal']"]
          : activeStep.targets;

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element) return element;
    }

    return null;
  }, [activeStep, store.accounts.length, store.settingsOpen]);

  useEffect(() => {
    if (activeStep.id !== "launch-sidebar") return;
    store.setSidebarOpen(true);
    if (store.selectedIds.size > 0) return;
    const firstId = store.orderedUserIds[0] ?? store.accounts[0]?.UserID;
    if (typeof firstId === "number") {
      store.selectSingle(firstId);
    }
  }, [
    activeStep.id,
    stepIndex,
    store.accounts,
    store.orderedUserIds,
    store.selectSingle,
    store.selectedIds.size,
    store.setSidebarOpen,
  ]);

  useEffect(() => {
    if (activeStep.id !== "ready") return;
    store.setSettingsOpen(false);
    store.setServerListOpen(false);
    store.setImportDialogOpen(false);
    store.setAccountFieldsOpen(false);
    store.setAccountUtilsOpen(false);
    store.setThemeEditorOpen(false);
    store.setBottingDialogOpen(false);
    store.setNexusOpen(false);
    store.setScriptsOpen(false);
    store.setUpdateDialogOpen(false);
    store.setMissingAssets(null);
    store.closeModal();
  }, [
    activeStep.id,
    stepIndex,
    store.closeModal,
    store.setAccountFieldsOpen,
    store.setAccountUtilsOpen,
    store.setBottingDialogOpen,
    store.setImportDialogOpen,
    store.setMissingAssets,
    store.setNexusOpen,
    store.setScriptsOpen,
    store.setServerListOpen,
    store.setSettingsOpen,
    store.setThemeEditorOpen,
    store.setUpdateDialogOpen,
  ]);

  const [activeTarget, setActiveTarget] = useState<HTMLElement | null>(null);
  const [focusRect, setFocusRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const margin = 16;

    const updatePanelPosition = () => {
      const panel = panelRef.current;
      const panelWidth = panel?.offsetWidth ?? 460;
      const panelHeight = panel?.offsetHeight ?? 420;

      let left = window.innerWidth - panelWidth - margin;
      let top = window.innerHeight - panelHeight - margin;

      if (panelAnchor === "bottom-left") {
        left = margin;
        top = window.innerHeight - panelHeight - margin;
      }

      if (panelAnchor === "top-left") {
        left = margin;
        top = margin;
      }

      const maxLeft = Math.max(8, window.innerWidth - panelWidth - 8);
      const maxTop = Math.max(8, window.innerHeight - panelHeight - 8);

      setPanelPosition({
        left: Math.min(Math.max(8, left), maxLeft),
        top: Math.min(Math.max(8, top), maxTop),
      });
    };

    updatePanelPosition();
    const raf = window.requestAnimationFrame(updatePanelPosition);
    window.addEventListener("resize", updatePanelPosition);

    const observer =
      panelRef.current && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => updatePanelPosition())
        : null;
    if (observer && panelRef.current) observer.observe(panelRef.current);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", updatePanelPosition);
      observer?.disconnect();
    };
  }, [panelAnchor]);

  useEffect(() => {
    const update = () => {
      const target = resolveActiveTarget();
      setActiveTarget((prev) => (prev === target ? prev : target));

      if (!target) {
        setFocusRect(null);
        return;
      }

      const rect = target.getBoundingClientRect();
      setFocusRect({
        left: Math.max(8, rect.left - 8),
        top: Math.max(8, rect.top - 8),
        width: Math.max(24, rect.width + 16),
        height: Math.max(24, rect.height + 16),
      });
    };

    update();
    const timer = window.setInterval(update, 140);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [resolveActiveTarget, stepIndex]);

  useEffect(() => {
    if (stepIndex <= steps.length - 1) return;
    setStepIndex(steps.length - 1);
  }, [stepIndex, steps.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (event.key === "ArrowRight") {
        if (isLanguageStep && (!languageSelected || languageSaving)) return;
        event.preventDefault();
        setStepIndex((prev) => Math.min(steps.length - 1, prev + 1));
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setStepIndex((prev) => Math.max(0, prev - 1));
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (isFirstRunMode) {
          void store.skipFirstRunWalkthrough();
        } else {
          store.closeFirstRunWalkthrough();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    isFirstRunMode,
    isLanguageStep,
    languageSaving,
    languageSelected,
    steps.length,
    store.closeFirstRunWalkthrough,
    store.skipFirstRunWalkthrough,
  ]);

  const progress = ((stepIndex + 1) / steps.length) * 100;
  const isLastStep = stepIndex === steps.length - 1;
  const showMissingTargetHint = !!activeStep.targets?.length && !activeTarget;

  return (
    <div className="fixed inset-0 z-[95] pointer-events-none">
      {focusRect ? (
        <div
          className="walkthrough-focus-ring"
          style={{
            left: focusRect.left,
            top: focusRect.top,
            width: focusRect.width,
            height: focusRect.height,
          }}
        />
      ) : (
        <div className="walkthrough-soft-scrim" />
      )}

      <div
        ref={panelRef}
        className="walkthrough-panel pointer-events-auto animate-scale-in"
        style={{
          left: `${panelPosition.left}px`,
          top: `${panelPosition.top}px`,
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="walkthrough-chip">{isFirstRunMode ? t("First-Time Walkthrough") : t("Walkthrough Replay")}</div>
          <button
            type="button"
            onClick={() => {
              if (isFirstRunMode) {
                void store.skipFirstRunWalkthrough();
              } else {
                store.closeFirstRunWalkthrough();
              }
            }}
            aria-label={t("Close walkthrough")}
            className="walkthrough-close-btn"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="mt-3 walkthrough-progress">
          <div className="walkthrough-progress-bar" style={{ width: `${progress}%` }} />
        </div>

        <div key={activeStep.id} className="mt-4 animate-fade-in-up">
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold tracking-tight text-[var(--panel-fg)]">{activeStep.title}</h2>
              <span className="text-[11px] theme-muted shrink-0">
                {t("Walkthrough step {{current}} of {{total}}", {
                  current: stepIndex + 1,
                  total: steps.length,
                })}
              </span>
            </div>
            <p className="mt-1.5 text-[12px] text-zinc-300 leading-relaxed">{activeStep.summary}</p>
          </div>

          {isLanguageStep ? (
            <div className="mt-3">
              <div className="text-[11px] uppercase tracking-wide theme-muted mb-1.5">{t("Language")}</div>
              <Select
                value={currentLanguage}
                options={LANGUAGE_OPTIONS}
                onChange={(value) => {
                  void handleLanguageChange(value);
                }}
                className="w-52"
              />
              {!languageSelected && (
                <div className="walkthrough-inline-tip mt-2">{t("Please select a language to continue")}</div>
              )}
              {languageSaving && (
                <div className="text-[11px] theme-muted mt-2">{t("Applying language...")}</div>
              )}
            </div>
          ) : null}

          <div className="mt-3 space-y-1.5">
            {activeStep.highlights.map((highlight) => (
              <div key={highlight} className="walkthrough-highlight-row">
                <span className="walkthrough-highlight-dot" />
                <span>{highlight}</span>
              </div>
            ))}
          </div>

          {showMissingTargetHint && activeStep.missingTargetHint ? (
            <div className="walkthrough-inline-tip mt-3">
              {activeStep.missingTargetHint}
            </div>
          ) : null}

          {activeStep.onAction && activeStep.actionLabel ? (
            <button
              type="button"
              onClick={activeStep.onAction}
              className="walkthrough-action-btn mt-3"
            >
              {activeStep.actionLabel}
            </button>
          ) : null}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setStepIndex((prev) => Math.max(0, prev - 1))}
            disabled={stepIndex === 0}
            className="walkthrough-secondary-btn"
          >
            <ArrowLeft size={13} strokeWidth={2} />
            <span>{t("Back")}</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (isFirstRunMode) {
                  void store.skipFirstRunWalkthrough();
                } else {
                  store.closeFirstRunWalkthrough();
                }
              }}
              className="walkthrough-tertiary-btn"
            >
              {isFirstRunMode ? t("Skip Walkthrough") : t("Close")}
            </button>

            <button
              type="button"
              onClick={() => {
                if (isLastStep) {
                  void store.completeFirstRunWalkthrough();
                  return;
                }
                setStepIndex((prev) => Math.min(steps.length - 1, prev + 1));
              }}
              disabled={isLanguageStep && (!languageSelected || languageSaving)}
              className="walkthrough-primary-btn"
            >
              <span>{isLastStep ? t("Finish") : t("Next")}</span>
              {!isLastStep ? <ArrowRight size={13} strokeWidth={2} /> : null}
            </button>
          </div>
        </div>

        <div className="mt-3 text-[11px] theme-muted">
          {t("You can skip now and replay this anytime in Settings.")}
        </div>
      </div>
    </div>
  );
}
