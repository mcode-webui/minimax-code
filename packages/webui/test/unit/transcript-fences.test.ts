// The transcript's session fence and its handover.
//
// Both behaviours were already covered elsewhere — the fence by
// `webui-application-commands.test.ts`'s two cases, the handover by
// `transcript-shape.test.ts`'s "updates matching history identities in place" and
// the shell's "canonical page wins over the initial render seed" — but no test is
// *named* for either promise, so an edit that removed one would fail a case
// whose name does not say which promise broke. These four do.

import { describe, expect, it, vi } from "vitest";

import {
  createWebuiSessionStore,
  createWebuiTranscriptHistoryWriter,
} from "../../src/client/application/session-store.js";
import { createWebuiTranscriptHistoryOwner } from "../../src/client/conversation/transcript-history.js";
import { projectWebuiTranscriptMessages } from "../../src/client/features/transcript/projection/transcript-projection.js";
import type { WebuiClientMessagePage } from "../../src/client/features/transcript/contracts/message-view.js";

const page = (...msgIds: string[]): WebuiClientMessagePage => ({
  messages: msgIds.map((msgId) => ({ msgId, role: "user", msgContent: `text-${msgId}` })),
  hasMore: false,
});

describe("a late page after a session switch is discarded", () => {
  it("reproduces a head refresh dropping messages from an already loaded older page", async () => {
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: ({ before }) =>
        Promise.resolve(
          before
            ? {
                messages: [
                  { msgId: "old-1", role: "user", msgContent: "刷新前的较早消息" },
                  { msgId: "old-2", role: "assistant", msgContent: "较早消息的回复" },
                ],
                hasMore: false,
              }
            : {
                messages: [
                  { msgId: "recent-1", role: "user", msgContent: "最近的提问" },
                  { msgId: "recent-2", role: "assistant", msgContent: "最近的回答" },
                ],
                nextCursor: "older-page",
                hasMore: true,
              },
        ),
    });

    await owner.loadPage("S");
    await owner.loadOlder("S", "older-page");
    const beforeRefresh = store.readSession("S").transcript.page.messages ?? [];

    await owner.refreshPage("S");
    const afterRefresh = store.readSession("S").transcript.page.messages ?? [];

    expect(beforeRefresh.map((message) => [message.msgId, message.msgContent])).toEqual([
      ["old-1", "刷新前的较早消息"],
      ["old-2", "较早消息的回复"],
      ["recent-1", "最近的提问"],
      ["recent-2", "最近的回答"],
    ]);
    expect(afterRefresh.map((message) => [message.msgId, message.msgContent])).toEqual([
      ["old-1", "刷新前的较早消息"],
      ["old-2", "较早消息的回复"],
      ["recent-1", "最近的提问"],
      ["recent-2", "最近的回答"],
    ]);
    owner.dispose();
  });

  it("V15/V16 releases a deleted session's cached pages and fences late reads", async () => {
    const store = createWebuiSessionStore();
    let resolve!: (value: WebuiClientMessagePage) => void;
    const read = vi.fn(() => new Promise<WebuiClientMessagePage>((done) => { resolve = done; }));
    const owner = createWebuiTranscriptHistoryOwner({ transcript: createWebuiTranscriptHistoryWriter(store), loadMessages: read });
    const pending = owner.loadPage("deleted");
    owner.releaseSession("deleted");
    resolve(page("late"));
    await expect(pending).resolves.toEqual({ status: "stale" });
    await expect(owner.ensurePage("deleted")).resolves.toBeUndefined();
    await expect(owner.loadPage("deleted")).resolves.toEqual({ status: "stale" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.readSession("deleted").transcript.page.messages).toBeUndefined();
    owner.dispose();
  });
  it("discards it without writing anything for the session that left", async () => {
    let releaseA: (page: WebuiClientMessagePage) => void = () => undefined;
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: ({ id }) =>
        id === "A"
          ? new Promise<WebuiClientMessagePage>((resolve) => { releaseA = resolve; })
          : Promise.resolve(page("B-1")),
    });
    const loadA = owner.loadPage("A");
    await expect(owner.loadPage("B")).resolves.toMatchObject({ status: "applied" });
    releaseA(page("A-late"));
    await expect(loadA).resolves.toEqual({ status: "stale" });
    // The fence is the whole promise: the late page is not merely ignored at
    // render time, it never reaches the store.
    expect(store.readSession("A").transcript.page.messages).toBeUndefined();
    expect(store.readSession("B").transcript.page.messages?.map((m) => m.msgId)).toEqual(["B-1"]);
  });

  it("discards an older response that a refresh superseded", async () => {
    // A plain second `loadPage` JOINS the read in flight (one request, one
    // answer); what supersedes is a refresh, which is what a caller asks for when
    // the answer may have moved under it. Both halves are pinned here: this case
    // for the supersede, the next one for the join.
    const releases: Array<(page: WebuiClientMessagePage) => void> = [];
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: () => new Promise<WebuiClientMessagePage>((resolve) => releases.push(resolve)),
    });
    const first = owner.loadPage("S");
    const second = owner.refreshPage("S");
    releases[1]!(page("newer"));
    await expect(second).resolves.toMatchObject({ status: "applied" });
    releases[0]!(page("older"));
    await expect(first).resolves.toEqual({ status: "stale" });
    expect(store.readSession("S").transcript.page.messages?.map((m) => m.msgId)).toEqual(["newer"]);
  });

  // The fence above is per key, not per owner. A head read and an older-page read
  // for one session are different keys, so the newer request for one of them must
  // not cancel the other. The singleton this replaced shared one request id across
  // both, which made one of these two answers stale.
  it("does not let a newer older-page request cancel the head request for that session", async () => {
    const releases: Record<string, (page: WebuiClientMessagePage) => void> = {};
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: ({ before }) =>
        new Promise<WebuiClientMessagePage>((resolve) => {
          releases[before ?? "head"] = resolve;
        }),
    });
    owner.selectSession("S");
    owner.seed("S", page("S-3"));
    const head = owner.loadPage("S");
    const older = owner.loadOlder("S", "c1");
    releases["head"]!(page("S-3"));
    await expect(head).resolves.toMatchObject({ status: "applied" });
    releases["c1"]!(page("S-1", "S-2"));
    await expect(older).resolves.toMatchObject({ status: "applied" });
    expect(store.readSession("S").transcript.page.messages?.map((m) => m.msgId)).toEqual([
      "S-1",
      "S-2",
      "S-3",
    ]);
  });

  it("reports a handle as no longer current once a newer request for its key landed", async () => {
    const releases: Array<(page: WebuiClientMessagePage) => void> = [];
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: () => new Promise<WebuiClientMessagePage>((resolve) => releases.push(resolve)),
    });
    const first = owner.loadPage("S");
    const second = owner.refreshPage("S");
    releases[1]!(page("newer"));
    const applied = await second;
    releases[0]!(page("older"));
    await first;
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied") return;
    // The scroll restore is bound to this answer being the one the key still
    // holds, which is what keeps a superseded page from moving the viewport.
    expect(owner.isCurrentPage(applied.page)).toBe(true);
    expect(
      owner.isCurrentPage({ ...applied.page, token: { ...applied.page.token, revision: 0 } }),
    ).toBe(false);
  });
});

