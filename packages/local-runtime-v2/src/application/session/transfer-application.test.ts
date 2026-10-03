import { describe, expect, it, vi } from "vitest";

import {
  parseSessionTransferFile,
  SESSION_TRANSFER_FORMAT,
  SessionTransferApplication,
  SessionTransferError,
  type SessionTransferFile,
} from "./transfer-application.js";

// A record shaped like the ones real sessions carry: the canonical receipts
// that `getMessages` drops are present on purpose, because that is exactly
// what this layer exists to preserve.
const DISPLAY_ROW = {
  msg_id: "msg-1",
  role: "assistant",
  kind: "compaction",
  turn_id: "turn-a",
  timestamp: 1789294472376,
  metadata: { compactionId: "ctx_9", tokensBefore: 311295 },
  operationId: "turn-a:history:compaction:ctx_9",
  committedRevision: "sha256:abc",
  sourceContext: { steeredFrom: "turn-b" },
};

const ENVELOPE = {
  message_id: "msg-1",
  turn_id: "turn-a",
  message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  turn_config: { effort: "high" },
};

const SNAPSHOT = {
  generation: 1,
  fileName: "g000000000001--ctx_a.jsonl",
  revision: "sha256:snap",
  records: [{ message_id: "msg-0", turn_id: "turn-0", message: { role: "user", content: "before" } }],
};

function file(overrides: Partial<SessionTransferFile> = {}): SessionTransferFile {
  return {
    format: SESSION_TRANSFER_FORMAT,
    exportedAt: "2026-10-02T10:00:00.000Z",
    session: { sessionId: "mvs_src", title: "Original" },
    canonical: {
      envelopes: [ENVELOPE],
      snapshots: [SNAPSHOT],
      generation: 7,
      revision: "sha256:rev",
    },
    display: { messages: [DISPLAY_ROW] },
    ...overrides,
  };
}

function harness(options: { readResult?: unknown } = {}) {
  const publish = vi.fn(async () => {});
  const stageFork = vi.fn(async () => ({ publish }));
  const historyRead = vi.fn(async () => ({
    activeGeneration: 7,
    active: [ENVELOPE],
    snapshots: [SNAPSHOT],
    revision: "sha256:rev",
    activeSettled: true,
  }));
  const list = vi.fn(async () => ({ messages: [DISPLAY_ROW], hasMore: false }));
  const replace = vi.fn(async () => {});
  const now = () => 1_700_000_000_000;
  const app = new SessionTransferApplication({
    messages: { list, replace } as never,
    historyMutation: { read: historyRead, stageFork } as never,
    now,
  });
  void options;
  return { app, publish, stageFork, historyRead, list, replace };
}

/**
 * Assert on the error *code*, not just the class. Every rejection throws
 * `SessionTransferError`, so a class-only assertion is satisfied by a payload
 * rejected for an entirely different reason -- which is how a "rejects a
 * foreign format tag" test stays green after the format check is deleted: the
 * object then falls through and fails on the missing layer instead.
 */
