// Reading a submission target's live state.
//
// The rule in `submission-admission.ts` is already pinned; this pins where its inputs come from. The
// cases that matter are the ones a copy-paste bug would get wrong: that a home submission reads the
// *home* record's own `sending`, that the reservation belongs to home submissions only, and that the
// capability answers come from the cut slice rather than a second source.

import { describe, expect, it, vi } from "vitest";

import {
  classifyWebuiSubmission,
  readWebuiSubmissionAdmissionState,
  type WebuiExecutionObservationDeps,
} from "../../src/client/features/turn/application/execution-target.js";
import { WEBUI_HOME_SESSION_KEY } from "../../src/client/application/state.js";

/** A fully wired host: it can send, queue and create, and nothing is running. */
function host(overrides: Partial<WebuiExecutionObservationDeps> = {}): {
  readonly deps: WebuiExecutionObservationDeps;
  readonly readSession: ReturnType<typeof vi.fn>;
} {
  const readSession = vi.fn(() => ({ sending: false }));
  return {
    readSession,
    deps: {
      store: { readSession },
      capabilities: {
        send: async () => undefined,
        enqueue: async () => ({}),
        createSession: async () => ({ sessionId: "created-A" }),
      },
      taskSessions: { creationPending: () => false },
      ...overrides,
    },
  };
}

describe("the target's state comes from the record the commands use", () => {
  it("reads the home record when the submission has no session", () => {
    // The same key the turn commands read (`sessionId ?? WEBUI_HOME_SESSION_KEY`): a home submission
    // must not look at a session it does not have yet.
    const { deps, readSession } = host();
    readWebuiSubmissionAdmissionState(deps, {});
    expect(readSession).toHaveBeenCalledWith(WEBUI_HOME_SESSION_KEY);
  });

  it("reads the target session's own record", () => {
    const { deps, readSession } = host();
    readWebuiSubmissionAdmissionState(deps, { sessionId: "session-A" });
    expect(readSession).toHaveBeenCalledWith("session-A");
  });

  it("takes a live turn from the record's sending flag", () => {
    const { deps } = host({
      store: { readSession: () => ({ sending: true }) },
    });
    expect(readWebuiSubmissionAdmissionState(deps, { sessionId: "session-A" }).turnLive).toBe(true);
    expect(readWebuiSubmissionAdmissionState(deps, {}).turnLive).toBe(true);
  });

  it("takes the capability answers from the cut slice", () => {
    const empty = host({ capabilities: {} });
    const state = readWebuiSubmissionAdmissionState(empty.deps, {});
    expect(state).toMatchObject({
      canSend: false,
      canEnqueue: false,
      canCreateSession: false,
      hasSession: false,
    });
  });
});

describe("D01: the reservation belongs to a home submission", () => {
  it("classifies a home submission while a creation is in flight as busy", () => {
    // One create, and the second submission leaves its input alone.
    const { deps } = host({ taskSessions: { creationPending: () => true } });
    expect(classifyWebuiSubmission(deps, {})).toEqual({ kind: "busy", reason: "creating" });
  });

  it("does not let a pending home creation block a session target", () => {
    // The reservation is per home incarnation; a session target is not waiting on a creation.
    const { deps } = host({ taskSessions: { creationPending: () => true } });
    expect(readWebuiSubmissionAdmissionState(deps, { sessionId: "session-A" }).creating).toBe(false);
    expect(classifyWebuiSubmission(deps, { sessionId: "session-A" })).toEqual({
      kind: "dispatching",
    });
  });

  it("treats a host with no creation use case as having no reservation", () => {
    const { deps } = host({ taskSessions: undefined });
    expect(readWebuiSubmissionAdmissionState(deps, {}).creating).toBe(false);
  });
});

describe("the classification a caller sees", () => {
  it("dispatches a first home message", () => {
    const { deps } = host();
    expect(classifyWebuiSubmission(deps, {})).toEqual({ kind: "dispatching" });
  });

  it("queues onto a live turn, and is busy when it cannot queue", () => {
    const live = host({ store: { readSession: () => ({ sending: true }) } });
    expect(classifyWebuiSubmission(live.deps, { sessionId: "session-A" })).toEqual({
      kind: "queued",
    });
    const queueLess = host({
      store: { readSession: () => ({ sending: true }) },
      capabilities: { send: async () => undefined },
    });
    expect(classifyWebuiSubmission(queueLess.deps, { sessionId: "session-A" })).toEqual({
      kind: "busy",
      reason: "turn-live",
    });
  });

  it("asks for a session when the host cannot create one", () => {
    const { deps } = host({ capabilities: { send: async () => undefined } });
    expect(classifyWebuiSubmission(deps, {})).toEqual({ kind: "needs-session" });
  });

  it("refuses a host with no transport at all, before it would create", () => {
    // The creator is wired and still must not be reached: there is nowhere to deliver the message.
    const { deps } = host({ capabilities: { createSession: async () => ({ sessionId: "c" }) } });
    expect(classifyWebuiSubmission(deps, {})).toEqual({
      kind: "unsupported",
      missing: "transport",
    });
  });
});