describe("live-to-history handover renders a completed turn once", () => {
  it("updates the history identity in place instead of adding a second row", () => {
    const history = page("turn-1");
    const live = [{ id: "turn-1", role: "user", answer: "text-turn-1", thinking: "" }];
    // In flight, the stream wins the fields; when the turn completes, history
    // supplies the persisted ones. Either way the identity appears once.
    for (const preferStream of [true, false]) {
      const merged = projectWebuiTranscriptMessages(history, live as never, preferStream);
      expect(merged.map((message) => message.msgId)).toEqual(["turn-1"]);
    }
  });

  it("does not let the live seed replace a page the owner already holds", () => {
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({ transcript: createWebuiTranscriptHistoryWriter(store) });
    owner.selectSession("S");
    owner.seed("S", page("from-history"));
    // The second seed — the same turn arriving from the live path — is refused,
    // which is what keeps one completed turn to one row.
    owner.seed("S", page("from-live"));
    expect(store.readSession("S").transcript.page.messages?.map((m) => m.msgId)).toEqual([
      "from-history",
    ]);
  });
});

describe("a context-only inspection reuses the history answer", () => {
  it("returns the cached page without reading again", async () => {
    const loads: string[] = [];
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: ({ id }) => {
        loads.push(id);
        return Promise.resolve(page("S-1"));
      },
    });
    await owner.loadPage("S");
    expect(loads).toEqual(["S"]);
    // The composer's context inspection asks for the same page; the owner answers
    // from its resource, so the switch costs nothing extra.
    await expect(owner.ensurePage("S")).resolves.toMatchObject({
      messages: [{ msgId: "S-1" }],
    });
    expect(loads).toEqual(["S"]);
  });

  it("joins one read when two readers need the same page at once", async () => {
    // The transcript opening a session and a context inspection asking for the
    // same page are two readers of one key. They share the request in flight
    // rather than one of them superseding the other.
    const loads: string[] = [];
    const releases: Array<(page: WebuiClientMessagePage) => void> = [];
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: ({ id }) => {
        loads.push(id);
        return new Promise<WebuiClientMessagePage>((resolve) => releases.push(resolve));
      },
    });
    const inspection = owner.ensurePage("S");
    const transcript = owner.loadPage("S");
    expect(loads).toEqual(["S"]);
    releases[0]!(page("S-1"));
    await expect(inspection).resolves.toMatchObject({ messages: [{ msgId: "S-1" }] });
    await expect(transcript).resolves.toMatchObject({ status: "applied" });
    expect(loads).toEqual(["S"]);
    expect(store.readSession("S").transcript.page.messages?.map((m) => m.msgId)).toEqual(["S-1"]);
  });
});
