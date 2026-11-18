import { useStore } from "../../store";
import { useTr } from "../../i18n/text";

export function UpdateBanner() {
  const t = useTr();
  const store = useStore();

  if (!store.updateInfo) return null;

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-[var(--textboxes-bg)] border-b border-[var(--accent-color)] shrink-0">
      <span className="text-xs text-[var(--textboxes-fg)]">
        {t("v{{version}} available", { version: store.updateInfo.version })}
      </span>
      <button
        onClick={() => store.setUpdateDialogOpen(true)}
        className="text-xs font-medium text-[var(--textboxes-fg)] underline underline-offset-2 hover:opacity-80 transition-opacity"
      >
        {t("View Update")}
      </button>
    </div>
  );
}
