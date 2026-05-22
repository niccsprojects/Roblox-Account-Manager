import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Info, X } from "lucide-react";
import { useStore } from "../../store";
import { useModalClose } from "../../hooks/useModalClose";
import { useTr } from "../../i18n/text";
import { getUpdaterSkipVersionKey } from "../../updaterChannels";

type Phase = "available" | "downloading" | "ready" | "installing" | "error";

function renderMarkdown(src: string): React.ReactNode[] {
  const lines = src.split(/\r?\n/);
  const htmlTag = /<[a-z][^>]*>/i;
  const repoBaseUrl = "https://github.com/niccsprojects/Roblox-Account-Manager";
  const nodes: React.ReactNode[] = [];
  let key = 0;

  function unescapeMarkdown(text: string): string {
    return text.replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1");
  }

  function trimUrlToken(value: string): { href: string; suffix: string } {
    let href = value;
    let suffix = "";

    while (href.length > 0) {
      const last = href[href.length - 1];
      if (!/[),.;!?]/.test(last)) break;
      if (last === ")") {
        const openCount = (href.match(/\(/g) || []).length;
        const closeCount = (href.match(/\)/g) || []).length;
        if (closeCount <= openCount) break;
      }
      suffix = last + suffix;
      href = href.slice(0, -1);
    }

    return { href, suffix };
  }

  function renderLink(href: string, label?: string): React.ReactNode {
    return (
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-sky-300 hover:text-sky-200 underline decoration-sky-500/50 underline-offset-2 [overflow-wrap:anywhere]"
      >
        {label ?? href}
      </a>
    );
  }

  function inlinePass(text: string): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|<((?:https?:\/\/)[^>\s]+)>|(https?:\/\/[^\s<]+)|(@[a-zA-Z0-9-]{1,39})|#(\d+)/g;
    let match: RegExpExecArray | null;

    const appendText = (value: string) => {
      const plain = unescapeMarkdown(value);
      if (plain) parts.push(plain);
    };

    while ((match = re.exec(text)) !== null) {
      if (match.index > cursor) appendText(text.slice(cursor, match.index));

      if (match[1]) {
        parts.push(
          <code key={key++} className="font-mono text-[11px] px-1 py-0.5 rounded bg-black/30 border border-white/10 text-zinc-200">
            {match[1]}
          </code>
        );
      } else if (match[2] || match[3]) {
        const value = match[2] || match[3] || "";
        parts.push(<strong key={key++} className="font-semibold text-[var(--panel-fg)]">{value}</strong>);
      } else if (match[4] || match[5]) {
        const value = match[4] || match[5] || "";
        parts.push(<em key={key++} className="italic text-[var(--panel-fg)]/95">{value}</em>);
      } else if (match[6] && match[7]) {
        parts.push(renderLink(match[7], match[6]));
      } else if (match[8]) {
        parts.push(renderLink(match[8]));
      } else if (match[9]) {
        const { href, suffix } = trimUrlToken(match[9]);
        if (href) parts.push(renderLink(href));
        if (suffix) parts.push(suffix);
      } else if (match[10]) {
        const login = match[10].slice(1);
        parts.push(renderLink(`https://github.com/${login}`, match[10]));
      } else if (match[11]) {
        parts.push(renderLink(`${repoBaseUrl}/pull/${match[11]}`, `#${match[11]}`));
      }

      cursor = match.index + match[0].length;
    }

    if (cursor < text.length) appendText(text.slice(cursor));
    return parts;
  }

  function extractAvatarAnchors(line: string): Array<{ href: string; src: string; alt: string }> {
    const anchors = line.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi);
    if (!anchors) return [];
    const items: Array<{ href: string; src: string; alt: string }> = [];

    for (const anchor of anchors) {
      const hrefMatch = anchor.match(/href=(["'])(.*?)\1/i);
      const imgTagMatch = anchor.match(/<img\b[^>]*>/i);
      if (!hrefMatch || !imgTagMatch) continue;

      const srcMatch = imgTagMatch[0].match(/src=(["'])(.*?)\1/i);
      if (!srcMatch) continue;

      const altMatch = imgTagMatch[0].match(/alt=(["'])(.*?)\1/i);
      items.push({
        href: hrefMatch[2],
        src: srcMatch[2],
        alt: altMatch?.[2] || "",
      });
    }

    return items;
  }

  function isBlockStart(line: string): boolean {
    return /^\s*(`{3,}|~{3,})/.test(line)
      || /^>\s?/.test(line)
      || /^(#{1,6})\s+/.test(line)
      || /^[-*_]{3,}\s*$/.test(line)
      || /^(\s*)\\?[-*+]\s+/.test(line)
      || /^(\s*)\d+[.)]\s+/.test(line)
      || /^([A-Za-z][A-Za-z ]{1,40}):\s+/.test(line)
      || extractAvatarAnchors(line).length > 0;
  }

  for (let i = 0; i < lines.length;) {
    const line = lines[i].trimEnd();

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fenceStart = line.match(/^\s*(`{3,}|~{3,})\s*([a-zA-Z0-9_-]+)?\s*$/);
    if (fenceStart) {
      const marker = fenceStart[1];
      const lang = (fenceStart[2] || "").toLowerCase();
      const codeLines: string[] = [];
      i += 1;

      while (i < lines.length) {
        const nextLine = lines[i];
        const isFenceEnd = new RegExp(`^\\s*${marker}\\s*$`).test(nextLine);
        if (isFenceEnd) {
          i += 1;
          break;
        }
        codeLines.push(nextLine);
        i += 1;
      }

      const code = codeLines.join("\n");
      if (code.trim()) {
        nodes.push(
          <div key={key++} className="my-2 rounded-lg border theme-border bg-black/25 overflow-hidden">
            {lang ? (
              <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-zinc-400/80 border-b theme-border bg-black/20">
                {lang}
              </div>
            ) : null}
            <pre className="px-3 py-2.5 text-[11px] leading-relaxed overflow-x-auto">
              <code className="font-mono whitespace-pre text-zinc-200">{code}</code>
            </pre>
          </div>
        );
      }

      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const quoteMatch = lines[i].trimEnd().match(/^>\s?(.*)$/);
        if (!quoteMatch) break;
        quoteLines.push(quoteMatch[1]);
        i += 1;
      }

      const calloutMatch = quoteLines[0]?.match(/^\[!([A-Z]+)\]\s*$/i);
      const styleByType = {
        WARNING: {
          label: "Warning",
          wrapper: "border-amber-500/70 bg-amber-500/10",
          labelColor: "text-amber-300",
          icon: AlertTriangle,
        },
        NOTE: {
          label: "Note",
          wrapper: "border-sky-500/60 bg-sky-500/10",
          labelColor: "text-sky-300",
          icon: Info,
        },
      } as const;

      let type = "";
      let contentLines = quoteLines;
      if (calloutMatch) {
        type = calloutMatch[1].toUpperCase();
        contentLines = quoteLines.slice(1);
      }

      while (contentLines.length > 0 && !contentLines[0].trim()) {
        contentLines.shift();
      }
      while (contentLines.length > 0 && !contentLines[contentLines.length - 1].trim()) {
        contentLines.pop();
      }

      let paragraphs = contentLines
        .join("\n")
        .split(/\n{2,}/)
        .map((part) => part.split("\n").map((entry) => entry.trim()).join(" ").trim())
        .filter(Boolean);

      if (type && paragraphs.length === 0) {
        const fallbackLines: string[] = [];
        while (i < lines.length) {
          const candidate = lines[i].trimEnd();
          if (!candidate.trim()) break;
          if (isBlockStart(candidate)) break;
          if (htmlTag.test(candidate)) break;
          fallbackLines.push(candidate.trim());
          i += 1;
        }
        if (fallbackLines.length > 0) {
          paragraphs = [fallbackLines.join(" ")];
        }
      }

      if (type && type in styleByType) {
        const style = styleByType[type as keyof typeof styleByType];
        const Icon = style.icon;
        nodes.push(
          <div key={key++} className={`my-2 rounded-md border-l-2 px-3 py-2 ${style.wrapper}`}>
            <div className={`flex items-center gap-1.5 text-[11px] font-semibold ${style.labelColor}`}>
              <Icon size={13} strokeWidth={2.1} />
              <span>{style.label}</span>
            </div>
            <div className="mt-1.5 space-y-1.5 text-[12px] text-[var(--panel-fg)]/95">
              {paragraphs.map((paragraph) => (
                <p key={key++}>{inlinePass(paragraph)}</p>
              ))}
            </div>
          </div>
        );
      } else if (paragraphs.length > 0) {
        nodes.push(
          <blockquote key={key++} className="my-2 border-l-2 border-[var(--border-color)]/80 pl-3 text-[var(--panel-fg)]/90 space-y-1.5">
            {paragraphs.map((paragraph) => (
              <p key={key++}>{inlinePass(paragraph)}</p>
            ))}
          </blockquote>
        );
      }

      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const headingClass = level === 1
        ? "text-[15px] mt-3 mb-2"
        : level === 2
          ? "text-[14px] mt-3 mb-2 pb-1 border-b border-[var(--border-color)]/75"
          : "text-[12.5px] mt-2.5 mb-1.5";

      nodes.push(
        <div key={key++} className={`${headingClass} font-semibold text-[var(--panel-fg)]`}>
          {inlinePass(text)}
        </div>
      );
      i += 1;
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line)) {
      nodes.push(<div key={key++} className="h-px bg-[var(--border-color)]/70 my-2" />);
      i += 1;
      continue;
    }

    const unorderedMatch = line.match(/^(\s*)\\?[-*+]\s+(.+)$/);
    if (unorderedMatch) {
      const items: Array<{ indent: number; text: string }> = [];

      while (i < lines.length) {
        const match = lines[i].trimEnd().match(/^(\s*)\\?[-*+]\s+(.+)$/);
        if (!match) break;
        const indent = Math.min(4, Math.floor(match[1].replace(/\t/g, "  ").length / 2));
        const task = match[2].match(/^\[( |x|X)\]\s+(.+)$/);
        items.push({
          indent,
          text: task ? task[2] : match[2],
        });
        i += 1;
      }

      nodes.push(
        <ul key={key++} className="my-1.5 ml-4 space-y-1 list-disc marker:text-zinc-300/90">
          {items.map((item) => (
            <li key={key++} style={{ marginLeft: `${item.indent * 10}px` }} className="pl-0.5">
              {inlinePass(item.text)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    const orderedMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (orderedMatch) {
      const items: Array<{ indent: number; text: string }> = [];

      while (i < lines.length) {
        const match = lines[i].trimEnd().match(/^(\s*)(\d+)[.)]\s+(.+)$/);
        if (!match) break;
        const indent = Math.min(4, Math.floor(match[1].replace(/\t/g, "  ").length / 2));
        items.push({ indent, text: match[3] });
        i += 1;
      }

      nodes.push(
        <ol key={key++} className="my-1.5 ml-4 space-y-1 list-decimal marker:text-zinc-300/90">
          {items.map((item) => (
            <li key={key++} style={{ marginLeft: `${item.indent * 10}px` }} className="pl-0.5">
              {inlinePass(item.text)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    const metadataLine = line.match(/^([A-Za-z][A-Za-z ]{1,40}):\s+(.+)$/);
    if (metadataLine) {
      const label = metadataLine[1].trim();
      const value = metadataLine[2].trim();
      const normalizedLabel = label.toLowerCase();
      const shaLike = /^[0-9a-f]{6,40}$/i.test(value);

      let valueNode: React.ReactNode = inlinePass(value);
      if (normalizedLabel === "release commit" && shaLike) {
        valueNode = (
          <code className="font-mono text-[11px] px-1 py-0.5 rounded bg-black/30 border border-white/10 text-zinc-200">
            {value}
          </code>
        );
      }

      nodes.push(
        <p key={key++} className="my-1 [overflow-wrap:anywhere]">
          <span className="font-semibold text-[var(--panel-fg)]">{label}:</span>{" "}
          <span className="text-[var(--panel-fg)]/95">{valueNode}</span>
        </p>
      );
      i += 1;
      continue;
    }

    const avatarAnchors = extractAvatarAnchors(line);
    if (avatarAnchors.length > 0) {
      nodes.push(
        <div key={key++} className="my-2 flex flex-wrap gap-2">
          {avatarAnchors.map((anchor) => {
            const fallbackLabel = anchor.href.split("/").pop() || "contributor";
            const alt = anchor.alt || `@${fallbackLabel}`;
            return (
              <a
                key={key++}
                href={anchor.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex"
                title={alt}
              >
                <img
                  src={anchor.src}
                  alt={alt}
                  className="h-6 w-6 rounded-full border border-[var(--border-color)]/80"
                />
              </a>
            );
          })}
        </div>
      );
      i += 1;
      continue;
    }

    if (htmlTag.test(line)) {
      i += 1;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    i += 1;

    while (i < lines.length) {
      const nextLine = lines[i].trimEnd();
      if (!nextLine.trim()) break;
      if (isBlockStart(nextLine)) break;
      if (htmlTag.test(nextLine)) break;
      paragraph.push(nextLine.trim());
      i += 1;
    }

    const text = paragraph.join(" ").trim();
    if (text) {
      nodes.push(
        <p key={key++} className="my-1.5 [overflow-wrap:anywhere]">
          {inlinePass(text)}
        </p>
      );
    }
  }

  return nodes;
}

interface DownloadProgress {
  downloaded: number;
  total: number | null;
  speed: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toTagName(version: string): string {
  const trimmed = version.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function buildCommitMessagesSection(
  currentVersion: string,
  nextVersion: string,
  commits: Array<{ sha: string; message: string }>
): string {
  const lines = commits
    .map((commit) => {
      const sha = String(commit.sha || "").trim();
      const shortSha = sha.slice(0, 7);
      const subject = String(commit.message || "").split(/\r?\n/, 1)[0].trim();
      if (!sha || !subject) return "";
      return `- ${subject} ([${shortSha}](https://github.com/niccsprojects/Roblox-Account-Manager/commit/${sha}))`;
    })
    .filter(Boolean);

  if (lines.length === 0) return "";

  return [
    "## All Commit Messages",
    `Range: ${currentVersion}...${nextVersion}`,
    "",
    ...lines,
  ].join("\n");
}

export function UpdateDialog() {
  const t = useTr();
  const store = useStore();
  const open = store.updateDialogOpen;
  const info = store.updateInfo;
  const { visible, closing, handleClose } = useModalClose(open, () =>
    store.setUpdateDialogOpen(false)
  );

  const [phase, setPhase] = useState<Phase>("available");
  const [progress, setProgress] = useState<DownloadProgress>({ downloaded: 0, total: null, speed: 0 });
  const [errorMsg, setErrorMsg] = useState("");
  const [releaseNotes, setReleaseNotes] = useState<string | null>(null);
  const renderedNotes = useMemo(() => (releaseNotes ? renderMarkdown(releaseNotes) : null), [releaseNotes]);

  useEffect(() => {
    if (!open) {
      setPhase("available");
      setProgress({ downloaded: 0, total: null, speed: 0 });
      setErrorMsg("");
      setReleaseNotes(null);
      return;
    }

    const nextNotes = info?.body?.trim() ? info.body : null;
    setReleaseNotes(nextNotes);

    if (!info?.version || !info?.currentVersion) return;

    const releaseTag = toTagName(info.version);
    const currentTag = toTagName(info.currentVersion);

    const hasDetailedSections = !!nextNotes
      && /(^|\n)##\s+What's Changed\b/i.test(nextNotes)
      && /(^|\n)##\s+Contributors\b/i.test(nextNotes);
    const hasAllCommitMessages = !!nextNotes
      && /(^|\n)##\s+All Commit Messages\b/i.test(nextNotes);

    const controller = new AbortController();

    (async () => {
      let resolvedNotes = nextNotes || "";

      if (!hasDetailedSections) {
        try {
          const releaseResponse = await fetch(
            `https://api.github.com/repos/niccsprojects/roblox-account-manager/releases/tags/${releaseTag}`,
            {
              signal: controller.signal,
              headers: {
                Accept: "application/vnd.github+json",
              },
            }
          );

          if (releaseResponse.ok) {
            const releaseData = await releaseResponse.json();
            const remoteBody = typeof releaseData?.body === "string" ? releaseData.body.trim() : "";
            if (remoteBody) {
              resolvedNotes = remoteBody;
            }
          }
        } catch {}
      }

      if (!hasAllCommitMessages && currentTag !== releaseTag) {
        try {
          const compareResponse = await fetch(
            `https://api.github.com/repos/niccsprojects/roblox-account-manager/compare/${encodeURIComponent(currentTag)}...${encodeURIComponent(releaseTag)}`,
            {
              signal: controller.signal,
              headers: {
                Accept: "application/vnd.github+json",
              },
            }
          );

          if (compareResponse.ok) {
            const compareData = await compareResponse.json();
            const commits = Array.isArray(compareData?.commits)
              ? compareData.commits.map((entry: any) => ({
                  sha: String(entry?.sha || ""),
                  message: String(entry?.commit?.message || ""),
                }))
              : [];

            const commitSection = buildCommitMessagesSection(currentTag, releaseTag, commits);
            if (commitSection) {
              resolvedNotes = resolvedNotes.trim()
                ? `${resolvedNotes.trim()}\n\n${commitSection}`
                : commitSection;
            }
          }
        } catch {}
      }

      if (!controller.signal.aborted) {
        const finalNotes = resolvedNotes.trim();
        if (finalNotes) {
          setReleaseNotes(finalNotes);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [open, info?.body, info?.currentVersion, info?.version]);

  const startDownload = useCallback(async () => {
    setPhase("downloading");
    setProgress({ downloaded: 0, total: null, speed: 0 });

    try {
      await invoke("download_selected_update");
      setProgress({ downloaded: 1, total: 1, speed: 0 });
      setPhase("ready");
    } catch (e) {
      setPhase("error");
      setErrorMsg(String(e));
    }
  }, []);

  const installAndRestart = useCallback(async () => {
    setPhase("installing");
    try {
      await invoke("install_selected_update");
    } catch (e) {
      setPhase("error");
      setErrorMsg(String(e));
    }
  }, []);

  const skipVersion = useCallback(() => {
    if (info) {
      localStorage.setItem(
        getUpdaterSkipVersionKey(info.releaseChannel, info.featureChannel),
        info.version
      );
    }
    handleClose();
  }, [info, handleClose]);

  if (!visible || !info) return null;

  const pct = progress.total ? Math.round((progress.downloaded / progress.total) * 100) : 0;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      onClick={phase === "downloading" || phase === "installing" ? undefined : handleClose}
    >
      <div
        className={`theme-panel theme-border rounded-xl w-full max-w-lg mx-4 shadow-2xl flex flex-col ${closing ? "animate-scale-out" : "animate-scale-in"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h2 className="text-sm font-semibold text-[var(--panel-fg)]">{t("Update Available")}</h2>
          {phase !== "downloading" && phase !== "installing" && (
            <button onClick={handleClose} className="theme-muted hover:opacity-100 transition-opacity">
              <X size={16} strokeWidth={2} />
            </button>
          )}
        </div>

        <div className="px-5 pb-3">
          <div className="text-xs font-medium theme-muted mb-1.5">{t("Release Notes")}</div>
          <div className="theme-input rounded-lg px-3.5 py-3 max-h-56 overflow-y-auto text-[12px] text-[var(--panel-fg)] leading-[1.55]">
            {releaseNotes
              ? renderedNotes
              : t("Could not load release notes")}
          </div>
        </div>

        {(phase === "downloading" || phase === "ready") && (
          <div className="px-5 pb-3">
            <div className="w-full h-2 rounded-full bg-zinc-700/50 overflow-hidden">
              <div
                className="h-full rounded-full bg-sky-500 transition-all duration-300"
                style={{ width: `${progress.total ? pct : 0}%` }}
              />
            </div>
            <div className="flex justify-between mt-1.5 text-xs theme-muted">
              <span>
                {progress.total
                  ? `${pct}% — ${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
                  : formatBytes(progress.downloaded)}
              </span>
              {phase === "downloading" && progress.speed > 0 && (
                <span>{formatBytes(progress.speed)}/s</span>
              )}
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="px-5 pb-3">
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
              {errorMsg}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between px-5 pb-5 pt-2 border-t border-[var(--border-color)]">
          <div className="flex gap-2">
            {phase === "available" && (
              <>
                <button
                  onClick={skipVersion}
                  className="px-3 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
                >
                  {t("Skip This Version")}
                </button>
                <button
                  onClick={handleClose}
                  className="px-3 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 transition-colors"
                >
                  {t("Remind Me Later")}
                </button>
              </>
            )}
          </div>
          <div>
            {phase === "available" && (
              <button
                onClick={startDownload}
                className="px-4 py-1.5 rounded-md text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white transition-colors"
              >
                {t("Download Update")}
              </button>
            )}
            {phase === "downloading" && (
              <button
                disabled
                className="px-4 py-1.5 rounded-md text-xs font-medium bg-sky-600/50 text-white/60 cursor-not-allowed"
              >
                {t("Downloading update...")}
              </button>
            )}
            {phase === "ready" && (
              <button
                onClick={installAndRestart}
                className="px-4 py-1.5 rounded-md text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
              >
                {t("Install & Restart")}
              </button>
            )}
            {phase === "installing" && (
              <button
                disabled
                className="px-4 py-1.5 rounded-md text-xs font-medium bg-emerald-600/50 text-white/60 cursor-not-allowed"
              >
                {t("Installing...")}
              </button>
            )}
            {phase === "error" && (
              <button
                onClick={startDownload}
                className="px-4 py-1.5 rounded-md text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white transition-colors"
              >
                {t("Download Update")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
