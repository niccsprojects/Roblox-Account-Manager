import { useTr } from "../../i18n/text";

export function RestartBadge() {
  const t = useTr();
  return (
    <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 rounded border border-[var(--accent-color)] text-[10px] text-[var(--panel-fg)]">
      {t("restart required")}
    </span>
  );
}
