/**
 * Persist per-session unread turn counts across reloads.
 *
 * Without this a badge is worse than no badge: a session that finished four
 * turns while the tab was open would go back to a clean row the moment the page
 * reloaded, and the user's only conclusion would be that it never ran.
 *
 * What is *not* here, deliberately: any attempt to reconstruct counts for work
 * that finished while the client was closed. That needs a server-side
 * "last read at" per session, which the runtime does not carry, and guessing
 * from `updatedAt` would badge every session the moment anyone opened the page.
 * The counts describe what this client observed, which is the only thing it can
 * honestly claim.
 *
 * The shape follows `no-project.ts`: every access is wrapped, storage may be
 * absent (SSR, private mode) or throw on quota, and a failure degrades to "no
 * counts" rather than taking the rail down with it.
 */

export const SESSION_UNREAD_STORAGE_KEY = "mavis-session-unread";

/** Above this the badge says "99+" -- a 4-digit pill has nowhere to go. */
export const SESSION_UNREAD_BADGE_MAX = 99;

function browserStorage(): Storage | undefined {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export function readWebuiUnreadCounts(
  storage: Storage | undefined = browserStorage(),
): Record<string, number> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SESSION_UNREAD_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const counts: Record<string, number> = {};
    for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      // A stored value is only a count if it is a finite non-negative integer.
      // Anything else -- an object, a string, a negative, a float -- is dropped
      // rather than coerced, because `unread: NaN` would render a row that
      // claims to be waiting on nothing.
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        counts[sessionId] = value;
      }
    }
    return counts;
  } catch {
    return {};
  }
}

export function writeWebuiUnreadCounts(
  counts: Readonly<Record<string, number>>,
  storage: Storage | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    const entries = Object.entries(counts).filter(([, count]) => count > 0);
    if (entries.length === 0) storage.removeItem(SESSION_UNREAD_STORAGE_KEY);
    else storage.setItem(SESSION_UNREAD_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage unavailable or over quota; the in-memory count still shows.
  }
}

/** The number to draw. `0` and `undefined` both render as no badge at all. */
export function formatWebuiUnreadBadge(count: number | undefined): string {
  if (!count || count <= 0) return "";
  return count > SESSION_UNREAD_BADGE_MAX ? `${SESSION_UNREAD_BADGE_MAX}+` : String(count);
}
