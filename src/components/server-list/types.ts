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

const STORAGE_KEY_FAVORITES = "ram_favorite_games";
const STORAGE_KEY_RECENT = "ram_recent_games";

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

  const hasName = !!opts?.name && opts.name.trim().length > 0;
  const optimisticName = hasName ? (opts!.name as string) : String(placeId);
  const optimisticIcon = opts?.iconUrl ?? null;
  addRecentGame(
    { placeId, name: optimisticName, iconUrl: optimisticIcon, lastPlayed: Date.now() },
    maxCount
  );

  const needName = !hasName;
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
