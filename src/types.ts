export interface Account {
  Valid: boolean;
  SecurityToken: string;
  Username: string;
  LastUse: string;
  Alias: string;
  Description: string;
  Password: string;
  Group: string;
  UserID: number;
  Fields: Record<string, string>;
  LastAttemptedRefresh: string;
  BrowserTrackerID: string;
}

export interface ThemeData {
  accounts_background: string;
  accounts_foreground: string;
  buttons_background: string;
  buttons_foreground: string;
  buttons_border: string;
  toggle_on_background?: string;
  toggle_off_background?: string;
  toggle_knob_background?: string;
  forms_background: string;
  forms_foreground: string;
  textboxes_background: string;
  textboxes_foreground: string;
  textboxes_border: string;
  label_background: string;
  label_foreground: string;
  label_transparent: boolean;
  dark_top_bar: boolean;
  show_headers: boolean;
  light_images: boolean;
  button_style: string;
  font_sans?: ThemeFontSpec;
  font_mono?: ThemeFontSpec;
}

export type ThemeFontSource = "google" | "local" | "system";

export interface ThemeFontGoogleSpec {
  weights: number[];
}

export interface ThemeFontLocalSpec {
  file: string; // stored under runtime `RAMThemeFonts/`
  weight: number;
  style: "normal" | "italic";
}

export interface ThemeFontSpec {
  source: ThemeFontSource;
  family: string;
  fallbacks: string[];
  google?: ThemeFontGoogleSpec;
  local?: ThemeFontLocalSpec;
}

export interface ThumbnailData {
  targetId: number;
  imageUrl: string | null;
  state: string;
}

export interface ParsedGroup {
  key: string;
  displayName: string;
  sortKey: number;
  accounts: Account[];
}

export type DragState =
  | { kind: "accounts"; userIds: number[] }
  | { kind: "group"; groupKey: string };

export type DropTarget =
  | { kind: "before-account"; userId: number }
  | { kind: "after-account"; userId: number }
  | { kind: "group-end"; groupKey: string }
  | { kind: "before-group"; groupKey: string }
  | { kind: "after-group"; groupKey: string };

export interface PlatformCapabilities {
  os: string;
  sessionType: string;
  preferredRunner: string;
  detectedRunner: string;
  runnerPath: string | null;
  supportsSingleLaunch: boolean;
  supportsMultiLaunch: boolean;
  supportsWatcher: boolean;
  supportsWatcherMemory: boolean;
  supportsWindowControls: boolean;
  supportsBotting: boolean;
  supportsUpdater: boolean;
  supportsClientSettings: boolean;
  reasons: string[];
  warnings: string[];
}

export function parseGroupName(group: string): { sortKey: number; displayName: string } {
  const match = group.match(/^(\d{1,3})\s*/);
  if (match) {
    const remainder = group.slice(match[0].length);
    return { sortKey: parseInt(match[1], 10), displayName: remainder || group };
  }
  return { sortKey: 999999, displayName: group };
}

export function timeAgo(dateStr: string): string {
  if (!dateStr) return "never";
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  if (diff < 0) return "just now";
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 365) return `${Math.floor(days / 365)}y`;
  if (days > 30) return `${Math.floor(days / 30)}mo`;
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "now";
}

export function getFreshnessColor(lastUse: string): string | null {
  if (!lastUse) return "#fa1a0d";
  const days = (Date.now() - new Date(lastUse).getTime()) / 86400000;
  if (days < 20) return null;
  const t = Math.min((days - 20) / 10, 1);
  const r = Math.round(255 + (250 - 255) * t);
  const g = Math.round(204 + (26 - 204) * t);
  const b = Math.round(77 + (13 - 77) * t);
  return `rgb(${r},${g},${b})`;
}
