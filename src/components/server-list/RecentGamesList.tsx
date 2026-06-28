import { useState, useEffect, useRef } from "react";
import type { RecentGame } from "./types";
import { loadRecentGames, saveRecentGames, resolveRecentGame } from "./types";
import { useTr } from "../../i18n/text";

export interface RecentGamesListProps {
  userId: number | null;
  maxRecent: number;
  onSelect: (placeId: number, name?: string, iconUrl?: string | null) => void;
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showBottomFade, setShowBottomFade] = useState(false);

  function updateFade() {
    const el = scrollRef.current;
    if (!el) return;
    setShowBottomFade(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateFade();
    const ro = new ResizeObserver(() => updateFade());
    ro.observe(el);
    return () => ro.disconnect();
  }, [games]);

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
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={updateFade}
          className="h-full overflow-y-auto overscroll-contain"
        >
          <div className="flex flex-col gap-1 px-1 pb-1">
            {games.map((game) => {
              const named = !!game.name && game.name !== String(game.placeId);
              return (
                <div
                  key={game.placeId}
                  className="flex items-center gap-3 rounded-lg p-2 cursor-pointer transition-colors hover:bg-zinc-800/50"
                  onClick={() => onSelect(game.placeId, game.name, game.iconUrl)}
                  title={named ? game.name : String(game.placeId)}
                >
                  <div className="h-9 w-9 shrink-0 overflow-hidden rounded-md bg-zinc-800">
                    {game.iconUrl ? (
                      <img src={game.iconUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-700">
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] leading-tight text-zinc-200">
                      {named ? game.name : t("Place {{id}}", { id: game.placeId })}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
                      {t("ID: {{id}}", { id: game.placeId })}
                    </div>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-zinc-600">
                    {formatTime(game.lastPlayed)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-zinc-900 to-transparent transition-opacity duration-150 ${
            showBottomFade ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>
    </div>
  );
}