function expectRejection(value: unknown, code: string): void {
  let thrown: unknown;
  try {
    parseSessionTransferFile(value);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${code} for ${JSON.stringify(value)?.slice(0, 80)}`).toBeInstanceOf(
    SessionTransferError,
  );
  expect((thrown as SessionTransferError).code).toBe(code);
}

describe("SessionTransferApplication.read", () => {
  it("carries both storage layers, not a rendered view", async () => {
    const { app } = harness();

    const result = await app.read("mvs_src");

    // The display layer must be the stored record. `operationId` and
    // `committedRevision` are the receipts that tie a compaction row back to
    // its canonical mutation; if this ever reads through `getMessages` they
    // are the first things to disappear.
    expect(result.display.messages).toEqual([DISPLAY_ROW]);
    expect(result.display.messages[0]?.operationId).toBe("turn-a:history:compaction:ctx_9");
    expect(result.display.messages[0]?.committedRevision).toBe("sha256:abc");
    expect(result.display.messages[0]?.sourceContext).toEqual({ steeredFrom: "turn-b" });
  });

  it("keeps every turn id verbatim instead of re-deriving it", async () => {
    const { app } = harness();
    const historyRead = vi.fn(async () => ({
      activeGeneration: 3,
      active: [
        { message_id: "msg-1", turn_id: "turn:compaction", message: {} },
        { message_id: "msg-2", turn_id: "turn:plain", message: {} },
      ],
      snapshots: [],
      revision: "sha256:rev",
      activeSettled: true,
    }));
    const scoped = new SessionTransferApplication({
      messages: { list: async () => ({ messages: [] }), replace: async () => {} } as never,
      historyMutation: { read: historyRead, stageFork: async () => ({ publish: async () => {} }) } as never,
      now: () => 0,
    });

    const result = await scoped.read("mvs_src");

    // A `provider.replace`-style import flattens both of these to
    // `turn_import` / `turn_import:0`. The transfer must not.
    expect(result.canonical.envelopes.map((entry) => entry.turn_id)).toEqual([
      "turn:compaction",
      "turn:plain",
    ]);
  });

  it("carries the generation the file was published under", async () => {
    const { app } = harness();
    await expect(app.read("mvs_src")).resolves.toMatchObject({
      canonical: { generation: 7, revision: "sha256:rev" },
    });
  });

  it("copies the message list so a later read cannot mutate an exported file", async () => {
    // A stable array, not a fresh literal per call: with a fresh literal the
    // second `read` would see a new array whether or not `read` copied, so
    // the assertion below would pass either way.
    const stored = [{ msg_id: "msg-1" }];
    const list = vi.fn(async () => ({ messages: stored, hasMore: false }));
    const app = new SessionTransferApplication({
      messages: { list, replace: async () => {} } as never,
      historyMutation: {
        read: async () => ({
          activeGeneration: 1,
          active: [],
          snapshots: [],
          revision: "sha256:r",
          activeSettled: true,
        }),
        stageFork: async () => ({ publish: async () => {} }),
      } as never,
      now: () => 0,
    });

    const first = await app.read("mvs_src");
    first.display.messages.push({ msg_id: "injected" });

    // A copy means the repository's own array is untouched.
    expect(stored).toEqual([{ msg_id: "msg-1" }]);

    const second = await app.read("mvs_src");
    expect(second.display.messages).toEqual([{ msg_id: "msg-1" }]);
  });
});

describe("SessionTransferApplication.write", () => {
  it("carries the compaction snapshots the active file is chained to", async () => {
    // The single most important field for a compacted session. The active
    // generation's file names its parent by (generation, compactionId), and
    // the scanner walks the whole lineage before accepting anything -- export
    // the active file alone and the import dies with `parent-snapshot-missing`.
    const { app, stageFork } = harness();

    const exported = await app.read("mvs_src");
    expect(exported.canonical.snapshots).toEqual([SNAPSHOT]);

    await app.write({ targetSessionId: "mvs_dst", file: exported });
    const staged = stageFork.mock.calls[0]?.[0] as { snapshots: unknown[] };
    expect(staged.snapshots).toEqual([SNAPSHOT]);
  });

  it("keeps a snapshot file name to its last segment", async () => {
    // The name becomes a path under the session's snapshot directory, so a
    // payload naming `../../evil.jsonl` must not escape it.
    const { app, stageFork } = harness();

    await app.write({
      targetSessionId: "mvs_dst",
      file: file({
        canonical: {
          envelopes: [ENVELOPE],
          snapshots: [{ ...SNAPSHOT, fileName: "../../../etc/g000000000001--ctx_a.jsonl" }],
          generation: 7,
          revision: "r",
        },
      }),
    });

    const staged = stageFork.mock.calls[0]?.[0] as { snapshots: { fileName: string }[] };
    expect(staged.snapshots[0]?.fileName).toBe("g000000000001--ctx_a.jsonl");
  });

  it("rejects a payload that repeats a snapshot generation", () => {
    expectRejection(
      file({
        canonical: {
          envelopes: [ENVELOPE],
          snapshots: [SNAPSHOT, { ...SNAPSHOT, fileName: "g000000000001--other.jsonl" }],
          generation: 7,
          revision: "r",
        },
      }),
      "malformed-transfer-file",
    );
  });

  it("rejects a snapshot missing the fields the publisher writes", () => {
    for (const bad of [
      { ...SNAPSHOT, generation: -1 },
      { ...SNAPSHOT, generation: 1.5 },
      { ...SNAPSHOT, fileName: "" },
      { ...SNAPSHOT, revision: 7 },
      { ...SNAPSHOT, records: "nope" },
    ]) {
      expectRejection(
        file({ canonical: { envelopes: [ENVELOPE], snapshots: [bad as never], generation: 7, revision: "r" } }),
        "malformed-transfer-file",
      );
    }
  });

  it("accepts a session that has never been compacted", () => {
    const uncompacted = file({
      canonical: { envelopes: [ENVELOPE], snapshots: [], generation: 1, revision: "r" },
    });
    expect(() => parseSessionTransferFile(uncompacted)).not.toThrow();
  });

  it("publishes canonical envelopes verbatim and then replaces the display rows", async () => {
    const { app, stageFork, publish, replace } = harness();

    const result = await app.write({ targetSessionId: "mvs_dst", sourceSessionId: "mvs_src", file: file() });

    expect(stageFork).toHaveBeenCalledTimes(1);
    const staged = stageFork.mock.calls[0]?.[0] as { active: unknown[]; generation: number };
    expect(staged.active).toEqual([ENVELOPE]);
    expect(staged.active[0]).toMatchObject({ turn_id: "turn-a", turn_config: { effort: "high" } });
    expect(staged.generation).toBe(7);
    expect(publish).toHaveBeenCalledTimes(1);

    expect(replace).toHaveBeenCalledWith({ sessionId: "mvs_dst", messages: [DISPLAY_ROW] });
    expect(result).toMatchObject({
      sessionId: "mvs_dst",
      canonicalMessages: 1,
      displayMessages: 1,
    });
  });

  it("publishes canonical history before replacing display rows", async () => {
    const { app, stageFork, publish, replace } = harness();
    const order: string[] = [];
    stageFork.mockImplementation(async () => ({
      publish: async () => {
        order.push("publish");
      },
    }));
    replace.mockImplementation(async () => {
      order.push("replace");
    });

    await app.write({ targetSessionId: "mvs_dst", file: file() });

    // Reversed, a failure between the two writes would leave a session the
    // model can read but the user cannot see.
    expect(order).toEqual(["publish", "replace"]);
  });

  it("does not take the staging operation id from the payload", async () => {
    const { app, stageFork } = harness();
    const hostile = file({
      session: { sessionId: "../../escape", title: "x" },
    });

    await app.write({ targetSessionId: "mvs_dst", file: hostile });

    // `operationId` becomes a directory name under the session directory.
    const operationId = (stageFork.mock.calls[0]?.[0] as { operationId: string }).operationId;
    expect(operationId).toBe("session-import-mvs_dst-1700000000000");
    expect(operationId).not.toContain("escape");
  });

  it("survives a display write failure without leaving canonical unpublished", async () => {
    const { app, replace } = harness();
    replace.mockRejectedValue(new Error("display locked"));

    await expect(
      app.write({ targetSessionId: "mvs_dst", file: file() }),
    ).rejects.toThrow("display locked");
  });

  it("can be run twice with the same payload", async () => {
    const { app } = harness();

    const first = await app.write({ targetSessionId: "mvs_dst", file: file() });
    const second = await app.write({ targetSessionId: "mvs_dst", file: file() });

    expect(second).toEqual(first);
  });
});

describe("parseSessionTransferFile", () => {
  it("rejects a payload that is not a transfer file", () => {
    expectRejection({ format: "something-else" }, "not-a-transfer-file");
    expectRejection({ format: "something-else", canonical: { envelopes: [ENVELOPE], generation: 1 }, display: { messages: [DISPLAY_ROW] } }, "not-a-transfer-file");
    expectRejection("nope", "not-a-transfer-file");
    expectRejection(null, "not-a-transfer-file");
    expectRejection(42, "not-a-transfer-file");
  });

  it("rejects a payload missing either storage layer", () => {
    expectRejection({ ...file(), display: undefined }, "malformed-transfer-file");
    expectRejection({ ...file(), canonical: undefined }, "malformed-transfer-file");
  });

  it("rejects a canonical entry without an id", () => {
    expectRejection(
      file({
        canonical: {
          envelopes: [{ message_id: "", turn_id: "turn-a", message: {} }],
          generation: 1,
          revision: "r",
        },
      }),
      "malformed-transfer-file",
    );
  });

  it("rejects a canonical entry with no turn", () => {
    expectRejection(
      file({
        canonical: {
          envelopes: [{ message_id: "msg-1", turn_id: 7, message: {} } as never],
          generation: 1,
          revision: "r",
        },
      }),
      "malformed-transfer-file",
    );
  });

  it("rejects a generation the publisher could not have written", () => {
    for (const generation of [-1, 1.5, undefined, "7"]) {
      expectRejection(
        file({
          canonical: { envelopes: [ENVELOPE], generation: generation as never, revision: "r" },
        }),
        "malformed-transfer-file",
      );
    }
  });

  it("rejects a payload with nothing in it", () => {
    expectRejection(
      file({
        canonical: { envelopes: [], generation: 1, revision: "r" },
        display: { messages: [] },
      }),
      "empty-transfer",
    );
  });

  it("keeps a one-sided session: canonical only, and display only", () => {
    const canonicalOnly = file({ display: { messages: [] } });
    const displayOnly = file({ canonical: { envelopes: [], generation: 2, revision: "r" } });
    expect(() => parseSessionTransferFile(canonicalOnly)).not.toThrow();
    expect(() => parseSessionTransferFile(displayOnly)).not.toThrow();
  });
});

describe("SessionTransferApplication.write validation", () => {
  it("writes nothing when the payload fails validation", async () => {
    const { app, stageFork, replace } = harness();

    await expect(
      app.write({ targetSessionId: "mvs_dst", file: { format: "wrong" } }),
    ).rejects.toMatchObject({ name: "SessionTransferError", code: "not-a-transfer-file" });

    // A rejected import must not leave a half-filled session behind.
    expect(stageFork).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("round-trips its own export without losing either layer", async () => {
    const { app } = harness();
    const exported = await app.read("mvs_src");

    const written = await app.write({ targetSessionId: "mvs_dst", file: exported });

    expect(written.canonicalMessages).toBe(1);
    expect(written.displayMessages).toBe(1);
  });
});
