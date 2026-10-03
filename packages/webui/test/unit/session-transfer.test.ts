// Round-trip transfer format.
//
// The load-bearing contract is that the file carries BOTH layers. A transfer
// that kept only the display projection would import as a transcript the model
// cannot see, and one that kept only canonical history would import as a
// session the rail cannot render -- so the tests below assert both are present
// rather than just asserting the object is shaped correctly.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { WebuiMessage, WebuiSessionInfo } from "../../src/server/port.js";
import {
  WEBUI_SESSION_TRANSFER_FORMAT,
  collectSessionDisplayMessages,
  buildSessionTransfer,
  locateSessionHistoryDir,
  readCanonicalEnvelopes,
  readHistoryCatalog,
  sessionHistoryDirSuffix,
  webuiSessionTransferFileName,
} from "../../src/server/session-transfer.js";

const session = (over: Partial<WebuiSessionInfo> = {}): WebuiSessionInfo => ({
  sessionId: "mvs_abc123",
  agentName: "main",
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

const displayMessage = (over: Partial<WebuiMessage> = {}): WebuiMessage => ({
  msgId: "msg-d1",
  turnId: "turn-1",
  role: "assistant",
  timestamp: 10,
  msgContent: "hello",
  toolCalls: [{ toolName: "bash", toolCallId: "call-1", toolCallStatus: 2, toolCallResultData: "output" }],
  ...over,
});

const envelope = (over: Record<string, unknown> = {}) => ({
  message_id: "msg-c1",
  turn_id: "turn-1",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 10 },
  ...over,
});

describe("sessionHistoryDirSuffix", () => {
  it("encodes the id the way the runtime names the directory", () => {
    // Pinned against a directory name observed on disk
    // (`2026/10/02/00-26-36-300-session_bXZzXzFhZWQ0NzhmMjA1MzQ0N2Y5ZjIzYWY3NjIzNGMwNzc1`),
    // not against a value this module produced.
    expect(sessionHistoryDirSuffix("mvs_1aed478f2053447f9f23af76234c0775")).toBe(
      "session_bXZzXzFhZWQ0NzhmMjA1MzQ0N2Y5ZjIzYWY3NjIzNGMwNzc1",
    );
  });

  it("is reversible, so the id can be recovered from a directory name", () => {
    for (const id of ["mvs_1aed478f2053447f9f23af76234c0775", "a", "会话-id"]) {
      const decoded = Buffer.from(sessionHistoryDirSuffix(id).slice("session_".length), "base64").toString("utf8");
      expect(decoded).toBe(id);
    }
  });

  it("handles ids whose base64 would otherwise be padded", () => {
    expect(sessionHistoryDirSuffix("ab")).not.toMatch(/=/u);
  });
});

describe("readCanonicalEnvelopes", () => {
  const withDir = async (contents: string) => {
    const dir = await mkdtemp(join(tmpdir(), "mcode-transfer-"));
    await writeFile(join(dir, "messages.jsonl"), contents, "utf8");
    return dir;
  };

  it("keeps well-formed envelopes in file order", async () => {
    const dir = await withDir(
      [envelope({ message_id: "a" }), envelope({ message_id: "b" }), envelope({ message_id: "c" })]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    try {
      const read = await readCanonicalEnvelopes(dir);
      expect(read.map((e) => e.message_id)).toEqual(["a", "b", "c"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("drops a malformed line instead of failing the whole session", async () => {
    // A truncated tail from a crash must not cost the user the rest of a
    // session. The importer re-validates whatever it is handed.
    const dir = await withDir(
      `${JSON.stringify(envelope({ message_id: "a" }))}\n{"broken\n${JSON.stringify(envelope({ message_id: "b" }))}\n`,
    );
    try {
      expect((await readCanonicalEnvelopes(dir)).map((e) => e.message_id)).toEqual(["a", "b"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("drops envelopes missing the identity fields the importer needs", async () => {
    const dir = await withDir(
      [
        JSON.stringify(envelope({ message_id: "a" })),
        JSON.stringify({ turn_id: "t", message: {} }),
        JSON.stringify({ message_id: "c", message: {} }),
        JSON.stringify("not an object"),
      ].join("\n"),
    );
    try {
      expect((await readCanonicalEnvelopes(dir)).map((e) => e.message_id)).toEqual(["a"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("returns empty for a session with no history rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcode-transfer-empty-"));
    try {
      expect(await readCanonicalEnvelopes(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("readHistoryCatalog", () => {
  it("reads the generation and revision, and tolerates their absence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcode-catalog-"));
    try {
      await writeFile(join(dir, "history-catalog.json"), JSON.stringify({ activeGeneration: 8, activeRevision: "sha256:abc" }));
      expect(await readHistoryCatalog(dir)).toEqual({ activeGeneration: 8, activeRevision: "sha256:abc" });
      await writeFile(join(dir, "history-catalog.json"), "{ broken");
      expect(await readHistoryCatalog(dir)).toEqual({});
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("locateSessionHistoryDir", () => {
  it("finds a session by its encoded directory name and ignores other sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-locate-"));
    try {
      const want = sessionHistoryDirSuffix("mvs_target");
      const other = sessionHistoryDirSuffix("mvs_other");
      const dir = join(root, "v2", "sessions", "2026", "10", "03", `04-42-59-970-${want}`);
      await mkdir(dir, { recursive: true });
      await mkdir(join(root, "v2", "sessions", "2026", "10", "03", `05-00-00-000-${other}`), { recursive: true });
      expect(await locateSessionHistoryDir(root, "mvs_target")).toBe(dir);
      expect(await locateSessionHistoryDir(root, "mvs_missing")).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns undefined instead of throwing when the data dir is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcode-locate-none-"));
    try {
      expect(await locateSessionHistoryDir(join(root, "does", "not", "exist"), "mvs_x")).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("matches the encoded id at the tail, not as a substring", async () => {
    // The real hazard: base64 of a short id can be a prefix of base64 of a
    // longer one, so a directory for `mvs_x…` can contain the encoded form of
    // `mvs_x` in the middle. A substring match would return the wrong session's
    // history and the import would silently write another conversation.
    const root = await mkdtemp(join(tmpdir(), "mcode-locate-prefix-"));
    try {
      const short = "mvs_x";
      const decoy = `${sessionHistoryDirSuffix(short)}-andmore`;
      const wanted = "mvs_x_more_specific_id";
      const decoyDir = join(root, "v2", "sessions", "2026", "10", "03", `01-00-00-000-${decoy}`);
      const wantedDir = join(root, "v2", "sessions", "2026", "10", "03", `02-00-00-000-${sessionHistoryDirSuffix(wanted)}`);
      await mkdir(decoyDir, { recursive: true });
      await mkdir(wantedDir, { recursive: true });
      // The decoy really does contain the short encoding as a substring.
      expect(decoy).toContain(sessionHistoryDirSuffix(short));
      expect(decoy.endsWith(sessionHistoryDirSuffix(short))).toBe(false);
      // And the short id must not resolve to it.
      expect(await locateSessionHistoryDir(root, short)).toBeUndefined();
      expect(await locateSessionHistoryDir(root, wanted)).toBe(wantedDir);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("buildSessionTransfer", () => {
  const transfer = () =>
    buildSessionTransfer({
      sessionId: "mvs_abc123",
      session: session({ title: "Qwen Image 2.1" }),
      envelopes: [envelope(), envelope({ message_id: "msg-c2", turn_id: "turn-2" })],
      messages: [displayMessage(), displayMessage({ msgId: "msg-d2", turnId: "turn-2" })],
      exportedAt: "2026-10-03T05:00:00.000Z",
      activeGeneration: 8,
      activeRevision: "sha256:abc",
    });

  it("survives a JSON round trip, which is what the file actually does", () => {
    const parsed = JSON.parse(JSON.stringify(transfer())) as ReturnType<typeof transfer>;
    expect(parsed.canonical.envelopes.map((e) => e.message_id)).toEqual(["msg-c1", "msg-c2"]);
    expect(parsed.display.messages.map((m) => m.msgId)).toEqual(["msg-d1", "msg-d2"]);
  });

  it("carries both layers, which is the whole point of the format", () => {
    const payload = transfer();
    // Canonical keeps `toolResult` as its own message; display has no such
    // role. Losing either side makes the import unrecoverable in one direction.
    expect(payload.canonical.envelopes).toHaveLength(2);
    expect(payload.display.messages).toHaveLength(2);
    expect(payload.canonical.envelopes[0]!.message).toBeDefined();
    expect(payload.display.messages[0]!.toolCalls).toHaveLength(1);
  });

  it("pins the tool result in both places, so neither layer is a summary", () => {
    const payload = transfer();
    // The rendered result survives in display...
    expect(JSON.stringify(payload.display.messages[0]!.toolCalls)).toContain("call-1");
    // ...and the raw message survives in canonical.
    expect(JSON.stringify(payload.canonical.envelopes[0]!.message)).toContain("hello");
  });

  it("stamps the format so a future reader can refuse this one", () => {
    expect(transfer().format).toBe(WEBUI_SESSION_TRANSFER_FORMAT);
  });

  it("carries the catalog position, which the importer cannot recompute", () => {
    const payload = transfer();
    expect(payload.canonical.activeGeneration).toBe(8);
    expect(payload.canonical.activeRevision).toBe("sha256:abc");
  });

  it("omits absent optional fields instead of writing nulls", () => {
    const minimal = buildSessionTransfer({
      sessionId: "mvs_abc123",
      session: {
        title: undefined,
        agentName: undefined,
        workspaceDir: undefined,
        createdAt: undefined,
        updatedAt: undefined,
      },
      envelopes: [],
      messages: [],
      exportedAt: "2026-10-03T05:00:00.000Z",
    });
    expect(Object.keys(minimal.session).sort()).toEqual(["sessionId", "title"]);
    expect(minimal.canonical).toEqual({ envelopes: [] });
  });

  it("falls back through title, agent name, then id for a display name", () => {
    const named = (s: WebuiSessionInfo) => buildSessionTransfer({
      sessionId: s.sessionId ?? "mvs_abc123", session: s, envelopes: [], messages: [], exportedAt: "2026-10-03T05:00:00.000Z",
    }).session.title;
    expect(named(session({ title: "  spaced  " }))).toBe("spaced");
    expect(named(session({ title: "   " }))).toBe("main");
    expect(named(session({ title: undefined, agentName: undefined }))).toBe("mvs_abc123");
  });

  it("does not mutate the caller's arrays", () => {
    const envelopes = [envelope()];
    const messages = [displayMessage()];
    const payload = buildSessionTransfer({
      sessionId: "mvs_abc123", session: session(), envelopes, messages, exportedAt: "2026-10-03T05:00:00.000Z",
    });
    (payload.canonical.envelopes as unknown[]).push(envelope());
    (payload.display.messages as unknown[]).push(displayMessage());
    expect(envelopes).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it("survives a JSON round trip, which is what the file actually does", () => {
    const parsed = JSON.parse(JSON.stringify(transfer())) as ReturnType<typeof transfer>;
    expect(parsed.canonical.envelopes.map((e) => e.message_id)).toEqual(["msg-c1", "msg-c2"]);
    expect(parsed.display.messages.map((m) => m.msgId)).toEqual(["msg-d1", "msg-d2"]);
  });
});

describe("collectSessionDisplayMessages", () => {
  it("walks backwards in time and returns the session oldest first", async () => {
    const load = vi.fn(async (request: { before?: string }) =>
      request.before === undefined
        ? { messages: [{ msgId: "m3" }, { msgId: "m4" }], nextCursor: "c1", hasMore: true }
        : { messages: [{ msgId: "m1" }, { msgId: "m2" }], hasMore: false });
    // Reversing the flattened array instead yields m1, m3, m2, m4.
    expect((await collectSessionDisplayMessages(load as never, "mvs_1")).map((m) => m.msgId))
      .toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("stops on hasMore even when the page still carries a cursor", async () => {
    // The only fixture that isolates this guard: a transport that reports the
    // end of the session but leaves a cursor behind. Without the hasMore
    // check the walk would follow it and keep going, because the other two
    // guards both look at `nextCursor`.
    const load = vi.fn(async () => ({ messages: [{ msgId: "m1" }], hasMore: false, nextCursor: "c1" }));
    const messages = await collectSessionDisplayMessages(load as never, "mvs_1");
    expect(messages.map((m) => m.msgId)).toEqual(["m1"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stops on a repeated cursor instead of looping", async () => {
    const load = vi.fn(async () => ({ messages: [{ msgId: "m1" }], hasMore: true, nextCursor: "same" }));
    const messages = await collectSessionDisplayMessages(load as never, "mvs_1");
    expect(messages).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("stops at the page ceiling rather than walking forever", async () => {
    const load = vi.fn(async (request: { before?: string }) => ({
      messages: [{ msgId: `m-${request.before ?? "0"}` }],
      hasMore: true,
      nextCursor: `c-${Number((request.before ?? "0").replace("c-", "")) + 1}`,
    }));
    const messages = await collectSessionDisplayMessages(load as never, "mvs_1", 3);
    expect(messages).toHaveLength(3);
    expect(load).toHaveBeenCalledTimes(3);
  });
});

describe("webuiSessionTransferFileName", () => {
  it("folds path separators and the Windows-reserved set", () => {
    const name = webuiSessionTransferFileName(
      "s",
      { title: 'a/b\\c:d*e?f"g<h>i|j' },
      "2026-10-03T05:00:00.000Z",
    );
    expect(name).not.toMatch(/[\\/:*?"<>|]/u);
  });

  it("strips control characters and trailing dots, which Windows drops silently", () => {
    const name = webuiSessionTransferFileName("s",
      { title: "tab\there" },
      "2026-10-03T05:00:00.000Z",
    );
    expect(name).not.toMatch(/[\u0000-\u001F]/u);
    const trailing = webuiSessionTransferFileName("s", { title: "name..." }, "2026-10-03T05:00:00.000Z");
    expect(trailing).not.toMatch(/\.[. ]*\.transfer\.json$/u);
  });

  it("keeps a space, because a space is legal and a CJK title reads better", () => {
    expect(webuiSessionTransferFileName("s", { title: "修复终端 SHELL 解析" }, "2026-10-03T05:00:00.000Z"))
      .toMatch(/^修复终端 SHELL 解析-20261003T050000\.transfer\.json$/u);
  });

  it("falls back to the id when the title reduces to nothing", () => {
    expect(webuiSessionTransferFileName("mvs_x", { title: "///" }, "2026-10-03T05:00:00.000Z"))
      .toMatch(/^mvs_x-/u);
  });
});
