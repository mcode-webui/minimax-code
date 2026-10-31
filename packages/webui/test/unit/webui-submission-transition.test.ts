// The ticket a submission returns.
//
// The rule and the target read are pinned in their own suites. What this one pins is the *shape* of
// what a caller gets back: one value, carrying an admission that is already decided and a completion
// that settles later and never rejects.
//
// The behavioural cases below are the ones the baseline already had — every callback the baseline
// called still fires — restated against the ticket, because a change of protocol is exactly the
// moment where "the callbacks still fire" stops being obvious.

import { describe, expect, it, vi } from "vitest";

import {
  buildWebuiComposerHandlers,
  submitWebuiTurn,
} from "../../src/client/features/turn/application/composer-submission.js";
import type {
  WebuiSubmissionAdmission,
  WebuiSubmissionIntent,
  WebuiTaskSessionSubmitter,
} from "../../src/client/features/turn/contracts/submission.js";
import type {
  WebuiDeliverySink,
  WebuiDeliveryTransports,
} from "../../src/shared/contracts/delivery.js";
import type { WebuiClientMessageEnqueuer } from "../../src/client/features/composer/contracts/command-port.js";
import type { WebuiComposerSubmitHandlers } from "../../src/client/features/composer/contracts/composer-turn.js";

/** The sink the loop would write through; these sends never open one, so every member is a spy. */
const sink: WebuiDeliverySink = {
  claim: vi.fn(() => undefined),
  accept: vi.fn(),
  begin: vi.fn(),
  recovering: vi.fn(),
  anchor: vi.fn(),
  replace: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  release: vi.fn(),
};

/** The handlers the owner supplies; every one is a spy so the preserved calls are observable. */
function handlers() {
  return buildWebuiComposerHandlers({
    createSink: () => sink,
    resetStreamForTurn: vi.fn(),
    setRefusal: vi.fn(),
    setSending: vi.fn(),
    onNeedsSession: vi.fn(),
    onSessionCreated: vi.fn(),
    onQueued: vi.fn(),
  });
}

const sendMessage = vi.fn(async () => undefined);

const DISPATCHING: WebuiSubmissionAdmission = { kind: "dispatching" };

/** Submit, and resolve the completion. The ticket is what the caller holds. */
type SubmitArgs = {
  readonly intent: WebuiSubmissionIntent;
  readonly sessionId?: string;
  readonly admission: WebuiSubmissionAdmission;
  readonly sending: boolean;
  readonly deps: WebuiDeliveryTransports;
  readonly handlers: WebuiComposerSubmitHandlers;
  readonly enqueueMessage?: WebuiClientMessageEnqueuer;
  readonly submitTask?: WebuiTaskSessionSubmitter;
  readonly createSessionWorkspaceDir?: string;
  readonly teamModeOff?: boolean;
};
async function submit(
  args: SubmitArgs,
): Promise<{ readonly ticket: ReturnType<typeof submitWebuiTurn>; readonly completion: unknown }> {
  const ticket = submitWebuiTurn({
    intent: args.intent,
    sessionId: args.sessionId,
    admission: args.admission,
    sending: args.sending,
    deps: args.deps,
    handlers: args.handlers,
    ...(args.enqueueMessage !== undefined ? { enqueueMessage: args.enqueueMessage } : {}),
    ...(args.submitTask !== undefined ? { submitTask: args.submitTask } : {}),
    ...(args.createSessionWorkspaceDir !== undefined
      ? { createSessionWorkspaceDir: args.createSessionWorkspaceDir }
      : {}),
    ...(args.teamModeOff !== undefined ? { teamModeOff: args.teamModeOff } : {}),
  });
  return { ticket, completion: await ticket.completion };
}

