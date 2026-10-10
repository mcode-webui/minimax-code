import type { ReactNode } from "react";
import type { WebuiClientSession } from "../contracts/session-view.js";
import type { WebuiBrowserStorage } from "../infrastructure/storage.js";

export const WEBUI_SESSION_OVERLAY_KEYS = {
  stars: "mavis-webui-session-stars:v1",
  pins: "mavis-webui-session-pins:v1",
  archives: "mavis-webui-session-archives:v1",
} as const;

export const WEBUI_PROJECT_OVERLAY_KEYS = {
  pins: "mavis-webui-project-pins:v1",
  names: "mavis-webui-project-names:v1",
} as const;

export type WebuiSessionOverlay = "stars" | "pins" | "archives";

export function readSessionOverlay(kind: WebuiSessionOverlay, storage: WebuiBrowserStorage): Record<string, boolean> {
  try {
    const value = JSON.parse(storage.getItem(WEBUI_SESSION_OVERLAY_KEYS[kind]) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function toggleSessionOverlay(kind: WebuiSessionOverlay, sessionId: string, storage: WebuiBrowserStorage): Record<string, boolean> {
  const next = readSessionOverlay(kind, storage);
  if (next[sessionId]) delete next[sessionId]; else next[sessionId] = true;
  storage.setItem(WEBUI_SESSION_OVERLAY_KEYS[kind], JSON.stringify(next));
  return next;
}

export function readProjectPins(storage: WebuiBrowserStorage): Record<string, boolean> {
  try {
    const value = JSON.parse(storage.getItem(WEBUI_PROJECT_OVERLAY_KEYS.pins) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function toggleProjectPin(projectKey: string, storage: WebuiBrowserStorage): Record<string, boolean> {
  const next = readProjectPins(storage);
  if (next[projectKey]) delete next[projectKey]; else next[projectKey] = true;
  storage.setItem(WEBUI_PROJECT_OVERLAY_KEYS.pins, JSON.stringify(next));
  return next;
}

export function readProjectNames(storage: WebuiBrowserStorage): Record<string, string> {
  try {
    const value = JSON.parse(storage.getItem(WEBUI_PROJECT_OVERLAY_KEYS.names) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

export function writeProjectName(projectKey: string, name: string, storage: WebuiBrowserStorage): Record<string, string> {
  const next = readProjectNames(storage);
  next[projectKey] = name;
  storage.setItem(WEBUI_PROJECT_OVERLAY_KEYS.names, JSON.stringify(next));
  return next;
}

const DESKTOP_ONLY_ENTRIES = ["Schedules", "Plugins / Skill marketplace", "Websites", "Remote control", "Maxclaw", "Maxhermes"];

export function LeftRail({ sessions, activeSessionId, onSelect, onNew, children }: {
  readonly sessions: readonly WebuiClientSession[];
  readonly activeSessionId?: string;
  readonly onSelect?: (id: string) => void;
  readonly onNew?: () => void;
  readonly children?: ReactNode;
}) {
  if (children)
    return <div data-webui-component="left-rail" className="contents">{children}</div>;
  return <div className="flex min-h-0 flex-1 flex-col gap-spacing_16">
    <button className="webui-button-primary" onClick={onNew}>New session</button>
    <nav className="grid gap-1" aria-label="Desktop navigation">
      {DESKTOP_ONLY_ENTRIES.map((entry) => <button key={entry} type="button" disabled title="Desktop only" className="webui-nav-item cursor-not-allowed text-left text-text_default_tertiary opacity-60">{entry}<span className="sr-only">Desktop only</span></button>)}
      <button type="button" className="webui-nav-item text-left">Local workspaces</button>
    </nav>
    <div className="min-h-0 flex-1 overflow-auto">
      {sessions.map((session) => <button key={session.sessionId} className="webui-session-card" data-webui-session-active={session.sessionId === activeSessionId} onClick={() => onSelect?.(session.sessionId)}>{session.title ?? session.agentName}</button>)}
    </div>
  </div>;
}
