// The composer's field transition matrix.
//
// One application-owned controller coordinates the existing store's complete
// field transition matrix. The store owns the canonical fields (draft, history,
// staging, queue mirror, modes, retry record, mention range); the controller
// owns named transition behavior. This file establishes store persistence
// and generation invariants. Assembled controller transitions are exercised
// in `webui-application-commands.test.ts`.
//
// Every case is named after the transition event it covers: selection, home
// adoption, hide/remount, an accepted submit, a successful submit, a failed
// submit, and disposal. Where a transition has no store command of its own
// (hide/remount), the case pins what actually carries the fields across it — the
// injected persistence — instead of asserting an API that does not exist.

import { describe, expect, it } from "vitest";

import {
  parseWebuiComposerPersisted,
  serializeWebuiComposerPersisted,
  type WebuiComposerPersisted,
} from "../../src/client/features/composer/application/composer-history.js";
import {
  createWebuiComposerStore,
  type WebuiComposerPersistence,
} from "../../src/client/features/composer/application/composer-store.js";

/**
 * The browser's composer persistence, in memory. `loadComposer` parses what the
 * last `saveComposer` wrote, so a second store built over the same storage sees
 * exactly what a remounted view would.
 */
function fakeStorage(): WebuiComposerPersistence & { readonly raw: () => string } {
  let raw = "";
  return {
    loadComposer: <T,>(parse: (value: string | null | undefined) => T): T => parse(raw || null),
    saveComposer: <T,>(
      state: T,
      serialize: (value: T, keepKeys?: readonly string[]) => string,
      keepKeys?: readonly string[],
    ): void => {
      raw = serialize(state, keepKeys);
    },
    raw: () => raw,
  };
}

const HOME = "home";
const SESSION = "session-1";
const OTHER = "session-2";

