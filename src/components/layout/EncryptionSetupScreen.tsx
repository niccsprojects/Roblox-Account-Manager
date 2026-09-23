import { useEffect, useMemo, useState } from "react";
import { KeyRound, Lock } from "lucide-react";
import { useStore } from "../../store";
import { useTr } from "../../i18n/text";

type EncryptionMethod = "default" | "password";

export function EncryptionSetupScreen() {
  const t = useTr();
  const store = useStore();
  const [method, setMethod] = useState<EncryptionMethod>("password");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState("");

  const isFirstRun = store.encryptionSetupMode === "firstRun";
  const canClose = !isFirstRun;

  useEffect(() => {
    const preferred = isFirstRun
      ? "password"
      : store.accountsEncrypted
        ? "password"
        : "default";
    setMethod(preferred);
    setPassword("");
    setConfirmPassword("");
    setLocalError("");
  }, [isFirstRun, store.accountsEncrypted, store.encryptionSetupMode]);

  const currentMethodLabel = useMemo(() => {
    if (store.accountsEncrypted === null) return "";
    return store.accountsEncrypted
      ? t("Current method: Password Lock")
      : t("Current method: Default Encryption");
  }, [store.accountsEncrypted, t]);

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

  return (
    <div className="theme-app min-h-screen w-full flex items-center justify-center px-6 py-8 bg-[radial-gradient(1200px_420px_at_15%_0%,var(--accent-soft),transparent_62%),radial-gradient(900px_360px_at_85%_100%,var(--panel-soft),transparent_68%)]">
      <div className="w-full max-w-xl rounded-2xl border theme-border theme-panel shadow-2xl overflow-hidden animate-scale-in">
        <div className="px-6 py-5 border-b theme-border">
          <div className="animate-fade-in-up" style={{ animationDelay: "0.03s" }}>
            <h1 className="text-[15px] font-semibold text-[var(--panel-fg)]">
              {isFirstRun ? t("Set Up Encryption") : t("Change Encryption Method")}
            </h1>
            <p className="text-[12px] theme-muted mt-0.5">
              {t("Choose how AccountData.json is encrypted on this device.")}
            </p>
          </div>
          {!isFirstRun && currentMethodLabel ? (
            <div className="mt-3 text-[11px] theme-muted animate-fade-in-up" style={{ animationDelay: "0.07s" }}>
              {currentMethodLabel}
            </div>
          ) : null}
        </div>

        <div className="p-6 space-y-4">
          <div className="grid gap-2">
            <button
              type="button"
              onClick={() => setMethod("password")}
              aria-pressed={method === "password"}
              className={[
                "w-full text-left rounded-xl border p-3.5 transition-all duration-300 ease-out animate-fade-in-up",
                method === "password"
                  ? "theme-accent-border theme-surface"
                  : "border-[var(--border-color)] bg-[var(--panel-soft)] hover:border-[var(--accent-strong)]",
              ].join(" ")}
              style={{ animationDelay: "0.11s" }}
            >
              <div className="flex items-start gap-3">
                <div className={["mt-0.5", method === "password" ? "theme-accent" : "theme-muted"].join(" ")}><Lock size={16} strokeWidth={1.8} /></div>
                <div className="flex-1">
                  <div className="text-[13px] font-medium text-[var(--panel-fg)]">{t("Pass Lock (Recommended)")}</div>
                  <div className={[
                    "text-[11px] theme-muted mt-0.5 transition-all duration-300 ease-out overflow-hidden",
                    method === "password" ? "max-h-24 opacity-100" : "max-h-10 opacity-90",
                  ].join(" ")}>
                    {t("Use a password to encrypt AccountData.json. You'll enter it when RAM starts.")}
                  </div>
                </div>
                <div className={[
                  "mt-1 h-2.5 w-2.5 rounded-full border transition-all duration-300 ease-out",
                  method === "password"
                    ? "theme-accent-border theme-accent-bg"
                    : "theme-border bg-transparent",
                ].join(" ")} />
              </div>
            </button>

            <button
              type="button"
              onClick={() => setMethod("default")}
              aria-pressed={method === "default"}
              className={[
                "w-full text-left rounded-xl border p-3.5 transition-all duration-300 ease-out animate-fade-in-up",
                method === "default"
                  ? "theme-accent-border theme-surface"
                  : "border-[var(--border-color)] bg-[var(--panel-soft)] hover:border-[var(--accent-strong)]",
              ].join(" ")}
              style={{ animationDelay: "0.15s" }}
            >
              <div className="flex items-start gap-3">
                <div className={["mt-0.5", method === "default" ? "theme-accent" : "theme-muted"].join(" ")}><KeyRound size={16} strokeWidth={1.8} /></div>
                <div className="flex-1">
                  <div className="text-[13px] font-medium text-[var(--panel-fg)]">{t("Default Encryption")}</div>
                  <div className={[
                    "text-[11px] theme-muted mt-0.5 transition-all duration-300 ease-out overflow-hidden",
                    method === "default" ? "max-h-24 opacity-100" : "max-h-10 opacity-90",
                  ].join(" ")}>
                    {t("Use local default protection without a custom password.")}
                  </div>
                </div>
                <div className={[
                  "mt-1 h-2.5 w-2.5 rounded-full border transition-all duration-300 ease-out",
                  method === "default"
                    ? "theme-accent-border theme-accent-bg"
                    : "theme-border bg-transparent",
                ].join(" ")} />
              </div>
            </button>
          </div>

          <div
            className={[
              "rounded-xl border theme-border bg-[rgba(0,0,0,0.18)] overflow-hidden",
              "transition-all duration-300 ease-out",
              method === "password" ? "max-h-52" : "max-h-24",
            ].join(" ")}
            style={{ transitionProperty: "max-height" }}
          >
            <div key={method} className="animate-fade-in-up p-3.5">
              {method === "password" ? (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("Create Encryption Password")}
                    className="w-full rounded-lg theme-input px-3 py-2 text-[13px]"
                    autoFocus
                  />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t("Confirm Encryption Password")}
                    className="w-full rounded-lg theme-input px-3 py-2 text-[13px]"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void handleApply();
                      }
                    }}
                  />
                  <div className="text-[11px] theme-muted">{t("At least 8 characters.")}</div>
                </div>
              ) : (
                <div className="text-[12px] theme-muted pt-0.5">
                  {t("This can be changed later in Settings.")}
                </div>
              )}
            </div>
          </div>

          {(localError || store.encryptionSetupError) && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300 animate-fade-in-up" style={{ animationDelay: "0.02s" }}>
              {localError || store.encryptionSetupError}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t theme-border flex items-center justify-between gap-4 animate-fade-in-up" style={{ animationDelay: "0.2s" }}>
          <div className="text-[11px] theme-muted max-w-[62%]">
            {isFirstRun
              ? t("Required on first setup to secure your account vault.")
              : t("Re-encrypts your current AccountData.json with the selected method.")}
          </div>
          <div className={["grid gap-2 shrink-0", canClose ? "grid-cols-2" : "grid-cols-1"].join(" ")}>
            {canClose ? (
              <button
                type="button"
                onClick={store.closeEncryptionSetup}
                className="w-[132px] h-9 px-3 rounded-lg text-[12px] theme-btn-ghost"
              >
                {t("Cancel")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void handleApply();
              }}
              disabled={store.applyingEncryption}
              className="w-[132px] h-9 px-3.5 rounded-lg text-[12px] font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              style={{
                border: "1px solid var(--accent-strong)",
                background: "var(--accent-soft)",
                color: "var(--panel-fg)",
              }}
            >
              {store.applyingEncryption
                ? t("Applying encryption...")
                : isFirstRun
                  ? t("Continue")
                  : t("Apply Encryption")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
