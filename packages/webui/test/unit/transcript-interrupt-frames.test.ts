// SPEC-C item C-3 — "Stop, and sending after stop".
//
// C-3 was marked "not verified" by the roadmap. These tests drive the real
// product path with no DOM, exactly as `packages/webui/AGENTS.md` prescribes
// for `client/stream.ts` / `client/stream-loop.ts`: a shared `setStream`,
// one `buildWebuiStreamLoopSink(setStream)` per submit (what the composer
// does), `runWebuiStreamLoop` for the turn, and `stopWebuiTurn` for the
// interrupt.
//
// The two clauses under test:
//
//   1. Interrupting a turn preserves the order of already-received frames; a
//      frame that arrives after the interrupt does not splice itself before
//      them.
//   2. A message sent after a stop starts a new turn rather than resuming the
//      aborted one, and does not inherit the aborted turn's partial text.
//
// The mechanism the code relies on is the generation fence in
// `buildWebuiStreamLoopSink` (`mine()` compares `lastClaimedGeneration`),
// which `settleAbortedStream` clears. So every assertion below is made
// against the *shared* state the shell would render, not against a mock:
// a dropped frame is proven by the transcript, the cursor, and the phase
// all staying where the interrupt left them.

import { describe, expect, it } from "vitest";

import {
  initialWebuiStreamState,
  ownsWebuiStreamGeneration,
  stopWebuiTurn,
  type WebuiStreamState,
} from "../../src/client/stream.js";
import {
  buildWebuiStreamLoopSink,
  runWebuiStreamLoop,
  type WebuiStreamLoopSink,
} from "../../src/client/stream-loop.js";
import type { WebuiClientMessageSender } from "../../src/client/contracts.js";
import type { WebuiStreamFrame } from "../../src/shared/contracts/stream.js";

const SESSION_ID = "session-under-test";

/**
 * The React shell's binding, minus React: one shared state cell, one updater,
 * and a fresh sink per submit. `newSink()` mirrors the composer calling
 * `buildWebuiStreamLoopSink(setStream)` once per submit — each turn owns its
 * own sink instance, which is what makes the generation fence meaningful.
 */
function createShell() {
  let current: WebuiStreamState = initialWebuiStreamState;
  const setStream = (update: (current: WebuiStreamState) => WebuiStreamState): void => {
    current = update(current);
  };
  return {
    get state(): WebuiStreamState {
      return current;
    },
    setStream,
    newSink: (): WebuiStreamLoopSink => buildWebuiStreamLoopSink(setStream),
  };
}

const frame = (dataJson: string, cursor?: string): WebuiStreamFrame => ({
  dataJson,
  ...(cursor === undefined ? {} : { cursor }),
});

const wholeMessage = (id: string, content: string, cursor?: string): WebuiStreamFrame =>
  frame(
    JSON.stringify({ type: "agent_message", agent_message: { msg_id: id, msg_content: content } }),
    cursor,
  );

const chunk = (id: string, content: string, cursor?: string): WebuiStreamFrame =>
  frame(
    JSON.stringify({
      type: "agent_message_chunk",
      agent_message_chunk: { msg_id: id, msg_content: content },
    }),
    cursor,
  );

const done = (): WebuiStreamFrame => frame("[DONE]");

/**
 * A `sendMessage` that publishes `frames` and then stays open until the test
 * releases it, so the turn is genuinely mid-flight while the interrupt runs.
 */
function gatedSender(frames: readonly WebuiStreamFrame[]) {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const sent: { id: string; content: string }[] = [];
  const sender: WebuiClientMessageSender = async (request, onFrame) => {
    sent.push({ id: request.id, content: request.content });
    for (const published of frames) onFrame(published);
    await gate;
  };
  return { sender, sent, open: () => open() };
}

/** An immediately-resolving `sendMessage`, for the turn that follows a stop. */
function completingSender(frames: readonly WebuiStreamFrame[]) {
  const sent: { id: string; content: string }[] = [];
  const sender: WebuiClientMessageSender = async (request, onFrame) => {
    sent.push({ id: request.id, content: request.content });
    for (const published of frames) onFrame(published);
  };
  return { sender, sent };
}

const interrupt = (
  shell: ReturnType<typeof createShell>,
  sending: boolean[] = [],
): Promise<void> =>
  stopWebuiTurn({
    abortSession: async () => ({ success: true }),
    sessionId: SESSION_ID,
    setSending: (next) => sending.push(next),
    setStream: shell.setStream,
  });

