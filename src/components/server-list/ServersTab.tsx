import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerData, ServersResponse, PlaceDetails, ServerRegion } from "./types";
import { ServerContextMenu } from "./ServerContextMenu";
import { useTr } from "../../i18n/text";
import { Server } from "lucide-react";

export interface ServersTabProps {
  placeId: string;
  setPlaceId: (id: string) => void;
  onJoinServer: (jobId: string) => void;
  addToast: (msg: string) => void;
  userId: number | null;
  refreshOnOpenSignal: number;
}

export function ServersTab({
  placeId,
  setPlaceId,
  onJoinServer,
  addToast,
  userId,
  refreshOnOpenSignal,
}: ServersTabProps) {
  const t = useTr();
  const [servers, setServers] = useState<ServerData[]>([]);
  const [loading, setLoading] = useState(false);
  const [placeName, setPlaceName] = useState("");
  const [regions, setRegions] = useState<Map<string, ServerRegion>>(new Map());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; server: ServerData } | null>(null);
  const [findUsername, setFindUsername] = useState("");
  const [finding, setFinding] = useState(false);
  const [findProgress, setFindProgress] = useState(0);
  const [teleportPlaceId, setTeleportPlaceId] = useState("");
  const busyRef = useRef(false);
  const autoRefreshSeenRef = useRef<number>(0);

  const loadServers = useCallback(async () => {
    const pid = parseInt(placeId);
    if (!pid || pid <= 0) {
      addToast(t("Enter a valid Place ID"));
      return;
    }

    if (loading) {
      busyRef.current = false;
      return;
    }

    setLoading(true);
    setServers([]);
    setRegions(new Map());
    busyRef.current = true;

    try {
      const details = await invoke<PlaceDetails[]>("get_place_details", {
        placeIds: [pid],
        userId: userId,
      });
      if (details.length > 0) setPlaceName(details[0].name);
    } catch {}

    let cursor: string | null = null;
    const allServers: ServerData[] = [];

    try {
      while (busyRef.current) {
        const page: ServersResponse = await invoke("get_servers", {
          placeId: pid,
          serverType: "Public",
          cursor,
          userId,
        });

        allServers.push(...page.data);
        setServers([...allServers]);

        if (!page.nextPageCursor || !busyRef.current) break;
        cursor = page.nextPageCursor;
      }
    } catch (e) {
      addToast(t("Failed to load servers: {{error}}", { error: String(e) }));
    }

    busyRef.current = false;
    setLoading(false);
  }, [placeId, loading, userId, addToast]);

  const loadRegion = useCallback(async (server: ServerData) => {
    const pid = parseInt(placeId);
    if (!pid || !userId) {
      addToast(t("Select an account to load regions"));
      return;
    }

    setRegions((prev) => {
      const next = new Map(prev);
      next.set(server.id, { region: "Loading...", loading: true });
      return next;
    });

    try {
      const response = await invoke<Record<string, unknown>>("join_game_instance", {
        userId,
        placeId: parseInt(teleportPlaceId) || pid,
        gameId: server.id,
        isTeleport: !!teleportPlaceId,
      });

      const joinScript = response?.joinScript as Record<string, unknown> | undefined;
      const ip = (joinScript?.MachineAddress as string) || "";

      if (ip) {
        try {
          const geoResponse = await fetch(`https://ipapi.co/${ip}/json/`);
          const geo = await geoResponse.json();
          const region = `${geo.city || "Unknown"}, ${geo.country_code || "??"}`;
          setRegions((prev) => {
            const next = new Map(prev);
            next.set(server.id, { region, loading: false });
            return next;
          });
        } catch {
          setRegions((prev) => {
            const next = new Map(prev);
            next.set(server.id, { region: ip, loading: false });
            return next;
          });
        }
      } else {
        const status = response?.status as number;
        const message = response?.message as string;
        setRegions((prev) => {
          const next = new Map(prev);
          next.set(server.id, { region: message || `Error ${status}`, loading: false });
          return next;
        });
      }
    } catch (e) {
      setRegions((prev) => {
        const next = new Map(prev);
        next.set(server.id, { region: String(e).slice(0, 40), loading: false });
        return next;
      });
    }
  }, [placeId, teleportPlaceId, userId, addToast]);

  const findPlayer = useCallback(async () => {
    if (!findUsername.trim()) return;
    const pid = parseInt(placeId);
    if (!pid) {
      addToast(t("Enter a Place ID first"));
      return;
    }

    setFinding(true);
    setFindProgress(0);

    try {
      const user = await invoke<{ id: number; name: string }>("lookup_user", {
        username: findUsername.trim(),
      });

      const presence = await invoke<{ placeId?: number | null; rootPlaceId?: number | null; gameId?: string | null }[]>(
        "get_presence",
        { userIds: [user.id], viewerUserId: userId }
      ).catch(() => []);
      const live = presence[0];
      if (live?.gameId && (live.placeId === pid || live.rootPlaceId === pid)) {
        const jobId = live.gameId;
        setServers((prev) => [
          prev.find((s) => s.id === jobId) ?? {
            id: jobId,
            maxPlayers: 0,
            playing: 0,
            playerTokens: [],
            fps: 0,
            ping: null,
            name: null,
            vipServerId: null,
            accessCode: null,
          },
        ]);
        addToast(t("Found {{name}} in server!", { name: user.name }));
        setFinding(false);
        return;
      }

      const headshots = await invoke<{ targetId: number; imageUrl: string | null }[]>("get_avatar_headshots", {
        userIds: [user.id],
        size: "48x48",
      });
      const targetUrl = headshots?.[0]?.imageUrl;
      if (!targetUrl) {
        addToast(t("Could not get avatar for player"));
        setFinding(false);
        return;
      }

      let cursor: string | null = null;
      let pagesScanned = 0;
      let found = false;
      let sawTokens = false;

      while (!found) {
        const pageResult: ServersResponse = await invoke("get_servers", {
          placeId: pid,
          serverType: "Public",
          cursor,
          userId,
        });

        pagesScanned++;
        setFindProgress(pagesScanned);

        for (const server of pageResult.data) {
          if (server.playerTokens.length === 0) continue;
          sawTokens = true;

          const batchRequests = server.playerTokens.map((token: string, i: number) => ({
            requestId: `${i}:undefined:AvatarHeadShot:48x48:png:regular`,
            type: "AvatarHeadShot",
            targetId: 0,
            token,
            size: "48x48",
            format: "png",
          }));

          try {
            const thumbResult = await invoke<{ targetId: number; imageUrl: string | null }[]>("batch_thumbnails", {
              requests: batchRequests,
            });

            const thumbs = Array.isArray(thumbResult) ? thumbResult : [];
            const match = thumbs.some((t) => t.imageUrl === targetUrl);
            if (match) {
              setServers([server]);
              setFinding(false);
              addToast(t("Found {{name}} in server!", { name: user.name }));
              found = true;
              break;
            }
          } catch {}
        }

        if (!pageResult.nextPageCursor || found) break;
        if (!sawTokens && pageResult.data.some((s) => s.playing > 0)) break;
        cursor = pageResult.nextPageCursor;
      }

      if (!found) {
        addToast(
          sawTokens
            ? t("{{name}} not found in any server", { name: user.name })
            : t("Roblox hides who is in each server, so {{name}} can only be found while their joins are visible to this account", { name: user.name })
        );
      }
    } catch (e) {
      addToast(t("Player search failed: {{error}}", { error: String(e) }));
    }

    setFinding(false);
  }, [findUsername, placeId, userId, addToast]);

  // Auto-refresh once whenever the dialog opens, if Place ID already has a value.
  // This mirrors the legacy "open and load immediately" workflow.
  useEffect(() => {
    if (refreshOnOpenSignal <= 0) return;
    if (autoRefreshSeenRef.current === refreshOnOpenSignal) return;

    const pid = parseInt(placeId, 10);
    if (!(pid > 0)) return;

    autoRefreshSeenRef.current = refreshOnOpenSignal;
    loadServers();
  }, [refreshOnOpenSignal, placeId, loadServers]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-1 pb-3">
        <div className="flex-1 flex items-center gap-2">
          <label className="text-[10px] text-zinc-600 shrink-0 uppercase tracking-wider">{t("Place ID")}</label>
          <input
            value={placeId}
            onChange={(e) => setPlaceId(e.target.value.replace(/\D/g, ""))}
            placeholder={t("Enter Place ID")}
            className="flex-1 sidebar-input font-mono text-xs"
            onKeyDown={(e) => e.key === "Enter" && loadServers()}
          />
        </div>
        <button
          onClick={loadServers}
          disabled={finding}
          className={`px-4 py-[6px] rounded-lg text-[12px] font-medium transition-all ${
            loading
              ? "bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30"
              : "bg-sky-600 hover:bg-sky-500 text-white"
          }`}
        >
          {loading ? t("Stop") : t("Refresh")}
        </button>
      </div>

      {placeName && (
        <div className="px-1 pb-2 text-[11px] text-zinc-500 truncate">
          {placeName}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-zinc-800/60 bg-zinc-950/50">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-zinc-900/95 backdrop-blur-sm z-10">
            <tr className="text-[10px] uppercase tracking-wider text-zinc-600 border-b border-zinc-800/60">
              <th className="py-2 px-3 font-medium w-10">#</th>
              <th className="py-2 px-3 font-medium">{t("Players")}</th>
              <th className="py-2 px-3 font-medium w-16">{t("Ping")}</th>
              <th className="py-2 px-3 font-medium w-16">{t("FPS")}</th>
              <th className="py-2 px-3 font-medium">{t("Region")}</th>
            </tr>
          </thead>
          <tbody>
            {servers.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Server size={28} strokeWidth={1} className="text-zinc-800" />
                    <span className="text-xs text-zinc-700">{t("Enter a Place ID and click Refresh")}</span>
                  </div>
                </td>
              </tr>
            )}
            {servers.map((server, idx) => {
              const regionData = regions.get(server.id);
              const fillPct = server.maxPlayers > 0 ? (server.playing / server.maxPlayers) * 100 : 0;
              const fillColor = fillPct > 90 ? "text-red-400" : fillPct > 70 ? "text-amber-400" : "text-emerald-400";

              return (
                <tr
                  key={server.id}
                  className="border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors cursor-pointer group"
                  onDoubleClick={() => onJoinServer(server.accessCode ? `VIP:${server.accessCode}` : server.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, server });
                  }}
                >
                  <td className="py-1.5 px-3 text-[11px] text-zinc-600 font-mono">{idx + 1}</td>
                  <td className="py-1.5 px-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-[12px] font-mono ${fillColor}`}>
                        {server.playing}
                      </span>
                      <span className="text-[11px] text-zinc-600">/</span>
                      <span className="text-[11px] text-zinc-500 font-mono">{server.maxPlayers}</span>
                      <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden max-w-[60px]">
                        <div
                          className={`h-full rounded-full transition-all ${
                            fillPct > 90 ? "bg-red-500/60" : fillPct > 70 ? "bg-amber-500/60" : "bg-emerald-500/60"
                          }`}
                          style={{ width: `${fillPct}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="py-1.5 px-3 text-[11px] text-zinc-400 font-mono">
                    {server.ping != null ? `${server.ping}ms` : "\u2014"}
                  </td>
                  <td className="py-1.5 px-3 text-[11px] text-zinc-400 font-mono">
                    {server.fps > 0 ? server.fps.toFixed(0) : "\u2014"}
                  </td>
                  <td className="py-1.5 px-3 text-[11px] text-zinc-500">
                    {regionData ? (
                      <span className={regionData.loading ? "animate-pulse" : ""}>
                        {regionData.region}
                      </span>
                    ) : (
                      <span className="text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity">
                        {t("right-click")} {"\u2192"} {t("load")}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && (
          <div className="flex items-center justify-center py-4 gap-2">
            <div className="w-3 h-3 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[11px] text-zinc-500">
              {t("Loading servers... ({{count}} found)", { count: servers.length })}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-3 border-t border-zinc-800/40 mt-3">
        <div className="flex items-center gap-2 flex-1">
          <label className="text-[10px] text-zinc-600 shrink-0 uppercase tracking-wider">{t("Teleport")}</label>
          <input
            value={teleportPlaceId}
            onChange={(e) => setTeleportPlaceId(e.target.value.replace(/\D/g, ""))}
            placeholder={t("Teleport Place ID")}
            className="flex-1 sidebar-input font-mono text-xs"
          />
        </div>
        <div className="w-px h-6 bg-zinc-800" />
        <div className="flex items-center gap-2 flex-1">
          <input
            value={findUsername}
            onChange={(e) => setFindUsername(e.target.value)}
            placeholder={t("Find player...")}
            className="flex-1 sidebar-input text-xs"
            onKeyDown={(e) => e.key === "Enter" && !finding && findPlayer()}
          />
          <button
            onClick={findPlayer}
            disabled={finding || loading}
            className="px-3 py-[6px] bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/60 rounded-lg text-[12px] text-zinc-300 font-medium transition-colors disabled:opacity-50 shrink-0"
          >
            {finding ? (
              <span className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 border-[1.5px] border-zinc-400 border-t-transparent rounded-full animate-spin" />
                {t("Page {{page}}", { page: findProgress })}
              </span>
            ) : (
              t("Find")
            )}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2">
        <span className="text-[10px] text-zinc-600">
          {servers.length === 1
            ? t("{{count}} server", { count: servers.length })
            : t("{{count}} servers", { count: servers.length })}
          {servers.length > 0 &&
            ` \u00b7 ${servers.reduce((s, sv) => s + sv.playing, 0).toLocaleString()} ${t("players")}`}
        </span>
      </div>

      {contextMenu && (
        <ServerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          server={contextMenu.server}
          onClose={() => setContextMenu(null)}
          onJoin={() => onJoinServer(contextMenu.server.accessCode ? `VIP:${contextMenu.server.accessCode}` : contextMenu.server.id)}
          onCopyJobId={() => {
            navigator.clipboard.writeText(contextMenu.server.id);
            addToast(t("Copied Job ID"));
          }}
          onLoadRegion={() => loadRegion(contextMenu.server)}
        />
      )}
    </div>
  );
}
