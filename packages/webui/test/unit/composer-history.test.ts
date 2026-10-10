import { describe, expect, it } from "vitest";
import {
  parseWebuiComposerPersisted,
  migrateWebuiHomeComposerState,
  pruneWebuiComposerPersisted,
  recordWebuiInputHistory,
  serializeWebuiComposerPersisted,
  shouldRecallWebuiHistory,
  startWebuiHistoryBrowse,
  stepWebuiHistoryBrowse,
} from "../../src/client/projection/composer-history.js";
import type { WebuiComposerPersisted } from "../../src/client/projection/composer-history.js";
import { createWebuiComposerStore } from "../../src/client/application/composer-store.js";
import { createWebuiBrowserStorage } from "../../src/client/infrastructure/storage.js";

/**
 * Pure-function tests for the composer input history + cross-session draft
 * store (roadmap Module B: 输入历史/草稿).
 *
 * The history semantics mirror the terminal readline convention codex uses:
 * every committed submission is recorded newest-last, ↑ walks older, ↓ walks
 * back, and stepping past the newest restores the pre-browse draft. All of
 * that is decided by pure functions so the React wiring stays thin.
 */

describe("recordWebuiInputHistory", () => {
  it("appends the trimmed input and skips blank entries", () => {
    expect(recordWebuiInputHistory([], "  hello  ")).toEqual(["hello"]);
    expect(recordWebuiInputHistory(["hello"], "   ")).toEqual(["hello"]);
    expect(recordWebuiInputHistory([], "")).toEqual([]);
  });

  it("collapses a consecutive duplicate", () => {
    expect(recordWebuiInputHistory(["hello"], "hello")).toEqual(["hello"]);
    // A repeat after a different entry in between stays — dedupe is
    // consecutive-only, matching shell behavior where `ls <up> <enter>` twice
    // in a row costs one slot, not two.
    expect(
      recordWebuiInputHistory(["hello", "world"], "hello"),
    ).toEqual(["hello", "world", "hello"]);
  });

  it("caps the history at the limit, dropping the oldest", () => {
    const history = Array.from({ length: 100 }, (_, i) => `m${i}`);
    const next = recordWebuiInputHistory(history, "newest");
    expect(next).toHaveLength(100);
    expect(next[0]).toBe("m1");
    expect(next.at(-1)).toBe("newest");
  });
});

describe("startWebuiHistoryBrowse", () => {
  it("returns undefined when history is empty", () => {
    expect(startWebuiHistoryBrowse([], "draft")).toBeUndefined();
  });

  it("starts at the newest entry and stashes the current draft", () => {
    const browse = startWebuiHistoryBrowse(["a", "b"], "unsent");
    expect(browse).toEqual({ index: 1, draft: "unsent" });
  });
});

describe("stepWebuiHistoryBrowse", () => {
  const history = ["first", "second", "third"];

  it("steps older on prev and newer on next", () => {
    const start = startWebuiHistoryBrowse(history, "")!;
    const older = stepWebuiHistoryBrowse(start, "prev", history)!;
    expect(older).toEqual({ index: 1, draft: "" });
    const oldest = stepWebuiHistoryBrowse(older, "prev", history)!;
    expect(oldest).toEqual({ index: 0, draft: "" });
    // Clamped at the oldest entry — ↑ past the first entry stays put rather
    // than exiting, so a user leaning on ↑ does not lose their browse slot.
    const clamped = stepWebuiHistoryBrowse(oldest, "prev", history)!;
    expect(clamped).toEqual({ index: 0, draft: "" });
  });

  it("exits past the newest by returning undefined (restores stashed draft)", () => {
    const start = startWebuiHistoryBrowse(history, "unsent")!;
    const exit = stepWebuiHistoryBrowse(start, "next", history);
    expect(exit).toBeUndefined();
  });

  it("round-trips: newest → oldest → newest → exit", () => {
    let browse = startWebuiHistoryBrowse(history, "d")!;
    browse = stepWebuiHistoryBrowse(browse, "prev", history)!;
    browse = stepWebuiHistoryBrowse(browse, "prev", history)!;
    expect(browse.index).toBe(0);
    browse = stepWebuiHistoryBrowse(browse, "next", history)!;
    expect(browse.index).toBe(1);
    browse = stepWebuiHistoryBrowse(browse, "next", history)!;
    expect(browse.index).toBe(2);
    expect(stepWebuiHistoryBrowse(browse, "next", history)).toBeUndefined();
  });
});