/** Let the loop's synchronous prologue and pending microtasks run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const answerIds = (state: WebuiStreamState): string[] => state.messages.map((m) => m.id);

describe("C-3.1 interrupting a turn preserves the order of already-received frames", () => {
  it("drops a frame that arrives after the interrupt instead of splicing it into the transcript", async () => {
    const shell = createShell();
    const sink = shell.newSink();
    const { sender, open } = gatedSender([
      wholeMessage("msg-1", "第一段", "cursor-1"),
      chunk("msg-1", "第二段", "cursor-2"),
    ]);

    const loop = runWebuiStreamLoop(
      { sendMessage: sender },
      { sessionId: SESSION_ID, message: "第一个问题" },
      sink,
    );
    await tick();

    // Precondition: the turn is mid-flight and its partial answer is on screen
    // in the order the frames arrived.
    expect(shell.state.phase).toBe("streaming");
    expect(answerIds(shell.state)).toEqual(["msg-1"]);
    expect(shell.state.messages[0]?.answer).toBe("第一段第二段");
    expect(shell.state.cursor).toBe("cursor-2");

    const sending: boolean[] = [];
    await interrupt(shell, sending);
    expect(sending).toEqual([false]);
    expect(shell.state.phase).toBe("done");
    expect(shell.state.status).toBe("aborted");

    // A frame the server had already queued for the aborted turn. It must not
    // land: not as a new message, not as a cursor advance (that would move the
    // next turn's resume point), not as a phase change.
    sink.applyFrame(wholeMessage("msg-2", "迟到的回复", "cursor-3"));

    expect(answerIds(shell.state)).toEqual(["msg-1"]);
    expect(shell.state.messages[0]?.answer).toBe("第一段第二段");
    expect(shell.state.cursor).toBe("cursor-2");
    expect(shell.state.phase).toBe("done");
    expect(shell.state.status).toBe("aborted");

    open();
    await loop;
  });

  it("does not let a late chunk extend the aborted turn's partial text", async () => {
    const shell = createShell();
    const sink = shell.newSink();
    const { sender, open } = gatedSender([
      wholeMessage("msg-1", "已经写好的部分", "cursor-1"),
    ]);

    const loop = runWebuiStreamLoop(
      { sendMessage: sender },
      { sessionId: SESSION_ID, message: "第一个问题" },
      sink,
    );
    await tick();
    await interrupt(shell);

    sink.applyFrame(chunk("msg-1", "被中断后迟到的续写", "cursor-2"));

    expect(shell.state.messages).toHaveLength(1);
    expect(shell.state.messages[0]?.answer).toBe("已经写好的部分");
    expect(shell.state.cursor).toBe("cursor-1");

    open();
    await loop;
  });

  it("keeps the interrupted transcript intact when the aborted loop finally settles", async () => {
    const shell = createShell();
    const sink = shell.newSink();
    const { sender, open } = gatedSender([wholeMessage("msg-1", "被中断的回答", "cursor-1")]);

    const loop = runWebuiStreamLoop(
      { sendMessage: sender },
      { sessionId: SESSION_ID, message: "第一个问题" },
      sink,
    );
    await tick();
    await interrupt(shell);

    // The transport only reports success after the interrupt. The loop's own
    // terminal `done` commit must not overwrite the aborted settlement.
    open();
    const generation = await loop;

    expect(generation).toBeTypeOf("number");
    expect(shell.state.phase).toBe("done");
    expect(shell.state.status).toBe("aborted");
    expect(answerIds(shell.state)).toEqual(["msg-1"]);
    expect(shell.state.messages[0]?.answer).toBe("被中断的回答");
    // Its own post-loop cleanup is no longer its to do.
    expect(ownsWebuiStreamGeneration(shell.state, generation)).toBe(false);
  });

  it("ignores the aborted turn's late terminal frame once a new turn is streaming", async () => {
    const shell = createShell();
    const interruptedSink = shell.newSink();
    const { sender, open } = gatedSender([wholeMessage("msg-1", "被中断的回答", "cursor-1")]);

    const interrupted = runWebuiStreamLoop(
      { sendMessage: sender },
      { sessionId: SESSION_ID, message: "第一个问题" },
      interruptedSink,
    );
    await tick();
    await interrupt(shell);

    const nextSender = completingSender([wholeMessage("msg-2", "新的回答", "cursor-4")]);
    const next = runWebuiStreamLoop(
      { sendMessage: nextSender.sender },
      { sessionId: SESSION_ID, message: "第二个问题" },
      shell.newSink(),
    );
    await next;
    expect(shell.state.phase).toBe("done");

    // The second turn streams a further frame, then the first turn's terminal
    // frame arrives. It must not settle the second turn.
    const liveSink = shell.newSink();
    liveSink.claimSubscription?.("local-send");
    liveSink.applyFrame(chunk("msg-2", "补充", "cursor-5"));
    expect(shell.state.phase).toBe("streaming");
    expect(shell.state.messages[1]?.answer).toBe("新的回答补充");

    interruptedSink.applyFrame(done());
    expect(shell.state.phase).toBe("streaming");
    expect(answerIds(shell.state)).toEqual(["msg-1", "msg-2"]);

    open();
    await interrupted;
  });
});

describe("C-3.2 a message sent after a stop starts a new turn", () => {
  it("sends a new turn instead of resuming the aborted one", async () => {
    const shell = createShell();
    const first = gatedSender([wholeMessage("msg-1", "被中断的回答", "cursor-1")]);
    const interrupted = runWebuiStreamLoop(
      { sendMessage: first.sender },
      { sessionId: SESSION_ID, message: "第一个问题" },
      shell.newSink(),
    );
    await tick();
    await interrupt(shell);

    const resumes: { id: string; afterCursor?: string; afterMsgId?: string }[] = [];
    const second = completingSender([wholeMessage("msg-2", "新的回答", "cursor-2")]);
    const next = runWebuiStreamLoop(
      {
        sendMessage: second.sender,
        resumeSession: async (request) => {
          resumes.push({ id: request.id, afterCursor: request.afterCursor, afterMsgId: request.afterMsgId });
        },
      },
      { sessionId: SESSION_ID, message: "第二个问题" },
      shell.newSink(),
    );
    await next;

    // A second `sendMessage` for the new input, and no resume of the aborted
    // turn even though a cursor (`cursor-1`) was observed before the stop.
    expect(second.sent).toEqual([{ id: SESSION_ID, content: "第二个问题" }]);
    expect(resumes).toEqual([]);

    first.open();
    await interrupted;
  });

  it("does not inherit the aborted turn's partial text", async () => {
    const shell = createShell();
    const first = gatedSender([
      wholeMessage("msg-1", "这是被中断时的半截答案", "cursor-1"),
    ]);
    const interrupted = runWebuiStreamLoop(
      { sendMessage: first.sender },
      { sessionId: SESSION_ID, message: "第一个问题" },
      shell.newSink(),
    );
    await tick();
    await interrupt(shell);

    const second = completingSender([chunk("msg-2", "全新的回答", "cursor-2")]);
    await runWebuiStreamLoop(
      { sendMessage: second.sender },
      { sessionId: SESSION_ID, message: "第二个问题" },
      shell.newSink(),
    );

    // The aborted turn keeps its own (partial) message, unchanged and in
    // place; the new turn's answer is its own text, not a continuation.
    expect(answerIds(shell.state)).toEqual(["msg-1", "msg-2"]);
    expect(shell.state.messages[0]?.answer).toBe("这是被中断时的半截答案");
    expect(shell.state.messages[1]?.answer).toBe("全新的回答");
    expect(shell.state.messages[1]?.answer.startsWith("这是被中断时的半截答案")).toBe(false);
    expect(shell.state.cursor).toBe("cursor-2");

    first.open();
    await interrupted;
  });

  it("fences the aborted turn's late cleanup out of the turn that replaced it", async () => {
    const shell = createShell();
    const firstSink = shell.newSink();
    const first = gatedSender([wholeMessage("msg-1", "被中断的回答", "cursor-1")]);
    const interrupted = runWebuiStreamLoop(
      { sendMessage: first.sender },
      { sessionId: SESSION_ID, message: "第一个问题" },
      firstSink,
    );
    await tick();
    const firstGeneration = shell.state.lastClaimedGeneration;
    await interrupt(shell);

    const secondSink = shell.newSink();
    const second = gatedSender([wholeMessage("msg-2", "新的回答", "cursor-2")]);
    const secondLoop = runWebuiStreamLoop(
      { sendMessage: second.sender },
      { sessionId: SESSION_ID, message: "第二个问题" },
      secondSink,
    );
    await tick();

    // A distinct claim, held by the new turn for as long as it is live.
    expect(second.sent).toEqual([{ id: SESSION_ID, content: "第二个问题" }]);
    expect(shell.state.subscription?.owner).toBe("local-send");
    expect(shell.state.subscription?.generation).not.toBe(firstGeneration);
    const nextGeneration = shell.state.lastClaimedGeneration;
    expect(nextGeneration).toBeTypeOf("number");
    expect(shell.state.subscription?.generation).toBe(nextGeneration);

    // The new turn owns the post-loop cleanup; the interrupted one lost it.
    expect(ownsWebuiStreamGeneration(shell.state, nextGeneration)).toBe(true);
    expect(ownsWebuiStreamGeneration(shell.state, firstGeneration)).toBe(false);

    // The interrupted loop resolving late must not disturb the new turn, and
    // the new turn still releases its own lease when it completes.
    first.open();
    await interrupted;
    expect(shell.state.subscription?.generation).toBe(nextGeneration);
    expect(answerIds(shell.state)).toEqual(["msg-1", "msg-2"]);
    expect(shell.state.messages[1]?.answer).toBe("新的回答");

    second.open();
    expect(await secondLoop).toBe(nextGeneration);
    expect(shell.state.subscription).toBeUndefined();
    expect(shell.state.lastClaimedGeneration).toBe(nextGeneration);
  });
});
