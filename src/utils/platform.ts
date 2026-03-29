import type { PlatformCapabilities } from "../types";

export function isWindowsPlatform(capabilities: PlatformCapabilities | null): boolean {
  const platform = capabilities?.os || "";
  return (
    platform === "windows" ||
    (platform === "" &&
      typeof navigator !== "undefined" &&
      navigator.userAgent.toLowerCase().includes("windows"))
  );
}