describe("shouldRecallWebuiHistory", () => {
  it("recalls only while the caret sits on the first line", () => {
    expect(shouldRecallWebuiHistory("one", 0)).toBe(true);
    expect(shouldRecallWebuiHistory("one", 3)).toBe(true);
    expect(shouldRecallWebuiHistory("one\ntwo", 3)).toBe(true);
    expect(shouldRecallWebuiHistory("one\ntwo", 4)).toBe(false);
    expect(shouldRecallWebuiHistory("one\ntwo", 7)).toBe(false);
  });

  it("recalls from an empty draft", () => {
    expect(shouldRecallWebuiHistory("", 0)).toBe(true);
  });
});

describe("persisted composer store", () => {
  function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
    read(): string | null;
  } {
    let value: string | null = null;
    return {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
      read: () => value,
    };
  }

  it("round-trips drafts and history", () => {
    const storage = memoryStorage();
    const state: WebuiComposerPersisted = {
      drafts: { home: "unsent", "s-1": "draft one" },
      history: { home: ["hello", "world"], "s-1": ["fix the bug"] },
    };
    storage.setItem("webui.composer.state.v1", serializeWebuiComposerPersisted(state));
    expect(parseWebuiComposerPersisted(storage.getItem("webui.composer.state.v1"))).toEqual(state);
  });

  it("returns empty state when nothing is stored or storage is unavailable", () => {
    expect(parseWebuiComposerPersisted(memoryStorage().getItem("webui.composer.state.v1"))).toEqual({
      drafts: {},
      history: {},
    });
    expect(parseWebuiComposerPersisted(undefined)).toEqual({
      drafts: {},
      history: {},
    });
  });

  it("tolerates corrupt payloads by falling back to empty state", () => {
    const storage = memoryStorage();
    storage.setItem("webui.composer.state.v1", "{not json");
    expect(parseWebuiComposerPersisted(storage.getItem("webui.composer.state.v1"))).toEqual({
      drafts: {},
      history: {},
    });
  });

  it("sanitizes non-object shapes inside a valid envelope", () => {
    const storage = memoryStorage();
    storage.setItem(
      "webui.composer.state.v1",
      JSON.stringify({ drafts: "nope", history: [1, 2] }),
    );
    expect(parseWebuiComposerPersisted(storage.getItem("webui.composer.state.v1"))).toEqual({
      drafts: {},
      history: {},
    });
  });

  it("keeps only string values, trims keys, drops blanks", () => {
    const storage = memoryStorage();
    storage.setItem(
      "webui.composer.state.v1",
      JSON.stringify({
        drafts: { " s-1 ": "ok", bad: 3, empty: "" },
        history: { "s-2": ["a", 4, ""], bad2: "nope" },
      }),
    );
    expect(parseWebuiComposerPersisted(storage.getItem("webui.composer.state.v1"))).toEqual({
      drafts: { "s-1": "ok" },
      history: { "s-2": ["a"] },
    });
  });

  it("prunes to the newest slots when over budget", () => {
    const drafts: Record<string, string> = {};
    const history: Record<string, string[]> = {};
    for (let i = 0; i < 80; i += 1) {
      drafts[`s-${i}`] = `d${i}`;
      history[`s-${i}`] = [`h${i}`];
    }
    const pruned = pruneWebuiComposerPersisted(
      { drafts, history },
      { draftSlots: 50, historySlots: 50 },
    );
    expect(Object.keys(pruned.drafts)).toHaveLength(50);
    expect(Object.keys(pruned.history)).toHaveLength(50);
    // Newest slots survive; the oldest half is dropped.
    expect(pruned.drafts["s-79"]).toBe("d79");
    expect(pruned.drafts["s-0"]).toBeUndefined();
    expect(pruned.history["s-79"]).toEqual(["h79"]);
  });

  it("keeps the active keys alive through a prune", () => {
    const pruned = pruneWebuiComposerPersisted(
      {
        drafts: { old1: "a", old2: "b", home: "keep" },
        history: { old1: ["a"], home: ["h"] },
      },
      { draftSlots: 1, historySlots: 1, keepKeys: ["home"] },
    );
    expect(pruned.drafts).toEqual({ home: "keep" });
    expect(pruned.history).toEqual({ home: ["h"] });
  });

  it("caps individual draft and history-entry sizes in UTF-8 bytes", () => {
    // ASCII: one byte per character.
    const ascii = "x".repeat(80_000);
    // CJK: three bytes per character — a character-count cap would let this
    // through at ~120 KB, the byte cap must cut it to ≤65_536 bytes.
    const cjk = "汉".repeat(40_000);
    const pruned = pruneWebuiComposerPersisted(
      { drafts: { a: ascii, c: cjk }, history: { a: [ascii], c: [cjk] } },
      {},
    );
    expect(pruned.drafts.a!.length).toBe(65_536);
    expect(pruned.history.a![0]!.length).toBe(65_536);
    expect(new TextEncoder().encode(pruned.drafts.c!).length).toBeLessThanOrEqual(65_536);
    expect(pruned.drafts.c!.length).toBe(21_845);
    expect(new TextEncoder().encode(pruned.history.c![0]!).length).toBeLessThanOrEqual(65_536);
    // The cut must not split a surrogate pair (emoji = 4-byte pair).
    const emoji = "😀".repeat(30_000);
    const capped = pruneWebuiComposerPersisted(
      { drafts: { e: emoji }, history: {} },
      {},
    );
    const value = capped.drafts.e!;
    expect(/[\uD800-\uDBFF]$/.test(value)).toBe(false);
    expect(new TextEncoder().encode(value).length).toBeLessThanOrEqual(65_536);
  });

  it("keeps the active keys alive through a save's prune", () => {
    const storage = memoryStorage();
    const drafts: Record<string, string> = {};
    const history: Record<string, string[]> = {};
    for (let i = 0; i < 60; i += 1) drafts[`s-${i}`] = "d";
    storage.setItem("webui.composer.state.v1", serializeWebuiComposerPersisted({ drafts, history }, ["s-5"]));
    const persisted = parseWebuiComposerPersisted(storage.getItem("webui.composer.state.v1"));
    // s-5 is old by insertion order but is the live session — it survives.
    expect(persisted.drafts["s-5"]).toBe("d");
    expect(Object.keys(persisted.drafts)).toHaveLength(51);
  });
});

