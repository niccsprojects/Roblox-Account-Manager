import { useState, useCallback, useRef, useEffect, createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useTr } from "../i18n/text";

interface PromptState {
  message: string;
  defaultValue: string;
  resolve: (value: string | null) => void;
}

interface ConfirmState {
  message: string;
  destructive: boolean;
  resolve: (value: boolean) => void;
}

interface ConfirmWithOptOutState {
  message: string;
  destructive: boolean;
  optOutLabel: string;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (value: { confirmed: boolean; dontShowAgain: boolean }) => void;
}

interface ConfirmWithOptOutOptions {
  destructive?: boolean;
  optOutLabel?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface DialogContext {
  prompt: (message: string, defaultValue?: string) => Promise<string | null>;
  confirm: (message: string, destructive?: boolean) => Promise<boolean>;
  confirmWithOptOut: (
    message: string,
    options?: ConfirmWithOptOutOptions
  ) => Promise<{ confirmed: boolean; dontShowAgain: boolean }>;
}

const Ctx = createContext<DialogContext>({
  prompt: () => Promise.resolve(null),
  confirm: () => Promise.resolve(false),
  confirmWithOptOut: () =>
    Promise.resolve({ confirmed: false, dontShowAgain: false }),
});

export function usePrompt() {
  return useContext(Ctx).prompt;
}

export function useConfirm() {
  return useContext(Ctx).confirm;
}

export function useConfirmWithOptOut() {
  return useContext(Ctx).confirmWithOptOut;
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const t = useTr();
  const [promptState, setPromptState] = useState<PromptState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [confirmWithOptOutState, setConfirmWithOptOutState] =
    useState<ConfirmWithOptOutState | null>(null);
  const [value, setValue] = useState("");
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const prompt = useCallback((message: string, defaultValue = "") => {
    return new Promise<string | null>((resolve) => {
      setPromptState({ message, defaultValue, resolve });
      setValue(defaultValue);
    });
  }, []);

  const confirm = useCallback((message: string, destructive = false) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ message, destructive, resolve });
    });
  }, []);

  const confirmWithOptOut = useCallback(
    (message: string, options: ConfirmWithOptOutOptions = {}) => {
      return new Promise<{ confirmed: boolean; dontShowAgain: boolean }>((resolve) => {
        setDontShowAgain(false);
        setConfirmWithOptOutState({
          message,
          destructive: !!options.destructive,
          optOutLabel: options.optOutLabel || "Don't show this again",
          confirmLabel: options.confirmLabel || "Confirm",
          cancelLabel: options.cancelLabel || "Cancel",
          resolve,
        });
      });
    },
    []
  );

  useEffect(() => {
    if (promptState && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [promptState]);

  useEffect(() => {
    if ((confirmState || confirmWithOptOutState) && confirmRef.current) {
      confirmRef.current.focus();
    }
  }, [confirmState, confirmWithOptOutState]);

  function finishPrompt(result: string | null) {
    setClosing(true);
    setTimeout(() => {
      promptState?.resolve(result);
      setPromptState(null);
      setClosing(false);
      setValue("");
    }, 100);
  }

  function finishConfirm(result: boolean) {
    setClosing(true);
    setTimeout(() => {
      confirmState?.resolve(result);
      setConfirmState(null);
      setClosing(false);
    }, 100);
  }

  function finishConfirmWithOptOut(confirmed: boolean) {
    setClosing(true);
    setTimeout(() => {
      confirmWithOptOutState?.resolve({
        confirmed,
        dontShowAgain: confirmed ? dontShowAgain : false,
      });
      setConfirmWithOptOutState(null);
      setDontShowAgain(false);
      setClosing(false);
    }, 100);
  }

  function handlePromptKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); finishPrompt(value); }
    else if (e.key === "Escape") { e.preventDefault(); finishPrompt(null); }
  }

  function handleConfirmKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); finishConfirm(true); }
    else if (e.key === "Escape") { e.preventDefault(); finishConfirm(false); }
  }

  function handleConfirmWithOptOutKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); finishConfirmWithOptOut(true); }
    else if (e.key === "Escape") { e.preventDefault(); finishConfirmWithOptOut(false); }
  }

  const active = promptState || confirmState || confirmWithOptOutState;

  return (
    <Ctx.Provider value={{ prompt, confirm, confirmWithOptOut }}>
      {children}

      {active && (
        <div
          className={`fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm ${closing ? "animate-fade-out" : "animate-fade-in"}`}
          onClick={() => {
            if (promptState) finishPrompt(null);
            else if (confirmState) finishConfirm(false);
            else finishConfirmWithOptOut(false);
          }}
        >
          <div
            className={`theme-modal-scope theme-panel theme-border bg-zinc-900 border border-zinc-800/80 rounded-xl shadow-2xl w-80 overflow-hidden ${closing ? "animate-scale-out" : "animate-scale-in"}`}
            onClick={(e) => e.stopPropagation()}
          >
            {promptState && (
              <>
                <div className="px-4 pt-4 pb-3">
                  <p className="text-[13px] text-zinc-300 mb-3">{t(promptState.message)}</p>
                  <input
                    ref={inputRef}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    className="w-full px-3 py-[7px] bg-zinc-800/60 border border-zinc-700/50 rounded-lg text-[13px] text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 transition-colors"
                  />
                </div>
                <div className="flex items-center justify-end gap-2 px-4 pb-3.5 pt-1">
                  <button
                    onClick={() => finishPrompt(null)}
                    className="px-3.5 py-[5px] rounded-lg text-[12px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  >
                    {t("Cancel")}
                  </button>
                  <button
                    onClick={() => finishPrompt(value)}
                    className="px-3.5 py-[5px] rounded-lg text-[12px] text-zinc-100 bg-sky-600 hover:bg-sky-500 transition-colors"
                  >
                    {t("OK")}
                  </button>
                </div>
              </>
            )}

            {confirmState && (
              <>
                <div className="px-4 pt-4 pb-3">
                  <p className="text-[13px] text-zinc-300">{t(confirmState.message)}</p>
                </div>
                <div className="flex items-center justify-end gap-2 px-4 pb-3.5 pt-1">
                  <button
                    onClick={() => finishConfirm(false)}
                    className="px-3.5 py-[5px] rounded-lg text-[12px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  >
                    {t("Cancel")}
                  </button>
                  <button
                    ref={confirmRef}
                    onClick={() => finishConfirm(true)}
                    onKeyDown={handleConfirmKeyDown}
                    className={`px-3.5 py-[5px] rounded-lg text-[12px] text-zinc-100 transition-colors ${
                      confirmState.destructive
                        ? "bg-red-600 hover:bg-red-500"
                        : "bg-sky-600 hover:bg-sky-500"
                    }`}
                  >
                    {t("Confirm")}
                  </button>
                </div>
              </>
            )}

            {confirmWithOptOutState && (
              <>
                <div className="px-4 pt-4 pb-2.5">
                  <p className="text-[13px] text-zinc-300">{t(confirmWithOptOutState.message)}</p>
                  <label className="mt-3 inline-flex items-center gap-2 text-[12px] text-zinc-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={dontShowAgain}
                      onChange={(e) => setDontShowAgain(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-800 text-sky-500"
                    />
                    <span>{t(confirmWithOptOutState.optOutLabel)}</span>
                  </label>
                </div>
                <div className="flex items-center justify-end gap-2 px-4 pb-3.5 pt-1">
                  <button
                    onClick={() => finishConfirmWithOptOut(false)}
                    className="px-3.5 py-[5px] rounded-lg text-[12px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  >
                    {t(confirmWithOptOutState.cancelLabel)}
                  </button>
                  <button
                    ref={confirmRef}
                    onClick={() => finishConfirmWithOptOut(true)}
                    onKeyDown={handleConfirmWithOptOutKeyDown}
                    className={`px-3.5 py-[5px] rounded-lg text-[12px] text-zinc-100 transition-colors ${
                      confirmWithOptOutState.destructive
                        ? "bg-red-600 hover:bg-red-500"
                        : "bg-sky-600 hover:bg-sky-500"
                    }`}
                  >
                    {t(confirmWithOptOutState.confirmLabel)}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
