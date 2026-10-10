// The application composer store (plan §7.1 `application/composer-store.ts`;
// §7.6 "Draft"; ticket #49 criterion 5).
//
// The composer's per-session drafts and input history used to live in the
// shell's own `useState`, with a hand-written updater that read the current
// key off a ref, persisted and pruned. That is one owner too many: the draft is
// application state — it survives a session switch and a silent home→session
// creation — so it belongs beside the session store, not inside the React tree.
//
// This store is that owner. It holds the one `WebuiComposerPersisted` value,
// persists it through the existing `composer-history` rules (same key, same
// prune, same byte caps) and notifies subscribers. The shell subscribes and
// submits named changes; it holds no `setState` and no updater for it.
//
// `adoptHome` is the composer half of home→session adoption. The session half
// lives on the session store (`migrateSession`); the composition root runs both
// in one committed transition (`create-application.ts`).

import {
  migrateWebuiHomeComposerState,
  parseWebuiComposerPersisted,
  recordWebuiInputHistory,
  serializeWebuiComposerPersisted,
  type WebuiComposerPersisted,
} from "../projection/composer-history.js";

export interface WebuiComposerPersistence {
  readonly loadComposer: <T>(parse: (raw: string | null | undefined) => T) => T;
  readonly saveComposer: <T>(state: T, serialize: (state: T, keepKeys?: readonly string[]) => string, keepKeys?: readonly string[]) => void;
}

export interface WebuiComposerStore {
  /** The current persisted state; stable until something changes. */
  readonly getSnapshot: () => WebuiComposerPersisted;
  /** Subscribe to changes. Returns a detach. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The draft text for one slot, or the empty string. */
  readonly readDraft: (key: string) => string;
  /** The input history for one slot, newest last. */
  readonly readHistory: (key: string) => readonly string[];
  /**
   * Set or clear one slot's draft, persisting and keeping the slot alive
   * through the prune.
   */
  readonly setDraft: (key: string, draft: string) => void;
  /** Record one committed submission into a slot's history. */
  readonly recordInput: (key: string, text: string) => void;
  /**
   * Move the home slot's draft and history onto a freshly created session key.
   * The composer half of home→session adoption.
   */
  readonly adoptHome: (targetKey: string) => void;
  /**
   * Drop both the draft and the input history for one slot. Called by the
   * session workflow after a successful delete, so a removed session does not
   * re-emerge with a stale draft or replay history.
   */
  readonly purgeSlot: (key: string) => void;
}

export function createWebuiComposerStore(options?: {
  /** Seed for SSR / tests; never a second load of storage. */
  readonly initial?: WebuiComposerPersisted;
  /** Persistence is injected by the browser composition root. */
  readonly storage?: WebuiComposerPersistence;
}): WebuiComposerStore {
  let state = options?.initial ?? options?.storage?.loadComposer(parseWebuiComposerPersisted) ?? { drafts: {}, history: {} };
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        try {
          // eslint-disable-next-line no-console
          console.error("[webui] composer listener threw:", error);
        } catch {
          // console.error can throw in extreme environments; give up.
        }
      }
    }
  };

  const apply = (
    update: (current: WebuiComposerPersisted) => WebuiComposerPersisted,
    keepKeys?: readonly string[],
  ): void => {
    const next = update(state);
    if (next === state) return;
    state = next;
    options?.storage?.saveComposer(state, serializeWebuiComposerPersisted, keepKeys);
    notify();
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readDraft: (key) => state.drafts[key] ?? "",
    readHistory: (key) => state.history[key] ?? [],
    setDraft: (key, draft) => {
      apply((current) => {
        const drafts = { ...current.drafts };
        if (draft) drafts[key] = draft;
        else delete drafts[key];
        return { ...current, drafts };
      }, [key]);
    },
    recordInput: (key, text) => {
      apply((current) => {
        const history = {
          ...current.history,
          [key]: recordWebuiInputHistory(current.history[key] ?? [], text),
        };
        return { ...current, history };
      }, [key]);
    },
    adoptHome: (targetKey) => {
      apply((current) => migrateWebuiHomeComposerState(current, targetKey), [targetKey]);
    },
    purgeSlot: (key) => {
      apply((current) => {
        // Read the slots *before* deleting: an absent slot must leave the
        // snapshot — and therefore every subscriber — untouched.
        const hasDraft = Object.prototype.hasOwnProperty.call(current.drafts, key);
        const hasHistory = Object.prototype.hasOwnProperty.call(current.history, key);
        if (!hasDraft && !hasHistory) return current;
        const drafts = { ...current.drafts };
        delete drafts[key];
        const history = { ...current.history };
        delete history[key];
        // No keep key: the slot is gone, so there is nothing to protect from
        // the prune.
        return { ...current, drafts, history };
      });
    },
  };
}
