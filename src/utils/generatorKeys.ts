import type { TOptions } from "i18next";
import type { GeneratorKeyTestResult } from "../store";

export function parseApiKeys(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}

export function apiKeysToText(stored: string): string {
  return parseApiKeys(stored).join("\n");
}

export function apiKeysToStored(text: string): string {
  return parseApiKeys(text).join(",");
}

export function describeKeyTests(
  results: GeneratorKeyTestResult[],
  t: (text: string, options?: TOptions) => string
): { ok: boolean; message: string }[] {
  return results.map((r) =>
    r.error === null
      ? {
          ok: true,
          message: t("Key {{index}} ({{hint}}) works, balance {{balance}}", {
            index: r.index + 1,
            hint: r.hint,
            balance: (r.balance ?? 0).toFixed(4),
          }),
        }
      : {
          ok: false,
          message: t("Key {{index}} ({{hint}}) failed: {{error}}", {
            index: r.index + 1,
            hint: r.hint,
            error: r.error,
          }),
        }
  );
}
