// Composer input history + cross-session draft store (roadmap Module B:
// 输入历史/草稿). Pure decision functions plus a localStorage-backed
// persisted state, mirroring the conventions of `no-project.ts` (best-effort
// persistence that degrades silently when storage is unavailable).
//
// The recall semantics follow the terminal readline convention codex uses:
// every committed submission lands in a per-session list (newest last), ↑
// walks older entries, ↓ walks back, and stepping past the newest restores
// the draft as it was before the browse started. All decisions live here so
// the React wiring in `SessionComposer` stays a thin adapter.

/** Per-session input history + drafts, persisted under one storage key. */
export interface WebuiComposerPersisted {
  readonly drafts: Readonly<Record<string, string>>;
  readonly history: Readonly<Record<string, readonly string[]>>;
}

export const WEBUI_COMPOSER_STATE_KEY = "webui.composer.state.v1";

/** Store slot for the home composer (no session selected yet). */
export const WEBUI_COMPOSER_HOME_KEY = "home";

/** Default per-session history cap (roadmap: ↑ recall keeps a bounded list). */
export const WEBUI_INPUT_HISTORY_LIMIT = 100;

interface WebuiComposerPersistedLimits {
  /** Maximum number of draft slots kept (default 50). */
  readonly draftSlots?: number;
  /** Maximum number of history slots kept (default 100). */
  readonly historySlots?: number;
  /** Keys that must survive a prune even when over budget. */
  readonly keepKeys?: readonly string[];
  /** Maximum UTF-8 bytes per stored string (default 64 KiB). */
  readonly maxEntryBytes?: number;
}

const DEFAULT_DRAFT_SLOTS = 50;
const DEFAULT_HISTORY_SLOTS = 100;
const DEFAULT_MAX_ENTRY_BYTES = 65_536;

const utf8Encoder = new TextEncoder();

/**
 * Truncate to at most `maxBytes` UTF-8 bytes. A JavaScript string cap is a
 * character cap — a CJK draft would persist at up to ~3× the intended budget
 * (surrogate pairs 4×) — so the limit is enforced on the encoded form. The
 * cut index never splits a surrogate pair.
 */
