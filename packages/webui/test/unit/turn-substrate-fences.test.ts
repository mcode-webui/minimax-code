// The four fences `turn`'s substrate rests on.
//
// These are behavioural assertions of the *mechanism*, not the four business
// boundary rules — a fence asserts that a mechanism holds; a boundary rule
// asserts that one business cannot write another's state. Carrying the fences
// here does not close the business-boundary coverage, which each business
// discharges in its own prohibition test.
//
// The four, each with the assertion that pins it:
//
//   1. **the stream lease** — the lease is claimed *before* the turn opens, on
//      both entry paths (attach claims as `recovered` with the turn it knows; a
//      local send claims as `local-send`), so the `session.start` the runtime
//      publishes for our own turn finds an owner instead of a second stream.
//   2. **the generation guard** — a superseded attempt's frames, phase writes
//      and refusal produce zero state writes, because the fence is bound to the
//      generation the sink claimed.
//   3. **the cursor `resume`/`resync` transition** — a mid-stream drop with an
//      observed cursor resumes with `afterCursor`; a `resume_overflow` frame
//      takes the other branch, reloading history and starting a fresh
//      subscription with no cursor.
//   4. **the early-exit finalizer** — an early return on the absent-capability
//      path releases ownership through the *raw* sink exactly once and reports a
//      failure carrying the reason, instead of leaving a "thinking" spinner
//      behind.
//
// Every case drives `runWebuiStreamLoop` against the real store and the real
// sink (`buildWebuiStreamLoopSink`), so the lease's visible effect — the
// `subscription` field other bindings read — is what the assertions observe.

import { describe, expect, it, vi } from "vitest";

import { runWebuiStreamLoop } from "../../src/client/conversation/stream-loop.js";
import type { WebuiDeliverySink, WebuiDeliveryFailure } from "../../src/shared/contracts/delivery.js";
import { buildWebuiStreamLoopSink } from "../../src/client/features/turn/application/stream-loop-sink.js";
import { classifyStreamFrame } from "../../src/client/features/turn/application/stream-frame-classify.js";
import { streamStateBundle } from "../../src/client/features/turn/application/stream-state-bundle.js";
import {
  createWebuiSessionStore,
  type WebuiSessionStore,
} from "../../src/client/application/session-store.js";
import type {WebuiClientMessageSender} from "../../src/client/features/turn/contracts/execution-port.js";
import type {WebuiClientSessionResumer} from "../../src/client/features/turn/contracts/execution-port.js";
import type { WebuiStreamFrame } from "../../src/shared/contracts/stream.js";

const SESSION_ID = "session-fences";

/** The history reader the loop hands to the sink as a raw page. */
type HistoryLoader = (request: { readonly id: string }) => Promise<unknown>;

/** The store, the sink built from its writer, and a reader for the live slice. */
function harness(sessionId = SESSION_ID) {
  const store: WebuiSessionStore = createWebuiSessionStore();
  const writer = store.createSessionWriter({ kind: "session", sessionId });
  return {
    store,
    writer,
    newSink: (): WebuiDeliverySink =>
      buildWebuiStreamLoopSink(writer.setStream, streamStateBundle),
    stream: () => store.readSession(sessionId).stream,
  };
}

/** The transports the loop must be handed, plus the one classifier it needs. */
const loopDeps = (extra: {
  sendMessage?: WebuiClientMessageSender;
  resumeSession?: WebuiClientSessionResumer;
  loadHistory?: HistoryLoader;
}) => ({
  ...extra,
  classify: classifyStreamFrame,
});

/** A send that never settles: the loop stays inside the open subscription. */
const pendingSend = (): WebuiClientMessageSender =>
  vi.fn(() => new Promise<void>(() => {}));

