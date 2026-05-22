import { useState, useEffect, useRef } from "react";
import type { RecentGame } from "./types";
import { loadRecentGames, saveRecentGames, resolveRecentGame } from "./types";
import { useTr } from "../../i18n/text";

export interface RecentGamesListProps {
  userId: number | null;
  maxRecent: number;
  onSelect: (placeId: number) => void;
}

export function RecentGamesList({ userId, maxRecent, onSelect }: RecentGamesListProps) {
  const t = useTr();
  const [games, setGames] = useState<RecentGame[]>(loadRecentGames);
  const backfilledRef = useRef(false);

  useEffect(() => {
    if (backfilledRef.current) return;
    backfilledRef.current = true;

    let cancelled = false;
    (async () => {
      const next = loadRecentGames();
      let changed = false;
      for (let i = 0; i < next.length; i++) {
        const patched = await resolveRecentGame(next[i], userId);
        if (cancelled) return;
        if (patched) {
          next[i] = patched;
          changed = true;
          setGames([...next]);
        }
      }
      if (!cancelled && changed) {
        saveRecentGames(next);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  function handleClear() {
    saveRecentGames([]);
    setGames([]);
  }

  function formatTime(ts: number) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return t("{{count}}d ago", { count: days });
    if (hours > 0) return t("{{count}}h ago", { count: hours });
    if (mins > 0) return t("{{count}}m ago", { count: mins });
    return t("just now");
  }

  if (games.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-8">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="text-zinc-800 mb-3">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <p className="text-xs text-zinc-700">{t("No recent games")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-[10px] text-zinc-600">{t("{{count}} of {{max}} max", { count: games.length, max: maxRecent })}</span>
        <button
          onClick={handleClear}
          className="text-[10px] text-zinc-600 hover:text-red-400 transition-colors"
        >
          {t("Clear all")}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-1 px-1">
          {games.map((game) => (
            <div
              key={game.placeId}
              className="flex items-center gap-3 p-2 rounded-lg hover:bg-zinc-800/40 transition-colors cursor-pointer"
              onClick={() => onSelect(game.placeId)}
            >
              <div className="w-9 h-9 rounded-md bg-zinc-800 shrink-0 overflow-hidden">
                {game.iconUrl ? (
                  <img src={game.iconUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-700">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-zinc-200 truncate">{game.name}</div>
                <div className="text-[10px] text-zinc-600 font-mono">{t("ID: {{id}}", { id: game.placeId })}</div>
              </div>
              <span className="text-[10px] text-zinc-600 shrink-0">{formatTime(game.lastPlayed)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