function capUtf8Bytes(value: string, maxBytes: number): string {
  if (utf8Encoder.encode(value).length <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Encoder.encode(value.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  const lastCodeUnit = lo > 0 ? value.charCodeAt(lo - 1) : 0;
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) lo -= 1;
  return value.slice(0, lo);
}

/**
 * Record one committed submission. Blank input is a no-op; an input identical
 * to the current newest entry collapses (consecutive dedupe only — a repeat
 * after a different entry stays, matching shell behavior); the list is capped
 * at `WEBUI_INPUT_HISTORY_LIMIT` with the oldest entry dropped.
 */
export function recordWebuiInputHistory(
  history: readonly string[],
  input: string,
): readonly string[] {
  const entry = input.trim();
  if (!entry) return [...history];
  if (history[history.length - 1] === entry) return [...history];
  const next = [...history, entry];
  return next.length > WEBUI_INPUT_HISTORY_LIMIT
    ? next.slice(next.length - WEBUI_INPUT_HISTORY_LIMIT)
    : next;
}

/** A browse session over the history: the cursor plus the draft it displaced. */
export interface WebuiHistoryBrowse {
  /** Index into the history array the draft currently shows. */
  readonly index: number;
  /** The draft as it was before ↑ first recalled, restored on exit. */
  readonly draft: string;
}

/**
 * Enter browse mode at the newest entry. Returns `undefined` when there is
 * nothing to recall so the caller can leave the caret's default behavior
 * untouched.
 */
export function startWebuiHistoryBrowse(
  history: readonly string[],
  currentDraft: string,
): WebuiHistoryBrowse | undefined {
  if (history.length === 0) return undefined;
  return { index: history.length - 1, draft: currentDraft };
}

/**
 * Step an active browse. `"prev"` moves older (clamped at the first entry —
 * leaning on ↑ must not exit and lose the browse slot); `"next"` moves newer
 * and returns `undefined` past the newest entry, which is the caller's cue to
 * exit browse mode and restore the stashed draft.
 */
export function stepWebuiHistoryBrowse(
  browse: WebuiHistoryBrowse,
  direction: "prev" | "next",
  history: readonly string[],
): WebuiHistoryBrowse | undefined {
  if (direction === "prev") {
    return { ...browse, index: Math.max(0, browse.index - 1) };
  }
  const next = browse.index + 1;
  if (next >= history.length) return undefined;
  return { ...browse, index: next };
}

/**
 * Whether ↑/↓ history recall may claim the key: the caret must sit on the
 * first line of the draft. On any later line the textarea's own caret
 * navigation (moving up into the previous line of a multi-line draft) must
 * keep working.
 */
export function shouldRecallWebuiHistory(value: string, caret: number): boolean {
  return !value.slice(0, caret).includes("\n");
}

type WebuiStorageLike = Pick<Storage, "getItem" | "setItem">;

function resolveStorage(
  storage?: WebuiStorageLike,
): WebuiStorageLike | undefined {
  if (storage) return storage;
  // localStorage can be unavailable (privacy mode, quota); fall through the
  // same way `no-project.ts` does.
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the persisted composer state. Any corruption — unparsable JSON, a
 * non-object envelope, non-string values, blank entries — degrades to an
 * empty state rather than throwing: the history is a convenience, never a
 * load-bearing dependency of the composer.
 */
export function loadWebuiComposerPersisted(
  storage?: WebuiStorageLike,
): WebuiComposerPersisted {
  const resolved = resolveStorage(storage);
  const raw = resolved?.getItem(WEBUI_COMPOSER_STATE_KEY);
  if (!raw) return { drafts: {}, history: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { drafts: {}, history: {} };
  }
  if (!isPlainObject(parsed)) return { drafts: {}, history: {} };
  const drafts: Record<string, string> = {};
  const rawDrafts = isPlainObject(parsed.drafts) ? parsed.drafts : {};
  for (const [key, value] of Object.entries(rawDrafts)) {
    if (typeof value !== "string" || !value) continue;
    const trimmedKey = key.trim();
    if (trimmedKey) drafts[trimmedKey] = value;
  }
  const history: Record<string, readonly string[]> = {};
  const rawHistory = parsed.history;
  if (isPlainObject(rawHistory)) {
    for (const [key, value] of Object.entries(rawHistory)) {
      if (!Array.isArray(value)) continue;
      const trimmedKey = key.trim();
      if (!trimmedKey) continue;
      const entries = value.filter(
        (entry): entry is string => typeof entry === "string" && !!entry,
      );
      if (entries.length > 0) history[trimmedKey] = entries;
    }
  }
  return { drafts, history };
}

/**
 * Prune the persisted state to its budgets. Slot pruning keeps the most
 * recently *inserted* keys (JS objects preserve insertion order for
 * non-numeric keys, and session keys are never numeric) plus the caller's
 * `keepKeys` — an approximation of recency that avoids per-slot timestamps;
 * an active session's slot is re-created on each save, so cold slots age out
 * while live ones survive through `keepKeys`. Individual strings are capped
 * at `maxEntryLength` and each history list at the record limit.
 */
export function pruneWebuiComposerPersisted(
  state: WebuiComposerPersisted,
  limits: WebuiComposerPersistedLimits = {},
): WebuiComposerPersisted {
  const draftSlots = limits.draftSlots ?? DEFAULT_DRAFT_SLOTS;
  const historySlots = limits.historySlots ?? DEFAULT_HISTORY_SLOTS;
  const keep = new Set(limits.keepKeys ?? []);
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;

  const capSlotKeys = (keys: readonly string[], slots: number): Set<string> => {
    // Keep the LAST `slots` keys in insertion order — the newest slots — and
    // let `keepKeys` ride on top even when that briefly exceeds the budget:
    // an active session losing its draft to its own prune would be worse,
    // which is why the shell always passes the live session key.
    const surviving = new Set(keys.slice(-slots));
    for (const key of keep) surviving.add(key);
    return surviving;
  };

  const draftKeys = capSlotKeys(Object.keys(state.drafts), draftSlots);
  const historyKeys = capSlotKeys(Object.keys(state.history), historySlots);

  const drafts: Record<string, string> = {};
  for (const key of Object.keys(state.drafts)) {
    if (!draftKeys.has(key)) continue;
    const value = state.drafts[key]!;
    if (!value) continue;
    drafts[key] = capUtf8Bytes(value, maxEntryBytes);
  }
  const history: Record<string, readonly string[]> = {};
  for (const key of Object.keys(state.history)) {
    if (!historyKeys.has(key)) continue;
    const entries = state.history[key]!;
    const capped = entries
      .filter((entry) => !!entry)
      .map((entry) => capUtf8Bytes(entry, maxEntryBytes));
    if (capped.length > 0) {
      history[key] = capped.slice(-WEBUI_INPUT_HISTORY_LIMIT);
    }
  }
  return { drafts, history };
}

/**
 * Move the home slot's history and draft onto a freshly created session's
 * key. The home slot is where a first submission is recorded (no session
 * exists yet when the composer commits); once the silent session creation
 * lands, the entry belongs to that session. Returns the same object when
 * the home slot is empty.
 */
export function migrateWebuiHomeComposerState(
  state: WebuiComposerPersisted,
  targetKey: string,
): WebuiComposerPersisted {
  const homeHistory = state.history[WEBUI_COMPOSER_HOME_KEY];
  const homeDraft = state.drafts[WEBUI_COMPOSER_HOME_KEY];
  if (!homeHistory && homeDraft === undefined) return state;
  const history = { ...state.history };
  const drafts = { ...state.drafts };
  if (homeHistory) {
    history[targetKey] = [...(history[targetKey] ?? []), ...homeHistory].slice(
      -WEBUI_INPUT_HISTORY_LIMIT,
    );
    delete history[WEBUI_COMPOSER_HOME_KEY];
  }
  if (homeDraft !== undefined) {
    drafts[targetKey] = homeDraft;
    delete drafts[WEBUI_COMPOSER_HOME_KEY];
  }
  return { ...state, drafts, history };
}

/**
 * Persist the composer state after pruning. `keepKeys` names slots that must
 * survive the prune — the shell passes the live session key, because the
 * insertion-order approximation alone cannot tell an active session from a
 * cold one. Quota or availability failures are swallowed: the in-memory
 * state keeps working and the next successful save recovers.
 */
export function saveWebuiComposerPersisted(
  state: WebuiComposerPersisted,
  storage?: WebuiStorageLike,
  keepKeys?: readonly string[],
): void {
  const resolved = resolveStorage(storage);
  if (!resolved) return;
  try {
    resolved.setItem(
      WEBUI_COMPOSER_STATE_KEY,
      JSON.stringify(
        pruneWebuiComposerPersisted(
          state,
          keepKeys ? { keepKeys } : {},
        ),
      ),
    );
  } catch {
    // Best-effort persistence — see `no-project.ts` for the convention.
  }
}