describe("fence 1 — the stream lease is claimed before the turn opens", () => {
  it("claims as `recovered` with the attached turn, visible on the slice at once", async () => {
    const shell = harness();
    const resumeSession: WebuiClientSessionResumer = vi.fn(
      () => new Promise<void>(() => {}),
    );
    void runWebuiStreamLoop(
      loopDeps({ resumeSession }),
      { sessionId: SESSION_ID, attachId: "turn-9" },
      shell.newSink(),
    );
    // Claimed synchronously, before the first await: a `session.start` for this
    // turn arriving now finds an owner rather than starting a second stream.
    expect(shell.stream().subscription).toMatchObject({
      owner: "recovered",
      turnId: "turn-9",
    });
    expect(shell.stream().phase).toBe("streaming");
  });

  it("anchors persisted thinking before applying a resumed thinking chunk", async () => {
    const shell = harness();
    const history = {
      messages: [
        { msgId: "msg-user-1", role: "user", msgContent: "Question" },
        {
          msgId: "assistant-1",
          role: "assistant",
          msgContent: "Answer so far",
          thinkingContent: "Reasoning so far",
        },
      ],
    };
    const resumeSession: WebuiClientSessionResumer = vi.fn(async (_request, onFrame) => {
      onFrame({
        dataJson: JSON.stringify({
          type: "agent_message_chunk",
          agent_message_chunk: {
            msg_id: "assistant-1",
            msg_content: " and continued",
            thinking_content: " and continued reasoning",
          },
        }),
      });
      onFrame({ dataJson: "[DONE]" });
    });

    await runWebuiStreamLoop(
      loopDeps({
        resumeSession,
        loadHistory: async () => history,
      }),
      { sessionId: SESSION_ID, attachId: "turn-1" },
      shell.newSink(),
    );

    expect(shell.stream().messages).toMatchObject([
      { id: "msg-user-1", answer: "Question", thinking: "" },
      {
        id: "assistant-1",
        answer: "Answer so far and continued",
        thinking: "Reasoning so far and continued reasoning",
      },
    ]);
  });

  it("claims as `local-send` with no turn id, because the runtime names the turn later", async () => {
    const shell = harness();
    void runWebuiStreamLoop(
      loopDeps({ sendMessage: pendingSend() }),
      { sessionId: SESSION_ID, message: "hello" },
      shell.newSink(),
    );
    expect(shell.stream().subscription).toMatchObject({ owner: "local-send" });
    expect(shell.stream().subscription?.turnId).toBeUndefined();
  });
});

describe("fence 2 — the generation guard drops a superseded attempt's writes", () => {
  it("lets only the newest claimer write frames, phases and refusal", () => {
    const shell = harness();
    const stale = shell.newSink();
    const live = shell.newSink();
    stale.claim("local-send");
    live.claim("local-send");

    stale.accept({ dataJson: '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":"stale"}}' });
    expect(shell.stream().messages).toHaveLength(0);

    live.accept({ dataJson: '{"type":6,"agent_message_chunk":{"msg_id":"m2","msg_content":"live"}}' });
    expect(shell.stream().messages).toHaveLength(1);

    // Every write the superseded sink still attempts is dropped: a late frame,
    // a wholesale message replacement, a completion and a refusal. The live
    // turn's transcript and phase are untouched.
    const liveBefore = shell.stream();
    stale.accept({ dataJson: '{"type":6,"agent_message_chunk":{"msg_id":"m3","msg_content":"late"}}' });
    stale.replace({ messages: [] });
    expect(shell.stream().messages).toHaveLength(1);
    expect(shell.stream().messages).toEqual(liveBefore.messages);

    // A late completion and a late refusal from the superseded attempt must not
    // stamp themselves over the turn that replaced it.
    stale.complete();
    stale.fail({ origin: "transport", reason: "late failure", acceptedFrames: 1 });
    expect(shell.stream().phase).not.toBe("done");
    expect(shell.stream().phase).not.toBe("refused");
    expect(shell.stream().refusal).toBeUndefined();
  });

  it("is bound to the lease mechanism's single generation counter", () => {
    const shell = harness();
    const first = shell.newSink();
    const second = shell.newSink();
    const a = first.claim("local-send");
    const b = second.claim("local-send");
    expect(a).toBeTypeOf("number");
    expect(b).toBeTypeOf("number");
    expect(b).toBeGreaterThan(a as number);
    // Re-claiming on the same sink hands back the generation it already owns
    // rather than minting a new one and re-stamping the fence.
    expect(first.claim("local-send")).toBe(a);
    expect(shell.stream().lastClaimedGeneration).toBe(b);
  });
});

