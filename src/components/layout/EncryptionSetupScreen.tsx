import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { useTr } from "../../i18n/text";
import { ModalWindowControls } from "./ModalWindowControls";

type EncryptionMethod = "default" | "password";

const METHODS: { id: EncryptionMethod; title: string; points: string[] }[] = [
  {
    id: "password",
    title: "Password",
    points: [
      "Asked each time RAM starts",
      "Copy the file to any PC and unlock it there",
      "Lost password means lost accounts",
    ],
  },
  {
    id: "default",
    title: "This device",
    points: [
      "Opens straight away, no prompt",
      "Only readable on this PC",
      "Nothing to remember",
    ],
  },
];

export function EncryptionSetupScreen() {
  const t = useTr();
  const store = useStore();
  const [method, setMethod] = useState<EncryptionMethod>("password");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState("");

  const isFirstRun = store.encryptionSetupMode === "firstRun";
  const currentMethod: EncryptionMethod | null =
    isFirstRun || store.accountsEncrypted === null
      ? null
      : store.accountsEncrypted
        ? "password"
        : "default";

  useEffect(() => {
    setMethod(isFirstRun || store.accountsEncrypted ? "password" : "default");
    setPassword("");
    setConfirmPassword("");
    setLocalError("");
  }, [isFirstRun, store.accountsEncrypted, store.encryptionSetupMode]);

  async function handleApply() {
    setLocalError("");
    if (method === "password") {
      if (!password.trim()) {
        setLocalError(t("Please enter an encryption password"));
        return;
      }
      if (password.trim().length < 8) {
        setLocalError(t("Password must be at least 8 characters"));
        return;
      }
      if (password !== confirmPassword) {
        setLocalError(t("Passwords do not match"));
        return;
      }
    }

    try {
      await store.applyEncryptionMethod(method, method === "password" ? password : undefined);
    } catch {}
  }

  const error = localError || store.encryptionSetupError;

  return (
    <div className="theme-app min-h-screen w-full flex items-center justify-center px-6 py-8">
      <div data-tauri-drag-region className="fixed inset-x-0 top-0 h-10" />
      <ModalWindowControls visible />
      <form
        className="w-full max-w-[560px] animate-fade-in-up"
        onSubmit={(e) => {
          e.preventDefault();
          void handleApply();
        }}
      >
        <h1 className="text-center text-[20px] font-semibold tracking-[-0.01em] text-[var(--panel-fg)] mb-6">
          {isFirstRun ? t("How should RAM lock your accounts?") : t("Change how RAM locks your accounts")}
        </h1>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {METHODS.map((option) => {
            const selected = method === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setMethod(option.id)}
                aria-pressed={selected}
                className={[
                  "text-left rounded-xl border px-4 pt-4 pb-[18px] transition-colors duration-200",
                  selected
                    ? "border-[var(--accent-color)] bg-[var(--textboxes-bg)]"
                    : "border-[var(--textboxes-bc)] bg-transparent hover:border-[var(--border-color)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-3 mb-2.5">
                  <span className="text-[14px] font-semibold text-[var(--panel-fg)]">
                    {t(option.title)}
                    {currentMethod === option.id ? (
                      <span className="ml-2 text-[11px] font-normal theme-muted">{t("Current")}</span>
                    ) : null}
                  </span>
                  <span
                    className={[
                      "h-[9px] w-[9px] shrink-0 rounded-full border transition-colors duration-200",
                      selected ? "border-[var(--accent-color)] bg-[var(--accent-color)]" : "theme-border",
                    ].join(" ")}
                  />
                </div>
                <ul className="grid gap-[5px]">
                  {option.points.map((point) => (
                    <li key={point} className="text-[12px] leading-[1.45] theme-muted">
                      {t(point)}
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>

        {method === "password" ? (
          <div key="password" className="mt-3.5 grid gap-2 animate-fade-in-up">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("Password, 8+ characters")}
              className="w-full rounded-lg theme-input px-3 py-2 text-[13px] focus:!shadow-none focus:!border-[var(--accent-color)]"
              autoFocus
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t("Repeat password")}
              className="w-full rounded-lg theme-input px-3 py-2 text-[13px] focus:!shadow-none focus:!border-[var(--accent-color)]"
            />
          </div>
        ) : null}

        {error ? (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {error}
          </div>
        ) : null}

        <div className="mt-3.5 flex items-center justify-between gap-4">
          <p className="text-[12px] theme-muted">
            {isFirstRun ? t("You can switch later in Settings.") : ""}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            {isFirstRun ? null : (
              <button
                type="button"
                onClick={store.closeEncryptionSetup}
                className="h-9 px-4 rounded-lg text-[12.5px] theme-btn-ghost"
              >
                {t("Cancel")}
              </button>
            )}
            <button
              type="submit"
              disabled={store.applyingEncryption}
              className="h-9 px-[18px] text-[12.5px] font-medium theme-btn !text-[var(--panel-fg)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {store.applyingEncryption ? t("Applying encryption...") : isFirstRun ? t("Continue") : t("Apply")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