describe("migrateWebuiHomeComposerState", () => {
  it("moves home history and draft onto the created session key", () => {
    const state = {
      drafts: { home: "unsent", "s-1": "keep" },
      history: { home: ["hello"], "s-1": ["existing"] },
    };
    const migrated = migrateWebuiHomeComposerState(state, "s-2");
    expect(migrated.drafts).toEqual({ "s-1": "keep", "s-2": "unsent" });
    expect(migrated.history).toEqual({ "s-1": ["existing"], "s-2": ["hello"] });
  });

  it("merges home history after entries the session already has", () => {
    const migrated = migrateWebuiHomeComposerState(
      { drafts: {}, history: { home: ["second"], "s-2": ["first"] } },
      "s-2",
    );
    expect(migrated.history["s-2"]).toEqual(["first", "second"]);
  });

  it("returns the same state when home is empty", () => {
    const state = { drafts: { "s-1": "d" }, history: { "s-1": ["h"] } };
    expect(migrateWebuiHomeComposerState(state, "s-2")).toBe(state);
  });
});

describe("composer persistence ownership", () => {
  it("persists through an injected infrastructure adapter", () => {
    const values = new Map<string, string>();
    const browser = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as Storage;
    const adapter = createWebuiBrowserStorage(browser);
    const composer = createWebuiComposerStore({ storage: adapter });
    composer.setDraft("home", "draft");
    composer.recordInput("home", "sent");
    expect(createWebuiComposerStore({ storage: adapter }).getSnapshot()).toEqual({
      drafts: { home: "draft" },
      history: { home: ["sent"] },
    });
  });

  it("does not access browser storage without an injected adapter", () => {
    const composer = createWebuiComposerStore();
    composer.setDraft("home", "local-only");
    expect(composer.getSnapshot().drafts.home).toBe("local-only");
  });
});