describe("fence 3 — the cursor resume/resync transition", () => {
  it("resumes with the cursor it observed when the socket drops mid-stream", async () => {
    const shell = harness();
    const resumeCalls: { afterCursor?: string }[] = [];
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_req, onFrame) => {
      onFrame({ dataJson: "{}", cursor: "c1" });
      throw new Error("connection closed before [DONE]");
    });
    const resumeSession: WebuiClientSessionResumer = vi.fn(async (req, onFrame) => {
      resumeCalls.push({ afterCursor: req.afterCursor });
      onFrame({ dataJson: "[DONE]" });
    });

    await runWebuiStreamLoop(
      loopDeps({ sendMessage, resumeSession }),
      { sessionId: SESSION_ID, message: "hello" },
      shell.newSink(),
    );

    expect(resumeCalls).toEqual([{ afterCursor: "c1" }]);
    expect(shell.stream().phase).toBe("done");
  });

  it("takes the resync branch on a resume_overflow frame: reload, then subscribe with no cursor", async () => {
    const shell = harness();
    const resumeCalls: { afterCursor?: string }[] = [];
    let loads = 0;
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_req, onFrame) => {
      onFrame({ dataJson: "{}", cursor: "c-stale" });
      onFrame({ dataJson: '{"type":"resume_overflow"}' });
      onFrame({ dataJson: "[DONE]" });
    });
    const resumeSession: WebuiClientSessionResumer = vi.fn(async (req, onFrame) => {
      resumeCalls.push({ afterCursor: req.afterCursor });
      onFrame({ dataJson: "[DONE]" });
    });
    const loadHistory: HistoryLoader = vi.fn(async () => {
      loads += 1;
      return { messages: [], hasMore: false };
    });

    await runWebuiStreamLoop(
      loopDeps({ sendMessage, resumeSession, loadHistory }),
      { sessionId: SESSION_ID, message: "hello" },
      shell.newSink(),
    );

    expect(loads).toBe(1);
    expect(resumeCalls).toEqual([{ afterCursor: undefined }]);
    expect(shell.stream().phase).toBe("done");
  });
});

describe("fence 4 — the early-exit finalizer releases ownership once and states the reason", () => {
  it("releases through the raw sink exactly once on the absent-capability exit", async () => {
    const shell = harness();
    let releases = 0;
    const refusals: string[] = [];
    const inner = shell.newSink();
    const sink: WebuiDeliverySink = {
      ...inner,
      release: () => {
        releases += 1;
        inner.release();
      },
      fail: (failure: WebuiDeliveryFailure) => {
        refusals.push(failure.reason);
        inner.fail(failure);
      },
    };

    // The attach path with no `resumeSession`: the finalizer is the only
    // thing standing between the user and a spinner that never stops.
    await runWebuiStreamLoop(
      loopDeps({}),
      { sessionId: SESSION_ID, attachId: "turn-1" },
      sink,
    );

    expect(releases).toBe(1);
    expect(refusals).toEqual(["resumeSession transport is unavailable"]);
    expect(shell.stream().phase).toBe("refused");
    expect(shell.stream().refusal).toBe("resumeSession transport is unavailable");
    // The lease is gone, so the next `session.start` attaches instead of
    // colliding with a dead owner. The generation stamp stays, so the released
    // attempt still cannot write.
    expect(shell.stream().subscription).toBeUndefined();
  });

  it("releases through the raw sink even when a wrapped callback already threw", async () => {
    const shell = harness();
    let releases = 0;
    const inner = shell.newSink();
    const sink: WebuiDeliverySink = {
      ...inner,
      accept: () => {
        throw new Error("sink write failed");
      },
      release: () => {
        releases += 1;
        inner.release();
      },
    };
    const resumeSession: WebuiClientSessionResumer = vi.fn(async (_req, onFrame) => {
      onFrame({ dataJson: '{"type":10}' });
    });

    await runWebuiStreamLoop(
      loopDeps({ resumeSession }),
      { sessionId: SESSION_ID, attachId: "turn-2" },
      sink,
    );

    // Cleanup is not a render path: it must survive the failure-containment
    // rule that makes every other callback inert after the first throw.
    expect(releases).toBe(1);
    expect(shell.stream().phase).toBe("refused");
    expect(shell.stream().subscription).toBeUndefined();
  });
});