describe("the composer's field transition matrix", () => {
  it("selection: each slot keeps its own draft and history", () => {
    const store = createWebuiComposerStore();
    store.setDraft(SESSION, "for the session");
    store.setDraft(OTHER, "for the other");
    store.recordInput(SESSION, "sent in the session");
    expect(store.readDraft(SESSION)).toBe("for the session");
    expect(store.readDraft(OTHER)).toBe("for the other");
    expect(store.readDraft(HOME)).toBe("");
    expect(store.readHistory(SESSION)).toEqual(["sent in the session"]);
    expect(store.readHistory(OTHER)).toEqual([]);
  });

  it("home adoption: the home slot's draft and history move to the created session", () => {
    const store = createWebuiComposerStore();
    store.setDraft(HOME, "typed before the session existed");
    store.recordInput(HOME, "an earlier home submission");
    store.adoptHome(SESSION);
    expect(store.readDraft(SESSION)).toBe("typed before the session existed");
    expect(store.readHistory(SESSION)).toEqual(["an earlier home submission"]);
    expect(store.readDraft(HOME)).toBe("");
    expect(store.readHistory(HOME)).toEqual([]);
  });

  it("hide/remount: the injected persistence carries the slots across the view", () => {
    const storage = fakeStorage();
    const first = createWebuiComposerStore({ storage });
    first.setDraft(SESSION, "half a thought");
    first.recordInput(SESSION, "an earlier submission");
    expect(storage.raw()).not.toBe("");

    const remounted = createWebuiComposerStore({ storage });
    expect(remounted.readDraft(SESSION)).toBe("half a thought");
    expect(remounted.readHistory(SESSION)).toEqual(["an earlier submission"]);
  });

  it("accepted submit: recording the input and clearing the draft are two commands", () => {
    const store = createWebuiComposerStore();
    store.setDraft(SESSION, "do the thing");
    store.recordInput(SESSION, "do the thing");
    store.setDraft(SESSION, "");
    expect(store.readDraft(SESSION)).toBe("");
    expect(store.readHistory(SESSION)).toEqual(["do the thing"]);
  });

  it("failed submit: the draft stays and the retry record is what records the failure", () => {
    const store = createWebuiComposerStore();
    store.setDraft(SESSION, "do the thing");
    // The failure path writes the retry record (and its message) and nothing
    // else: the matrix's rule is that a refusal never clears the input.
    store.setRetry({ session: SESSION, message: { id: "m1", content: "do the thing" } } as never);
    expect(store.readDraft(SESSION)).toBe("do the thing");
    expect(store.readHistory(SESSION)).toEqual([]);
    expect(store.readRetry()).toEqual({ session: SESSION, message: { id: "m1", content: "do the thing" } });
  });

  it("disposal: purging one slot leaves every other slot alone", () => {
    const store = createWebuiComposerStore();
    store.setDraft(SESSION, "goes away");
    store.recordInput(SESSION, "goes away too");
    store.setDraft(OTHER, "stays");
    store.purgeSlot(SESSION);
    expect(store.readDraft(SESSION)).toBe("");
    expect(store.readHistory(SESSION)).toEqual([]);
    expect(store.readDraft(OTHER)).toBe("stays");
  });

  it("live fields: a store patch keeps the half it did not name", () => {
    const store = createWebuiComposerStore();
    store.setStaging({ attachments: [{ token: "a1" } as never] });
    store.setStaging({ busy: true });
    expect(store.readStaging().attachments).toHaveLength(1);
    expect(store.readStaging().busy).toBe(true);

    store.setQueue({ items: [{ itemId: "q1" } as never] });
    store.setQueue({ paused: true });
    expect(store.readQueue().items).toHaveLength(1);
    expect(store.readQueue().paused).toBe(true);

    store.setModes({ plan: true });
    store.setModes({ goal: true });
    // The store preserves unnamed fields; the application controller's named
    // setGoalMode command enforces mutual exclusion.
    expect(store.readModes()).toMatchObject({ plan: true, goal: true });

    store.setMentionRange({ start: 1, end: 4 } as never);
    expect(store.readMentionRange()).toEqual({ start: 1, end: 4 });
    store.setMentionRange(undefined);
    expect(store.readMentionRange()).toBeUndefined();
  });

  it("one snapshot per change: the identity a subscriber compares stays stable", () => {
    const store = createWebuiComposerStore();
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.setDraft(SESSION, "changed");
    expect(store.getSnapshot()).not.toBe(before);
    const after = store.getSnapshot();
    expect(store.getSnapshot()).toBe(after);
  });

  // The selected queue destination is fenced on its own, so an
  // answer that arrives for an earlier selection cannot commit to the new one,
  // and leaving for home does not wipe the mirror.
  it("queue fence: a live claim applies and says so", () => {
    const store = createWebuiComposerStore();
    const generation = store.claimQueueDestination(SESSION);
    expect(store.readQueueDestination()).toBe(SESSION);
    expect(
      store.applyQueueRead(SESSION, generation, {
        items: [{ itemId: "q1" } as never],
        paused: false,
      }),
    ).toBe(true);
    expect(store.readQueue().items).toHaveLength(1);
  });

  it("queue fence: an answer for an earlier selection does not commit", () => {
    const store = createWebuiComposerStore();
    const stale = store.claimQueueDestination(SESSION);
    // The selection moves on before the read answers.
    store.claimQueueDestination(OTHER);
    expect(
      store.applyQueueRead(SESSION, stale, {
        items: [{ itemId: "q1" } as never],
        paused: false,
      }),
    ).toBe(false);
    expect(store.readQueue().items).toEqual([]);
  });

  it("queue fence: reselecting the same session invalidates the earlier read too", () => {
    const store = createWebuiComposerStore();
    const first = store.claimQueueDestination(SESSION);
    const second = store.claimQueueDestination(SESSION);
    expect(second).not.toBe(first);
    expect(
      store.applyQueueRead(SESSION, first, {
        items: [{ itemId: "q1" } as never],
        paused: false,
      }),
    ).toBe(false);
    expect(
      store.applyQueueRead(SESSION, second, {
        items: [{ itemId: "q2" } as never],
        paused: true,
      }),
    ).toBe(true);
    expect(store.readQueue().items).toHaveLength(1);
    expect(store.readQueue().paused).toBe(true);
  });

  it("queue fence: leaving for home keeps the mirror rather than clearing it", () => {
    const store = createWebuiComposerStore();
    const generation = store.claimQueueDestination(SESSION);
    expect(
      store.applyQueueRead(SESSION, generation, {
        items: [{ itemId: "q1" } as never],
        paused: false,
      }),
    ).toBe(true);
    // Home claims nothing: the mirror keeps what the selected session left.
    expect(store.readQueueDestination()).toBe(SESSION);
    expect(store.readQueue().items).toHaveLength(1);
  });

  it("seeds without a second load: the initial value wins over persistence", () => {
    const storage = fakeStorage();
    createWebuiComposerStore({ storage }).setDraft(SESSION, "from storage");
    const seeded: WebuiComposerPersisted = { drafts: { [SESSION]: "from the seed" }, history: {} };
    const store = createWebuiComposerStore({ storage, initial: seeded });
    expect(store.readDraft(SESSION)).toBe("from the seed");
    expect(parseWebuiComposerPersisted(serializeWebuiComposerPersisted(seeded))).toEqual(seeded);
  });
});
