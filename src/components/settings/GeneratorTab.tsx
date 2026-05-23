import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UseSettingsReturn } from "../../hooks/useSettings";
import { useStore } from "../../store";
import { NumberField } from "../ui/NumberField";
import { TextField } from "../ui/TextField";
import { Select } from "../ui/Select";
import { Divider } from "../ui/Divider";
import { SectionLabel } from "../ui/SectionLabel";
import { useTr } from "../../i18n/text";
import { Eye, EyeOff, ExternalLink } from "lucide-react";

const PROVIDER_OPTIONS = [{ value: "bloxgen", label: "BloxGen" }];

const BLOXGEN_TYPE_OPTIONS = [
  { value: "alt", label: "alt" },
  { value: "+30 days old", label: "+30 days old" },
  { value: "+1 year old", label: "+1 year old" },
  { value: "5+ years old", label: "5+ years old" },
  { value: "dump", label: "dump" },
];

export function GeneratorTab({ s }: { s: UseSettingsReturn }) {
  const t = useTr();
  const store = useStore();
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const provider = s.get("Generator", "Provider", "bloxgen") || "bloxgen";
  const endpoint = s.get("BloxGen", "Endpoint", "https://core.bloxgen.net");
  const apiKey = s.get("BloxGen", "ApiKey", "");
  const accountType = s.get("BloxGen", "AccountType", "alt");

  const status = store.generatorStatus;
  const running = status?.active === true;
  const [busy, setBusy] = useState(false);

  async function handleTestKey() {
    setTesting(true);
    setTestResult(null);
    try {
      const balance = await invoke<number>("generator_test_key", {
        provider,
        endpoint,
        apiKey,
      });
      setTestResult({
        ok: true,
        message: t("Valid key — balance {{balance}}", { balance: balance.toFixed(4) }),
      });
    } catch (e) {
      setTestResult({ ok: false, message: String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function handleToggle() {
    if (busy) return;
    setBusy(true);
    try {
      if (running) {
        await store.stopGenerator();
        return;
      }
      if (!apiKey.trim()) {
        setTestResult({ ok: false, message: t("An API key is required") });
        return;
      }
      await store.startGenerator({
        provider,
        endpoint,
        apiKey,
        accountType,
        extraDelaySeconds: s.getNumber("Generator", "ExtraDelaySeconds", 1),
        targetGroup: s.get("Generator", "TargetGroup", "BloxGen"),
        maxAccounts: s.getNumber("Generator", "MaxAccounts", 0),
      });
    } catch {
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-0">
      <SectionLabel>Provider</SectionLabel>
      <div className="flex items-center gap-3 py-2 px-1">
        <span className="text-[13px] text-zinc-300 shrink-0">{t("Generator")}</span>
        <Select
          value={provider}
          options={PROVIDER_OPTIONS}
          onChange={(v) => s.set("Generator", "Provider", v)}
          className="ml-auto w-48"
        />
      </div>
      <div className="px-1 -mt-1 mb-1">
        <span className="text-[11px] text-zinc-500">
          {t("Pulls fresh Roblox accounts from the provider and adds them automatically")}
        </span>
      </div>

      <Divider />
      <SectionLabel>BloxGen</SectionLabel>
      <TextField
        value={endpoint}
        onChange={(v) => s.set("BloxGen", "Endpoint", v)}
        label="Endpoint"
        placeholder="https://core.bloxgen.net"
      />
      <div className="flex items-center gap-3 py-2 px-1">
        <span className="text-[13px] text-zinc-300 shrink-0">{t("API Key")}</span>
        <div className="ml-auto flex items-center gap-1.5 flex-1 min-w-0 max-w-[260px]">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => s.set("BloxGen", "ApiKey", e.target.value.trim())}
            placeholder="BLOX-XXXXXXXXXXXXXXXX"
            className="flex-1 min-w-0 px-2.5 py-1 rounded-md text-[13px] font-mono bg-zinc-800/60 border border-zinc-700/60 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-sky-500/40 transition-colors"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors shrink-0"
            aria-label={showKey ? t("Hide API key") : t("Show API key")}
          >
            {showKey ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3 py-2 px-1">
        <span className="text-[13px] text-zinc-300 shrink-0">{t("Account Type")}</span>
        <Select
          value={accountType}
          options={BLOXGEN_TYPE_OPTIONS}
          onChange={(v) => s.set("BloxGen", "AccountType", v)}
          className="ml-auto w-48"
        />
      </div>
      <div className="flex items-center justify-between gap-3 py-2 px-1">
        <span className="text-[11px] text-zinc-500 min-w-0 truncate">
          {testResult ? (
            <span className={testResult.ok ? "text-emerald-400" : "text-red-400"}>
              {testResult.message}
            </span>
          ) : (
            t("Check the key and view your balance")
          )}
        </span>
        <button
          onClick={handleTestKey}
          disabled={testing || !apiKey.trim()}
          className="px-3 py-1 rounded text-[12px] font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/60 text-zinc-300 transition-colors disabled:opacity-50 shrink-0"
        >
          {testing ? "..." : t("Test API key")}
        </button>
      </div>

      <Divider />
      <SectionLabel>Generation</SectionLabel>
      <NumberField
        value={s.getNumber("Generator", "ExtraDelaySeconds", 1)}
        onChange={(v) => s.setNumber("Generator", "ExtraDelaySeconds", v)}
        label="Extra Delay After Cooldown"
        min={0}
        max={3600}
        suffix="sec"
      />
      <TextField
        value={s.get("Generator", "TargetGroup", "BloxGen")}
        onChange={(v) => s.set("Generator", "TargetGroup", v)}
        label="Add To Group"
        placeholder="BloxGen"
      />
      <NumberField
        value={s.getNumber("Generator", "MaxAccounts", 0)}
        onChange={(v) => s.setNumber("Generator", "MaxAccounts", v)}
        label="Stop After"
        min={0}
        max={10000}
        suffix="accounts"
      />
      <div className="px-1 -mt-1 mb-1">
        <span className="text-[11px] text-zinc-500">{t("Set Stop After to 0 to keep generating until stopped")}</span>
      </div>

      <Divider />
      <SectionLabel>Generator</SectionLabel>
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex flex-col min-w-0">
          <span className="text-[13px] text-zinc-300">
            {running ? t("Running") : t("Idle")}
            {status && status.totalGenerated > 0
              ? ` · ${t("{{count}} generated", { count: status.totalGenerated })}`
              : ""}
          </span>
          {status?.lastError ? (
            <span className="text-[11px] text-red-400/90 truncate mt-0.5">{status.lastError}</span>
          ) : null}
        </div>
        <button
          onClick={handleToggle}
          disabled={busy}
          className={`px-3 py-1 rounded text-[12px] font-medium transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
            running
              ? "bg-red-500/15 text-red-400 hover:bg-red-500/25"
              : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
          }`}
        >
          {busy ? "..." : running ? t("Stop") : t("Start")}
        </button>
      </div>
      <button
        onClick={() => store.setGeneratorDialogOpen(true)}
        className="flex items-center gap-2 px-3 py-2 text-[12px] text-sky-400 hover:text-sky-300 transition-colors"
      >
        <ExternalLink size={13} strokeWidth={1.5} />
        {t("Open live view")}
      </button>
    </div>
  );
}
