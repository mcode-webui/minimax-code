// Session export — payload shape, cursor walk, and download-name hygiene.
//
// The load-bearing case is the cursor walk. `collectWebuiSessionMessages` calls
// a transport the test controls, so the tests drive it with a transport that
// pages, one that lies about `hasMore`, and one that repeats its cursor. A
// walker that trusted the cursor blindly would either truncate a long history
// or spin forever, and neither shows up in a "returns something" assertion.

import { describe, expect, it } from "vitest";
import type {
  WebuiClientMessage,
  WebuiClientMessageLoader,
  WebuiClientMessagePage,
  WebuiClientSession,
} from "../../src/client/contracts.js";
import {
  WEBUI_SESSION_EXPORT_FORMAT,
  buildWebuiSessionExport,
  collectWebuiSessionMessages,
  webuiSessionExportFileName,
  webuiSessionExportToJson,
} from "../../src/client/session-export.js";

const session: WebuiClientSession = {
  sessionId: "s1",
  agentName: "main",
  title: "修复终端 SHELL 解析",
  workspaceDir: "/work/minimax-code",
  createdAt: 1,
  updatedAt: 20,
};

const message = (msgId: string): WebuiClientMessage => ({ msgId, role: "user" });

/** A loader that serves `total` messages newest-first, one page at a time. */
const pagingLoader = (total: number, pageSize = 2) => {
  const calls: { id: string; before?: string }[] = [];
  const all = Array.from({ length: total }, (_, index) => message(`m${index + 1}`));
  const load: WebuiClientMessageLoader = async (request) => {
    calls.push({ id: request.id, ...(request.before ? { before: request.before } : {}) });
    // The first call has no cursor and returns the newest page; each later call
    // takes the cursor as an index into the remaining list.
    const end = request.before ? Number(request.before) : all.length;
    const start = Math.max(0, end - pageSize);
    const slice = all.slice(start, end);
    const nextIndex = start;
    const result: WebuiClientMessagePage = {
      messages: slice,
      ...(nextIndex > 0 ? { nextCursor: String(nextIndex) } : {}),
      hasMore: nextIndex > 0,
    };
    return result;
  };
  return { load, calls, all };
};

describe("collectWebuiSessionMessages", () => {
  it("walks every page and returns the history oldest-first", async () => {
    const { load, calls, all } = pagingLoader(5);
    const result = await collectWebuiSessionMessages(load, "s1");
    // The loader hands back the newest page first, so a correct walker has to
    // reverse. Getting this backwards ships a transcript in reverse order,
    // which reads as corrupt rather than wrong.
    expect(result.map((entry) => entry.msgId)).toEqual(all.map((entry) => entry.msgId));
    expect(result).toHaveLength(5);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]!.before).toBeUndefined();
  });

  it("passes each page's cursor to the next call", async () => {
    const { load, calls } = pagingLoader(5);
    await collectWebuiSessionMessages(load, "s1");
    for (let index = 1; index < calls.length; index += 1) {
      expect(calls[index]!.before).toBeDefined();
    }
    expect(calls.every((call) => call.id === "s1")).toBe(true);
  });

  it("stops on a single page", async () => {
    // Two messages fit in one page of size two, so the walk must not ask twice.
    const { load, calls } = pagingLoader(2);
    const result = await collectWebuiSessionMessages(load, "s1");
    expect(result).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it("stops when the transport repeats a cursor instead of advancing", async () => {
    // A transport bug that returns a non-advancing cursor would make a naive
    // `while (hasMore)` walk loop forever. The walker must notice.
    let calls = 0;
    const load: WebuiClientMessageLoader = async () => {
      calls += 1;
      return { messages: [message("stuck")], hasMore: true, nextCursor: "same" };
    };
    const result = await collectWebuiSessionMessages(load, "s1");
    expect(calls).toBe(2);
    expect(result).toHaveLength(2);
  });

  it("stops on the page ceiling even if the transport keeps claiming more", async () => {
    let calls = 0;
    const load: WebuiClientMessageLoader = async (request) => {
      calls += 1;
      return {
        messages: [message(`m${calls}`)],
        hasMore: true,
        nextCursor: `cursor-${calls}`,
      };
    };
    const result = await collectWebuiSessionMessages(load, "s1", 3);
    expect(calls).toBe(3);
    expect(result).toHaveLength(3);
  });

  it("stops when hasMore is true but no cursor comes back", async () => {
    const load: WebuiClientMessageLoader = async () => ({
      messages: [message("only")],
      hasMore: true,
    });
    await expect(collectWebuiSessionMessages(load, "s1")).resolves.toHaveLength(1);
  });

  it("tolerates a page with no messages array", async () => {
    const load: WebuiClientMessageLoader = async () => ({ messages: undefined, hasMore: false });
    await expect(collectWebuiSessionMessages(load, "s1")).resolves.toEqual([]);
  });
});