/**
 * What a user is told depends on *where* an attempt failed, not on how far it
 * got. This is the one judgement the loop deliberately refuses to make: it knows
 * both facts — which kind of failure it was, and how many frames the aggregate
 * had accepted — and reports them without interpreting either. The adapter, which
 * owns the record, turns them into the flag the shell renders.
 *
 * The contrast is the point, so every case below drives the **real** sink and
 * fails *after* frames have landed in the store. A case that failed before any
 * frame would pass under either reading.
 */
describe("failure origin decides what the user is told", () => {
  const chunkFor = (id: string, text: string, cursor?: string) => ({
    dataJson: JSON.stringify({
      type: "agent_message_chunk",
      agent_message_chunk: { msg_id: id, msg_content: text },
    }),
    ...(cursor === undefined ? {} : { cursor }),
  });

  it("marks the transcript incomplete when the aggregate itself fails after frames", async () => {
    const shell = harness();
    const inner = shell.newSink();
    let accepts = 0;
    const sink: WebuiDeliverySink = {
      ...inner,
      accept: (frame: WebuiStreamFrame) => {
        accepts += 1;
        // The first two frames reach the store; the third is what the user will
        // never see, because the write that would have shown it broke.
        if (accepts >= 3) throw new Error("third accept blew up");
        inner.accept(frame);
      },
    };
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_req, onFrame) => {
      onFrame(chunkFor("m1", "first", "c1"));
      onFrame(chunkFor("m1", " second", "c2"));
      onFrame(chunkFor("m1", " third"));
      onFrame({ dataJson: "[DONE]" });
    });

    await runWebuiStreamLoop(
      loopDeps({ sendMessage }),
      { sessionId: SESSION_ID, message: "hello" },
      sink,
    );

    expect(shell.stream().phase).toBe("refused");
    expect(shell.stream().transcriptIncomplete).toBe(true);
    expect(shell.stream().messages[0]?.answer).toBe("first second");
  });

  it("stays an ordinary refusal when the transport drops after frames", async () => {
    const shell = harness();
    // No cursor on any frame: a drop here is not resumable, so the attempt ends
    // as a transport failure with two frames already on screen.
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_req, onFrame) => {
      onFrame(chunkFor("m1", "first"));
      onFrame(chunkFor("m1", " second"));
      throw new Error("connection closed before [DONE]");
    });

    await runWebuiStreamLoop(
      loopDeps({ sendMessage }),
      { sessionId: SESSION_ID, message: "hello" },
      shell.newSink(),
    );

    expect(shell.stream().phase).toBe("refused");
    expect(shell.stream().refusal).toBe("connection closed before [DONE]");
    // Everything the turn produced before the drop did arrive, so nothing is
    // missing from the transcript and the flag must stay down.
    expect(shell.stream().transcriptIncomplete).toBe(false);
    expect(shell.stream().messages[0]?.answer).toBe("first second");
  });

  it("stays an ordinary refusal when reloading history fails after frames", async () => {
    const shell = harness();
    // A `resume_overflow` after a frame sends the attempt down the resync path;
    // the reload then fails, which leaves the last good transcript visible.
    const sendMessage: WebuiClientMessageSender = vi.fn(async (_req, onFrame) => {
      onFrame(chunkFor("m1", "first", "c1"));
      onFrame({ dataJson: '{"type":"resume_overflow"}' });
      onFrame({ dataJson: "[DONE]" });
    });
    const loadHistory: HistoryLoader = vi.fn(async () => {
      throw new Error("history unavailable");
    });

    await runWebuiStreamLoop(
      loopDeps({ sendMessage, loadHistory, resumeSession: vi.fn() }),
      { sessionId: SESSION_ID, message: "hello" },
      shell.newSink(),
    );

    expect(shell.stream().phase).toBe("refused");
    expect(shell.stream().refusal).toBe("history unavailable");
    expect(shell.stream().transcriptIncomplete).toBe(false);
    expect(shell.stream().messages[0]?.answer).toBe("first");
  });
});