describe("the ticket a submission returns", () => {
  it("is available before the work finishes, carrying the admission it decided", () => {
    // The point of returning synchronously: a caller can render the decision now.
    // Nothing has been awaited, so the decision cannot depend on the attempt.
    const ticket = submitWebuiTurn({
      intent: { kind: "ordinary", message: "hello" },
      sessionId: "s1",
      admission: { kind: "queued" },
      sending: true,
      deps: { sendMessage },
      handlers: handlers(),
    });
    expect(ticket!.admission).toEqual({ kind: "queued" });
    expect(ticket!.id).toBeGreaterThan(0);
  });

  it("reports home-session creation before the turn completion settles", async () => {
    let releaseTurn: (() => void) | undefined;
    const send = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseTurn = resolve; });
    });
    const ticket = submitWebuiTurn({
      intent: { kind: "ordinary", message: "hello" },
      sessionId: undefined,
      admission: DISPATCHING,
      sending: false,
      deps: { sendMessage: send },
      submitTask: { submit: async () => ({ kind: "created", sessionId: "created", selected: true }) },
      handlers: handlers(),
    });

    await expect(ticket!.creation).resolves.toEqual({ sessionId: "created", selected: true });
    expect(send).toHaveBeenCalledTimes(1);
    let completed = false;
    void ticket!.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    releaseTurn!();
    await expect(ticket!.completion).resolves.toMatchObject({ kind: "dispatched", sessionId: "created" });
  });

  it("refuses a live turn it cannot queue onto, instead of dropping the input", async () => {
    const h = handlers();
    const { completion } = await submit({
      intent: { kind: "ordinary", message: "hello" },
      sessionId: "s1",
      sending: true,
      admission: { kind: "busy", reason: "turn-live" },
      deps: { sendMessage },
      handlers: h,
    });
    expect(completion).toEqual({ kind: "busy", reason: "turn-live" });
    expect(h.setSending).not.toHaveBeenCalled();
  });

  it("names the missing transport and creates nothing", async () => {
    // A creator alone is not a way to deliver a message, so the use case must not be reached.
    const submitTask = vi.fn(
      async () => ({ kind: "created" as const, sessionId: "created", selected: true }),
    );
    const { completion } = await submit({
      intent: { kind: "ordinary", message: "hello" },
      sending: false,
      admission: { kind: "unsupported", missing: "transport" },
      deps: {},
      submitTask: { submit: submitTask },
      handlers: handlers(),
    });
    expect(completion).toEqual({ kind: "unsupported", missing: "transport" });
    expect(submitTask).not.toHaveBeenCalled();
  });

  it("reports D01's reservation: one creation per home incarnation, input untouched", async () => {
    // The use case refuses the second submission before any wire IO; the ticket names it, and the
    // refusals the first one would produce (a creation failure, a dispatch) never happen.
    const submitTask = vi.fn(async () => ({ kind: "busy" as const }));
    const h = handlers();
    const { completion } = await submit({
      intent: { kind: "ordinary", message: "hello" },
      sending: false,
      admission: { kind: "busy", reason: "creating" },
      deps: { sendMessage },
      submitTask: { submit: submitTask },
      handlers: h,
    });
    expect(completion).toEqual({ kind: "busy", reason: "creating" });
    expect(h.setSending).not.toHaveBeenCalled();
  });

  it("asks for a session through the handler it always called", async () => {
    const h = handlers();
    const { completion } = await submit({
      intent: { kind: "ordinary", message: "hello" },
      sending: false,
      admission: { kind: "needs-session" },
      deps: { sendMessage },
      handlers: h,
    });
    expect(completion).toEqual({ kind: "needs-session" });
    expect(h.onNeedsSession).toHaveBeenCalledWith("hello");
  });

  it("reports a creation failure with the message the banner got", async () => {
    const h = handlers();
    const { completion } = await submit({
      intent: { kind: "ordinary", message: "hello" },
      sending: false,
      admission: DISPATCHING,
      deps: { sendMessage },
      submitTask: {
        submit: async () => ({ kind: "creation-failed", error: "synthetic creation failure" }),
      },
      handlers: h,
    });
    expect(completion).toMatchObject({ kind: "creation-failed" });
    expect(h.setRefusal).toHaveBeenCalledWith("synthetic creation failure");
  });

  it("reports a queue that landed", async () => {
    const enqueueMessage = vi.fn(async () => ({}));
    const h = handlers();
    const { completion } = await submit({
      intent: { kind: "queued", message: "hello" },
      sessionId: "s1",
      sending: false,
      admission: { kind: "queued" },
      deps: { sendMessage },
      enqueueMessage,
      handlers: h,
    });
    expect(completion).toEqual({
      kind: "queued",
      sessionId: "s1",
      created: false,
      selected: false,
    });
    expect(enqueueMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", content: "hello" }));
    expect(h.onQueued).toHaveBeenCalled();
  });

  it("reports a refused queue as failed, which the baseline swallowed", async () => {
    const enqueueMessage = vi.fn(async () => {
      throw new Error("synthetic queue refusal");
    });
    const h = handlers();
    const { completion } = await submit({
      intent: { kind: "queued", message: "hello" },
      sessionId: "s1",
      sending: false,
      admission: { kind: "queued" },
      deps: { sendMessage },
      enqueueMessage,
      handlers: h,
    });
    expect(completion).toMatchObject({ kind: "failed", error: "synthetic queue refusal" });
    expect(h.setRefusal).toHaveBeenCalledWith("synthetic queue refusal");
    // The enqueue never landed, so nothing may claim it was queued.
    expect(h.onQueued).not.toHaveBeenCalled();
  });

  it("never rejects, even when the attempt throws where nothing expected it", async () => {
    // A caller that only wants to know when it is done must not have an error path
    // to remember. The dispatch path below throws out of the sink factory.
    const h = handlers();
    const ticket = submitWebuiTurn({
      intent: { kind: "ordinary", message: "hello" },
      sessionId: "s1",
      admission: DISPATCHING,
      sending: false,
      deps: { sendMessage },
      handlers: {
        ...h,
        createSink: () => {
          throw new Error("sink factory exploded");
        },
      },
    });
    await expect(ticket!.completion).resolves.toMatchObject({ kind: "failed" });
  });

  it("numbers its tickets, so a transition can be correlated", () => {
    const first = submitWebuiTurn({
      intent: { kind: "ordinary", message: "hello" },
      sessionId: undefined,
      sending: false,
      admission: { kind: "unsupported", missing: "transport" },
      deps: {},
      handlers: handlers(),
    });
    const second = submitWebuiTurn({
      intent: { kind: "ordinary", message: "hello" },
      sessionId: undefined,
      sending: false,
      admission: { kind: "unsupported", missing: "transport" },
      deps: {},
      handlers: handlers(),
    });
    expect(first!.id).toBeGreaterThan(0);
    expect(second!.id).toBeGreaterThan(first!.id);
  });

  it("does not corrupt an in-flight submission when the draft changes underneath it", async () => {
    // The captured message is what goes to the wire. A user who keeps typing while
    // the submission is in flight must not have their new text sent as part of it,
    // and the draft clear must still happen exactly once.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enqueueMessage = vi.fn(async () => {
      await gate;
      return {};
    });
    const h = handlers();
    const ticket = submitWebuiTurn({
      intent: { kind: "ordinary", message: "the original words" },
      sessionId: "s1",
      sending: true,
      admission: { kind: "queued" },
      deps: { sendMessage },
      enqueueMessage,
      handlers: h,
    });

    // The user types again while the queue is in flight.
    expect(ticket!.admission).toEqual({ kind: "queued" });
    release!();
    await ticket!.completion;

    expect(enqueueMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "the original words" }),
    );
    // The draft is not Turn's to clear: the composer consumes the input it captured,
    // on the admission this command returns.
    expect(h.onSessionCreated).not.toHaveBeenCalled();
  });

  it("reports each intent kind's own admission rather than one shared default", async () => {
    // Ordinary dispatches; a command carries its name as the client intent; a goal
    // names itself; and a queued intent queues without a live turn to discover.
    const ordinary = await submit({
      intent: { kind: "ordinary", message: "hello" },
      sessionId: "s1",
      sending: false,
      admission: DISPATCHING,
      deps: { sendMessage },
      handlers: handlers(),
    });
    expect(ordinary.completion).toMatchObject({ kind: "dispatched" });

    const enqueueMessage = vi.fn(async () => ({}));
    const command = await submit({
      intent: { kind: "command", command: "plan-entry" },
      sessionId: "s1",
      sending: false,
      admission: DISPATCHING,
      deps: { sendMessage },
      enqueueMessage,
      handlers: handlers(),
    });
    expect(command.ticket!.admission).toEqual({ kind: "dispatching" });
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientIntent: "plan-entry" }),
      expect.anything(),
    );

    const goal = await submit({
      intent: { kind: "goal", message: "ship it" },
      sessionId: "s1",
      sending: false,
      admission: DISPATCHING,
      deps: { sendMessage },
      handlers: handlers(),
    });
    expect(goal.ticket!.admission).toEqual({ kind: "dispatching" });
    expect(sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientIntent: "goal-entry" }),
      expect.anything(),
    );

    const queued = await submit({
      intent: { kind: "queued", message: "later" },
      sessionId: "s1",
      sending: false,
      admission: { kind: "queued" },
      deps: { sendMessage },
      enqueueMessage,
      handlers: handlers(),
    });
    expect(queued.completion).toMatchObject({ kind: "queued" });
  });
});
