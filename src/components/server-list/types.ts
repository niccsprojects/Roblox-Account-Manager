import { invoke } from "@tauri-apps/api/core";

export type TabId = "servers" | "games" | "favorites" | "recent";

export interface ServerData {
  id: string;
  maxPlayers: number;
  playing: number;
  playerTokens: string[];
  fps: number;
  ping: number | null;
  name: string | null;
  vipServerId: number | null;
  accessCode: string | null;
}

export interface ServersResponse {
  data: ServerData[];
  nextPageCursor: string | null;
}

export interface PlaceDetails {
  placeId: number;
  universeId: number;
  name: string;
  description: string;
  sourceName: string;
  sourceDescription: string;
  url: string;
}

export interface GameEntry {
  placeId: number;
  name: string;
  playerCount: number;
  likeRatio: number | null;
  iconUrl: string | null;
  universeId?: number;
}

export interface FavoriteGame {
  placeId: number;
  name: string;
  iconUrl: string | null;
  addedAt: number;
  privateServer?: string;
}

export interface RecentGame {
  placeId: number;
  name: string;
  iconUrl: string | null;
  lastPlayed: number;
}

export interface ServerRegion {
  region: string;
  loading: boolean;
}

export type RecentJobKind = "job" | "vip" | "link";

export interface RecentJobEntry {
  kind: RecentJobKind;
  raw: string;
  placeId: number | null;
  label: string;
  lastUsed: number;
  pinned?: boolean;
}

const STORAGE_KEY_FAVORITES = "ram_favorite_games";
const STORAGE_KEY_RECENT = "ram_recent_games";
const STORAGE_KEY_RECENT_JOBS = "ram_recent_jobs";

export function classifyJobInput(raw: string): RecentJobKind {
  if (/^vip:\s*.+$/i.test(raw)) return "vip";
  if (/(?:privateServerLinkCode|linkCode|code)=([^&\s]+)/i.test(raw)) return "link";
  return "job";
}

export function loadRecentJobs(): RecentJobEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT_JOBS) || "[]");
  } catch {
    return [];
  }
}

export function saveRecentJobs(entries: RecentJobEntry[]) {
  localStorage.setItem(STORAGE_KEY_RECENT_JOBS, JSON.stringify(entries));
}

export function addRecentJob(raw: string, placeId: number | null, maxCount: number) {
  const trimmed = raw.trim();
  if (!trimmed) return;
  const kind = classifyJobInput(trimmed);
  const entries = loadRecentJobs();
  const existing = entries.find((e) => e.kind === kind && e.raw === trimmed);
  const rest = entries.filter((e) => !(e.kind === kind && e.raw === trimmed));
  const entry: RecentJobEntry = {
    kind,
    raw: trimmed,
    placeId: existing?.placeId ?? placeId,
    label: existing?.label || "",
    lastUsed: Date.now(),
    pinned: existing?.pinned,
  };
  rest.unshift(entry);
  const pinned = rest.filter((e) => e.pinned);
  const unpinned = rest.filter((e) => !e.pinned).slice(0, Math.max(1, maxCount));
  saveRecentJobs(
    [...pinned, ...unpinned].sort((a, b) => b.lastUsed - a.lastUsed)
  );
}

export function updateRecentJob(
  raw: string,
  kind: RecentJobKind,
  patch: Partial<Pick<RecentJobEntry, "label" | "pinned">>
) {
  const entries = loadRecentJobs();
  const idx = entries.findIndex((e) => e.kind === kind && e.raw === raw);
  if (idx < 0) return;
  entries[idx] = { ...entries[idx], ...patch };
  saveRecentJobs(entries);
}

export function removeRecentJob(raw: string, kind: RecentJobKind) {
  saveRecentJobs(loadRecentJobs().filter((e) => !(e.kind === kind && e.raw === raw)));
}

export function loadFavorites(): FavoriteGame[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_FAVORITES) || "[]");
  } catch {
    return [];
  }
}

export function saveFavorites(favorites: FavoriteGame[]) {
  localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(favorites));
}

export function loadRecentGames(): RecentGame[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY_RECENT) || "[]");
  } catch {
    return [];
  }
}

export function saveRecentGames(games: RecentGame[]) {
  localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(games));
}

export function addRecentGame(game: RecentGame, maxCount: number) {
  const existing = loadRecentGames().filter((g) => g.placeId !== game.placeId);
  existing.unshift({ ...game, lastPlayed: Date.now() });
  saveRecentGames(existing.slice(0, maxCount));
}

async function resolveNameAndIcon(
  placeId: number,
  userId: number | null,
  needName: boolean,
  needIcon: boolean,
  fallbackName: string,
  fallbackIcon: string | null
): Promise<{ name: string; iconUrl: string | null }> {
  const [detailsRes, iconRes] = await Promise.allSettled([
    needName
      ? invoke<PlaceDetails[]>("get_place_details", { placeIds: [placeId], userId })
      : Promise.resolve(null),
    needIcon
      ? invoke<string | null>("batched_get_game_icon", { placeId, userId })
      : Promise.resolve(null),
  ]);

  let name = fallbackName;
  let iconUrl = fallbackIcon;
  if (
    detailsRes.status === "fulfilled" &&
    Array.isArray(detailsRes.value) &&
    detailsRes.value[0]?.name
  ) {
    name = detailsRes.value[0].name;
  }
  if (iconRes.status === "fulfilled" && typeof iconRes.value === "string" && iconRes.value) {
    iconUrl = iconRes.value;
  }
  return { name, iconUrl };
}

export async function recordRecentGame(
  placeId: number,
  userId: number | null,
  maxCount: number,
  opts?: { name?: string; iconUrl?: string | null }
) {
  if (!placeId || placeId <= 0) return;

  const existing = loadRecentGames().find((g) => g.placeId === placeId);
  const existingHasName = !!existing && !!existing.name && existing.name !== String(placeId);
  const hasName = !!opts?.name && opts.name.trim().length > 0;
  const optimisticName = hasName
    ? (opts!.name as string)
    : existingHasName
      ? (existing!.name as string)
      : String(placeId);
  const optimisticIcon = opts?.iconUrl ?? existing?.iconUrl ?? null;
  addRecentGame(
    { placeId, name: optimisticName, iconUrl: optimisticIcon, lastPlayed: Date.now() },
    maxCount
  );

  const needName = optimisticName === String(placeId);
  const needIcon = !optimisticIcon;
  if (!needName && !needIcon) return;

  const { name, iconUrl } = await resolveNameAndIcon(
    placeId,
    userId,
    needName,
    needIcon,
    optimisticName,
    optimisticIcon
  );
  if (name === optimisticName && iconUrl === optimisticIcon) return;

  const games = loadRecentGames();
  const idx = games.findIndex((g) => g.placeId === placeId);
  if (idx >= 0) {
    games[idx] = { ...games[idx], name, iconUrl };
    saveRecentGames(games);
  }
}

export async function resolveRecentGame(
  game: RecentGame,
  userId: number | null
): Promise<RecentGame | null> {
  const needName = !game.name || game.name === String(game.placeId);
  const needIcon = !game.iconUrl;
  if (!needName && !needIcon) return null;

  const { name, iconUrl } = await resolveNameAndIcon(
    game.placeId,
    userId,
    needName,
    needIcon,
    game.name,
    game.iconUrl
  );
  if (name === game.name && iconUrl === game.iconUrl) return null;
  return { ...game, name, iconUrl };
}
