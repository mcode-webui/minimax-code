/**
 * Persist the "no project needed" choice across sessions.
 *
 * The WebUI composer exposes a `createSessionWorkspaceDir` value that the
 * runtime uses as the new session's working directory. The picker lets the
 * user explicitly clear that choice — selecting "不需要项目" — and we want
 * the cleared state to stick across page reloads, new sessions, and
 * selected-session changes. Without persistence the auto-fill effect in
 * `WebuiClientFoundationApp` would immediately pull the first session's
 * workspace back, defeating the user's explicit choice.
 *
 * The desktop counterpart (`eG` in `project-selector`) similarly clears
 * `localStorage` so the cleared state survives the session lifecycle.
 */

export function isNoProjectFlag(value: unknown): boolean {
  return value === "true";
}
