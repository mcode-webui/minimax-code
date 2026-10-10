// Browser storage IO (plan §7.2 `client/infrastructure/storage.ts`; ticket #49
// criterion 6).
//
// The browser persistence half of the former `client/session-unread.ts`: the
// storage key, the read that validates every stored value, and the write that
// keeps only positive counts. It decides no unread business rule — the badge
// format lives in `projection/unread-badge.ts` and the ordering lives with the
// commands that call this module — it only reads and writes what it is given.
//
// Every access is wrapped: storage may be absent (SSR, private mode) or throw
// on quota, and a failure degrades to "no counts" rather than taking the rail
// down with it.

export const SESSION_UNREAD_STORAGE_KEY = "mavis-session-unread";

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
