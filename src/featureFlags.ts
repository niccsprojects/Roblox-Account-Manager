function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  return fallback;
}

export const ENABLE_NEXUS = parseBooleanEnv(import.meta.env.VITE_ENABLE_NEXUS, true);
export const ENABLE_WEBSERVER = parseBooleanEnv(import.meta.env.VITE_ENABLE_WEBSERVER, true);
export const ENABLE_FIRST_RUN_WALKTHROUGH = parseBooleanEnv(
  import.meta.env.VITE_ENABLE_FIRST_RUN_WALKTHROUGH,
  false
);