describe("buildWebuiSessionExport", () => {
  it("records the format, the identity fields, and the message count", () => {
    const messages = [message("m1"), message("m2")];
    const payload = buildWebuiSessionExport(session, messages, "2026-10-03T02:46:29.000Z");
    expect(payload.format).toBe(WEBUI_SESSION_EXPORT_FORMAT);
    expect(payload.exportedAt).toBe("2026-10-03T02:46:29.000Z");
    expect(payload.messageCount).toBe(2);
    // The count has to agree with the array, or a consumer reading either one
    // gets a different answer about how much history the file holds.
    expect(payload.messageCount).toBe(payload.messages.length);
    expect(payload.session).toEqual({
      sessionId: "s1",
      title: "修复终端 SHELL 解析",
      agentName: "main",
      workspaceDir: "/work/minimax-code",
      createdAt: 1,
      updatedAt: 20,
    });
  });

  it("falls back through title, agent name, and session id for the title field", () => {
    const byAgent = buildWebuiSessionExport(
      { ...session, title: undefined },
      [],
      "2026-10-03T00:00:00.000Z",
    );
    expect(byAgent.session.title).toBe("main");
    const byId = buildWebuiSessionExport(
      { ...session, title: "   ", agentName: "" },
      [],
      "2026-10-03T00:00:00.000Z",
    );
    expect(byId.session.title).toBe("s1");
  });

  it("omits workspaceDir rather than emitting an empty string", () => {
    const payload = buildWebuiSessionExport(
      { ...session, workspaceDir: undefined },
      [],
      "2026-10-03T00:00:00.000Z",
    );
    expect("workspaceDir" in payload.session).toBe(false);
  });
});

describe("webuiSessionExportFileName", () => {
  const at = "2026-10-03T02:46:29.000Z";
  it("strips characters a filesystem would reject", () => {
    const name = webuiSessionExportFileName({ ...session, title: "a/b:c*d?e" }, at);
    expect(name).not.toMatch(/[/\\:*?"<>|]/u);
    expect(name.endsWith(".json")).toBe(true);
  });

  it("keeps a CJK title readable", () => {
    const name = webuiSessionExportFileName(session, at);
    expect(name.startsWith("修复终端 SHELL 解析")).toBe(true);
  });

  it("keeps interior spaces and drops trailing dots and spaces", () => {
    // Windows strips trailing dots and spaces when it writes the file, so a
    // name that keeps them would not match the name the user was shown.
    const name = webuiSessionExportFileName({ ...session, title: "a b... " }, at);
    expect(name).toBe("a b-20261003T024629.json");
  });

  it("collapses whitespace and caps the length", () => {
    const name = webuiSessionExportFileName(
      { ...session, title: `${"x".repeat(200)}   tail` },
      at,
    );
    expect(name.length).toBeLessThan(100);
    expect(name).not.toMatch(/ {3}/u);
  });

  it("falls back to the session id when no title or agent name survives", () => {
    // A whitespace-only title is falsy after the trim in the fallback chain, so
    // the name comes from the id. (A title of "///" is not the same case: it
    // sanitizes to "___", which is a perfectly good filename.)
    const name = webuiSessionExportFileName(
      { ...session, title: "   ", agentName: "" },
      at,
    );
    expect(name).toBe("s1-20261003T024629.json");
  });
});

describe("webuiSessionExportToJson", () => {
  it("emits pretty JSON that parses back to the same payload", () => {
    const payload = buildWebuiSessionExport(session, [message("m1")], "2026-10-03T02:46:29.000Z");
    const text = webuiSessionExportToJson(payload);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("\n  ");
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(payload)));
  });
});
