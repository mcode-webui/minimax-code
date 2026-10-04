// W2 trace tests — exercise `reduceWebuiEffect` against the 10 behaviours
// enumerated in `refactor-recon/w0-baseline/effect-inventory.md §"W2 抽取时
// 必须覆盖的 trace 断言"`, plus the W2.9 contract that (a) the session
// guard runs FIRST, (b) the progress write is ALWAYS the first command
// once the guard passes, and (c) cross-session events produce zero
// commands (same state identity returned, no progress touched).
//
// Each `describe` block corresponds to one trace. The fixtures are written
// against the *event* shape the runtime hands the client, and every
// expected value is spelled out here rather than derived from an
// implementation constant, so a change on either side fails the test.
//
// Trace 9 (workspace-progress-first) is intentionally written to FAIL
// when the progress command is moved to the back of the array — see the
// mutation-test note in §3 of `brief-w2.9-wire-reducer.md`. Trace 10
// covers reducer purity and cross-session rejection; cleanup-friendly
// behaviour (the `cancelled = true` path) is not asserted here, by
// design.

import { describe, it, expect, vi } from "vitest";

import {
  applyWebuiEffectCommands,
  createWebuiWatchEventCallback,
  initialWebuiEffectState,
  reduceWebuiEffect,
  type WebuiEffectCommand,
  type WebuiEffectHandlers,
  type WebuiEffectState,
} from "../../src/client/projection/effect-reducer.js";
import {
  initialWebuiStreamState,
  isWebuiSubscriptionProbeCurrent,
  reduceWebuiStreamFrame,
  resolveWebuiSubscriptionRecheck,
  type WebuiStreamState,
} from "../../src/client/stream.js";
import {
  initialWebuiWorkspaceProgress,
  reduceWebuiWorkspaceProgressEvent,
} from "../../src/client/projection/workspace-progress.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
  WebuiRuntimeEvent,
} from "../../src/server/port.js";

const SESSION = "session-1";

function makeState(
  override?: Partial<WebuiEffectState>,
): WebuiEffectState {
  return {
    ...initialWebuiEffectState(initialWebuiStreamState),
    ...override,
  };
}

function event(
  partial: Partial<WebuiRuntimeEvent> & {
    readonly type: string;
    readonly payload: Record<string, unknown>;
  },
): WebuiRuntimeEvent {
  return {
    source: "test",
    timestamp: 0,
    ...partial,
  };
}

function commandTypes(commands: readonly WebuiEffectCommand[]): string[] {
  return commands.map((cmd) => cmd.type);
}

function findCommand<T extends WebuiEffectCommand["type"]>(
  commands: readonly WebuiEffectCommand[],
  type: T,
): Extract<WebuiEffectCommand, { readonly type: T }> | undefined {
  return commands.find(
    (cmd): cmd is Extract<WebuiEffectCommand, { readonly type: T }> =>
      cmd.type === type,
  ) as Extract<WebuiEffectCommand, { readonly type: T }> | undefined;
}

const PERMISSION: WebuiPendingPermission = {
  requestId: "perm-1",
  sessionId: SESSION,
  agentName: "main",
  toolName: "bash",
  ruleContents: ["ls"],
  reason: "needs approval",
  allowAlwaysSupported: true,
  createdAt: 1,
};

const QUESTIONNAIRE: WebuiQuestionnaireRequest = {
  schemaVersion: 1,
  id: "q-1",
  presentation: {
    replaceComposer: true,
    showProgress: false,
    allowBackNavigation: false,
  },
  steps: [
    {
      id: "step-1",
      question: "Pick one",
      selectionMode: 0,
      allowOther: false,
      otherPlaceholder: "",
      required: true,
    },
  ],
};

describe("W2.9 · guard contract · session gate runs before any state write", () => {
  it("cross-session event returns same state identity and an empty command list", () => {
    const before = makeState({
      stream: { ...initialWebuiStreamState, phase: "streaming" },
      permissions: [PERMISSION],
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "session.start",
        payload: { sessionId: "different-session" },
      }),
      SESSION,
    );
    expect(result.commands).toEqual([]);
    // Same object identity — the reducer did NOT touch the stream slice
    // and therefore did NOT call reduceWebuiWorkspaceProgressEvent.
    expect(result.state).toBe(before);
    expect(result.state.permissions).toBe(before.permissions);
  });
});

describe("W2 · recheck resolution · the active turn breaks the tie", () => {
  // One lease, the first this client ever took, so `generation: 1` — the
  // counter is client-side and monotonic, and every case below describes a
  // single-loop scenario.
  const owned = { owner: "recovered", turnId: "turn-1", generation: 1 } as const;

  it("holds when the active turn is the one we already track", () => {
    expect(
      resolveWebuiSubscriptionRecheck(owned, {
        turnId: "turn-1",
        busyReason: "turn",
      }),
    ).toBe("hold");
  });

  it("retargets when a different real turn is running", () => {
    expect(
      resolveWebuiSubscriptionRecheck(owned, {
        turnId: "turn-2",
        busyReason: "turn",
      }),
    ).toBe("retarget");
  });

  it("releases when nothing is running — our lease was stale", () => {
    expect(resolveWebuiSubscriptionRecheck(owned, undefined)).toBe("release");
  });

  it("releases on compaction: it produces no transcript to attach to", () => {
    expect(
      resolveWebuiSubscriptionRecheck(owned, {
        turnId: "turn-1",
        busyReason: "compaction",
      }),
    ).toBe("release");
  });

  it("holds a lease that has not adopted its turn id yet", () => {
    // `runWebuiStreamLoop` claims before the runtime publishes
    // `session.start`, so a turn-less lease is almost always the user's own
    // send in flight. Retargeting it would hand their own turn back as
    // somebody else's and cancel the answer they are watching for.
    expect(
      resolveWebuiSubscriptionRecheck({ owner: "local-send", generation: 1 }, {
        turnId: "turn-1",
        busyReason: "turn",
      }),
    ).toBe("hold");
  });

  it("retargets when our lease names a different, real turn", () => {
    expect(
      resolveWebuiSubscriptionRecheck(
        { owner: "recovered", turnId: "turn-stale", generation: 1 },
        { turnId: "turn-live", busyReason: "turn" },
      ),
    ).toBe("retarget");
  });

  it("retargets a turn-less recovered lease on the active turn's word", () => {
    // The opposite of the local-send case: a `recovered` lease with no turn
    // id means we attached without being told which turn, so the active
    // turn is the only thing that can say whose it is.
    expect(
      resolveWebuiSubscriptionRecheck(
        { owner: "recovered", generation: 4 },
        { turnId: "turn-5", busyReason: "turn" },
      ),
    ).toBe("retarget");
  });

  it("ignores a probe result whose lease has been replaced", () => {
    // The probe leaves with one lease and comes back to another: a local
    // send claimed in between. Acting on the snapshot would take the
    // user's own turn away from them.
    const captured = { owner: "recovered" as const, turnId: "turn-1", generation: 7 };
    const replaced = { owner: "local-send" as const, generation: 8 };
    expect(isWebuiSubscriptionProbeCurrent(captured, captured)).toBe(true);
    expect(isWebuiSubscriptionProbeCurrent(captured, replaced)).toBe(false);
    expect(isWebuiSubscriptionProbeCurrent(captured, undefined)).toBe(false);
    expect(isWebuiSubscriptionProbeCurrent(undefined, captured)).toBe(false);
  });
});

describe("W2 · stream subscription ownership · one stream per turn", () => {
  it("claims our own turn instead of attaching a second stream", () => {    const before = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        // BLOCKED (type debt G1): `generation` is required on
        // `WebuiStreamSubscription`, but adding it here also puts it in the
        // result — `claimWebuiSubscriptionTurn` spreads `...owned` — so the
        // `toEqual` at :239 would need `generation: 1` as well. That is a
        // change to an assertion's expected value, which the assignment
        // forbids. Left as-is pending a decision.
        subscription: { owner: "local-send" },
      },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "session.start",
        payload: { sessionId: SESSION, turnId: "turn-1" },
      }),
      SESSION,
    );
    // No attach: our `sendMessage` stream is already open for this turn.
    expect(commandTypes(result.commands)).not.toContain("attach-stream");
    expect(result.state.stream.subscription).toEqual({
      owner: "local-send",
      turnId: "turn-1",
    });
  });

  it("holds when a second session.start names the turn we already track", () => {
    const before = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        // BLOCKED (type debt G1): see the note on the `local-send` fixture
        // above — the required `generation` would have to appear in the
        // `toEqual` expectation too.
        subscription: { owner: "recovered", turnId: "turn-1" },
      },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "session.start",
        payload: { sessionId: SESSION, turnId: "turn-1" },
      }),
      SESSION,
    );
    expect(commandTypes(result.commands)).not.toContain("attach-stream");
    expect(result.state.stream.subscription).toEqual({
      owner: "recovered",
      turnId: "turn-1",
    });
  });

  it("delegates a foreign turn to the probe instead of attaching blindly", () => {
    const before = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        // BLOCKED (type debt G1): see the note on the `local-send` fixture
        // above — the required `generation` would have to appear in the
        // `toEqual` expectation too.
        subscription: { owner: "recovered", turnId: "turn-1" },
      },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "session.start",
        payload: { sessionId: SESSION, turnId: "turn-2" },
      }),
      SESSION,
    );
    // We cannot tell a stale lease from a concurrent stream from the event
    // alone, so the reducer hands the question over instead of guessing.
    // Attaching blindly is what double the answer text: `applyFrameData`
    // appends chunks and `applyFrameCursor` overwrites the cursor without
    // comparing order.
    const attach = result.commands.find((command) => command.type === "attach-stream");
    expect(attach).toBeDefined();
    if (attach?.type === "attach-stream") expect(attach.mode).toBe("recheck");
    // The existing lease survives until the probe answers.
    expect(result.state.stream.subscription).toEqual({
      owner: "recovered",
      turnId: "turn-1",
    });
  });

  it("attaches when the lease was released by the previous turn's DONE", () => {
    const live = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        subscription: { owner: "recovered", turnId: "turn-1", generation: 1 },
      },
    });
    const settled = reduceWebuiEffect(
      live,
      event({
        type: "session.finish",
        payload: { sessionId: SESSION, turnId: "turn-1" },
      }),
      SESSION,
    );
    expect(settled.state.stream.subscription).toBeUndefined();

    const next = reduceWebuiEffect(
      settled.state,
      event({
        type: "session.start",
        payload: { sessionId: SESSION, turnId: "turn-2" },
      }),
      SESSION,
    );
    expect(commandTypes(next.commands)).toContain("attach-stream");
  });

  it("keeps the live turn's whole state when a terminal event names an older turn", () => {
    // A terminal event is delivered on the event socket while the stream
    // frames arrive on a different one, so the two can cross. A probe that
    // retargeted us onto `turn-2` must not have its UI settled by `turn-1`
    // finishing late — that is the spinner vanishing mid-answer, the same
    // class of defect as the spinner that never leaves.
    const live = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        subscription: { owner: "recovered", turnId: "turn-2", generation: 2 },
      },
    });
    const settled = reduceWebuiEffect(
      live,
      event({
        type: "session.finish",
        payload: { sessionId: SESSION, turnId: "turn-1" },
      }),
      SESSION,
    );
    expect(settled.state.stream.subscription).toEqual({
      owner: "recovered",
      turnId: "turn-2",
      generation: 2,
    });
    // The whole terminal is behind one guard, not just the lease release.
    expect(settled.state.stream.phase).toBe("streaming");
    expect(settled.state.stream.status).toBeUndefined();
    expect(findCommand(settled.commands, "set-sending")?.when?.(settled.state.stream)).toBe(false);
  });

  it("settles the turn its terminal event names", () => {
    const live = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        subscription: { owner: "recovered", turnId: "turn-2", generation: 2 },
      },
    });
    const settled = reduceWebuiEffect(
      live,
      event({
        type: "session.finish",
        payload: { sessionId: SESSION, turnId: "turn-2" },
      }),
      SESSION,
    );
    expect(settled.state.stream.subscription).toBeUndefined();
    expect(settled.state.stream.phase).toBe("done");
    expect(findCommand(settled.commands, "set-sending")?.when?.(settled.state.stream)).toBe(true);
  });

  it("ignores a named terminal that arrives while our own send has no turn id yet", () => {
    // Between `claim` and the runtime's `session.start` a local send holds
    // a lease with no turn id. A terminal naming an older turn must not
    // settle it, or the answer the user is watching for stops streaming.
    const live = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        subscription: { owner: "local-send", generation: 3 },
      },
    });
    const settled = reduceWebuiEffect(
      live,
      event({
        type: "session.finish",
        payload: { sessionId: SESSION, turnId: "turn-1" },
      }),
      SESSION,
    );
    expect(settled.state.stream.phase).toBe("streaming");
    expect(settled.state.stream.subscription).toEqual({
      owner: "local-send",
      generation: 3,
    });
    expect(settled.state.stream.status).toBeUndefined();
  });

  it("settles a named terminal when no lease is held at all", () => {
    // Nothing newer to protect, and a turn we never attached to has no
    // other way out of `streaming`.
    const live = makeState({
      stream: { ...initialWebuiStreamState, phase: "streaming" },
    });
    const settled = reduceWebuiEffect(
      live,
      event({
        type: "session.finish",
        payload: { sessionId: SESSION, turnId: "turn-9" },
      }),
      SESSION,
    );
    expect(settled.state.stream.phase).toBe("done");
    expect(settled.state.stream.subscription).toBeUndefined();
  });

  it("skips the sending setter when the live state no longer matches", () => {
    // The reducer's snapshot is too old to decide this: by the time the
    // command runs, a newer turn may already own the session. Exercising
    // the executor is the only way to pin that the guard is actually
    // consulted — asserting on the predicate alone would pass even if the
    // executor ignored it entirely.
    const setSending = vi.fn();
    const setStream = vi.fn();
    const stale = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        subscription: { owner: "recovered", turnId: "turn-1", generation: 1 },
      },
    });
    const terminal = reduceWebuiEffect(
      stale,
      event({ type: "session.finish", payload: { sessionId: SESSION, turnId: "turn-1" } }),
      SESSION,
    );
    // A newer turn claimed while the commands were in flight.
    // Annotated `WebuiStreamState` so the literal's `owner` keeps its union
    // member instead of widening to `string` — without a contextual type the
    // reducers that branch on `owner` no longer accept this.
    const live: WebuiStreamState = {
      ...stale.stream,
      subscription: { owner: "recovered", turnId: "turn-2", generation: 2 },
    };
    applyWebuiEffectCommands(terminal.commands, {
      refreshPending: () => undefined,
      refreshGoal: () => undefined,
      setSending,
      setStream,
      setPermissions: vi.fn(),
      setQuestionnaire: vi.fn(),
      setGoal: vi.fn(),
    }, () => live);
    expect(setSending).not.toHaveBeenCalled();
    // The stream patch carries its own guard, so the phase is untouched too.
    for (const cmd of terminal.commands) {
      if (cmd.type === "set-stream" && cmd.patch(live).phase !== live.phase)
        throw new Error("terminal patch settled a turn it does not own");
    }
  });

  it("releases the lease from a terminal event that carries no turn id", () => {
    // Without a turn id the event cannot be attributed to a turn, and
    // stranding the lease is worse than releasing a live one: the session
    // would sit in "thinking" until the next reconnect.
    const live = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        subscription: { owner: "recovered", turnId: "turn-1", generation: 1 },
      },
    });
    const settled = reduceWebuiEffect(
      live,
      event({ type: "session.abort", payload: { sessionId: SESSION } }),
      SESSION,
    );
    expect(settled.state.stream.subscription).toBeUndefined();
  });

  it("releases the lease on a DONE frame so the next turn can attach", () => {
    const live = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        subscription: { owner: "local-send", turnId: "turn-1", generation: 1 },
      },
    });
    // `reduceWebuiStreamFrame` takes the stream slice, so hand it the slice.
    // `makeState` only wraps it in an effect state; the frame reducer reads
    // no effect fields, so the two arguments describe the same state.
    const settled = reduceWebuiStreamFrame(live.stream, {
      dataJson: "[DONE]",
    });
    expect(settled.subscription).toBeUndefined();
    expect(settled.phase).toBe("done");
  });

  it("releases the lease on session.abort", () => {
    const live = makeState({
      stream: {
        ...initialWebuiStreamState,
        phase: "streaming",
        subscription: { owner: "recovered", turnId: "turn-1", generation: 1 },
      },
    });
    const settled = reduceWebuiEffect(
      live,
      event({ type: "session.abort", payload: { sessionId: SESSION } }),
      SESSION,
    );
    expect(settled.state.stream.subscription).toBeUndefined();
  });
});

describe("W2 · trace 1 · session.start emits sending+streaming in order", () => {
  it("returns progress, sending, phase, then the attach the missing stream needs", () => {
    const state = makeState();
    const result = reduceWebuiEffect(
      state,
      event({
        type: "session.start",
        payload: { sessionId: SESSION, turnId: "turn-1" },
      }),
      SESSION,
    );
    // First command is the unconditional progress write.
    expect(commandTypes(result.commands)).toEqual([
      "set-stream",
      "set-sending",
      "set-stream",
      "attach-stream",
    ]);
    // Nobody owned a stream, so the server started a turn this client did
    // not initiate (goal, queued drain, another client) and the composer has
    // to open one or the transcript stays empty.
    const attach = result.commands[3];
    expect(attach?.type).toBe("attach-stream");
    if (attach?.type === "attach-stream") expect(attach.turnId).toBe("turn-1");
    expect(findCommand(result.commands, "set-sending")?.sending).toBe(true);
    // The second set-stream patch lands phase:streaming.
    const phasePatch = result.commands[2];
    expect(phasePatch?.type).toBe("set-stream");
    if (phasePatch?.type === "set-stream") {
      const nextStream = phasePatch.patch(initialWebuiStreamState);
      expect(nextStream.phase).toBe("streaming");
    }
    // The first set-stream patch is the workspace-progress write.
    const progressPatch = result.commands[0];
    expect(progressPatch?.type).toBe("set-stream");
    if (progressPatch?.type === "set-stream") {
      const nextStream = progressPatch.patch(initialWebuiStreamState);
      expect(nextStream.workspaceProgress).toBeDefined();
    }
  });
});

describe("W2 · trace 2 · session.finish/abort/error map to status + refusal", () => {
  it("finish → status:finished, refusal untouched when payload.error absent", () => {
    const result = reduceWebuiEffect(
      makeState(),
      event({ type: "session.finish", payload: { sessionId: SESSION } }),
      SESSION,
    );
    // progress write + sending(false) + status patch.
    expect(commandTypes(result.commands)).toEqual([
      "set-stream",
      "set-sending",
      "set-stream",
    ]);
    expect(findCommand(result.commands, "set-sending")?.sending).toBe(false);
    const finalStream = result.state.stream;
    expect(finalStream.phase).toBe("done");
    expect(finalStream.status).toBe("finished");
    expect(finalStream.refusal).toBeUndefined();
  });

  it("abort → status:aborted", () => {
    const result = reduceWebuiEffect(
      makeState(),
      event({ type: "session.abort", payload: { sessionId: SESSION } }),
      SESSION,
    );
    expect(result.state.stream.status).toBe("aborted");
  });

  it("error → status:error, refusal written when payload.error is string", () => {
    const result = reduceWebuiEffect(
      makeState(),
      event({
        type: "session.error",
        payload: { sessionId: SESSION, error: "boom" },
      }),
      SESSION,
    );
    expect(result.state.stream.status).toBe("error");
    expect(result.state.stream.refusal).toBe("boom");
  });

  it("error with non-string payload.error → status:error, no refusal", () => {
    const result = reduceWebuiEffect(
      makeState(),
      event({
        type: "session.error",
        payload: { sessionId: SESSION, error: { code: 1 } },
      }),
      SESSION,
    );
    expect(result.state.stream.status).toBe("error");
    expect(result.state.stream.refusal).toBeUndefined();
  });
});

describe("W2 · trace 3 · session.queue.updated → refresh-pending", () => {
  it("emits progress write + refresh-pending", () => {
    const before = makeState({
      stream: { ...initialWebuiStreamState, phase: "waiting" },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "session.queue.updated",
        payload: { sessionId: SESSION },
      }),
      SESSION,
    );
    expect(commandTypes(result.commands)).toEqual([
      "set-stream",
      "refresh-pending",
    ]);
    expect(result.state.stream.phase).toBe("waiting");
  });
});

describe("W2 · trace 4 · permission.ask with malformed payload → only progress command", () => {
  it("emits just the progress write when pendingPermissionFromEvent returns undefined", () => {
    const result = reduceWebuiEffect(
      makeState(),
      event({
        type: "permission.ask",
        payload: { sessionId: SESSION }, // missing required keys
      }),
      SESSION,
    );
    expect(commandTypes(result.commands)).toEqual(["set-stream"]);
  });
});

describe("W2 · trace 5 · permission.resolved with non-string requestId emits setStream but keeps the phase", () => {
  it("non-string requestId leaves permissions untouched and does not resume the turn", () => {
    const before = makeState({
      permissions: [PERMISSION],
      stream: { ...initialWebuiStreamState, phase: "waiting" },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "permission.resolved",
        payload: { sessionId: SESSION, requestId: 42 },
      }),
      SESSION,
    );
    expect(result.state.permissions).toEqual([PERMISSION]);
    // progress write + the guarded phase write.
    expect(commandTypes(result.commands)).toEqual([
      "set-stream",
      "set-stream",
    ]);
    // A malformed id names no pending permission, so the panel must stay
    // blocked rather than flip to a streaming pulse that nothing will end.
    const finalStream = result.state.stream;
    expect(finalStream.phase).toBe("waiting");
  });

  it("still resumes when the id matches a permission this client was showing", () => {
    const before = makeState({
      permissions: [PERMISSION],
      stream: { ...initialWebuiStreamState, phase: "waiting" },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "permission.resolved",
        payload: { sessionId: SESSION, requestId: PERMISSION.requestId },
      }),
      SESSION,
    );
    expect(result.state.permissions).toEqual([]);
    expect(result.state.stream.phase).toBe("streaming");
  });

  it("does not resume once the row is already gone (local decision made first)", () => {
    const before = makeState({
      permissions: [],
      stream: { ...initialWebuiStreamState, phase: "done" },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "permission.resolved",
        payload: { sessionId: SESSION, requestId: PERMISSION.requestId },
      }),
      SESSION,
    );
    expect(result.state.stream.phase).toBe("done");
  });
});

describe("W2 · trace 6 · questionnaire.ask with malformed payload → only progress command", () => {
  it("emits just the progress write when questionnaireFromEvent returns undefined", () => {
    const result = reduceWebuiEffect(
      makeState(),
      event({
        type: "questionnaire.ask",
        payload: { sessionId: SESSION }, // missing payload.request
      }),
      SESSION,
    );
    expect(commandTypes(result.commands)).toEqual(["set-stream"]);
  });
});

describe("W2 · trace 7 · thread_goal.* without payload.goal → only progress; upsert by id", () => {
  it("no payload.goal → only the progress write", () => {
    const result = reduceWebuiEffect(
      makeState(),
      event({
        type: "thread_goal.updated",
        payload: { sessionId: SESSION }, // missing payload.goal
      }),
      SESSION,
    );
    expect(commandTypes(result.commands)).toEqual(["set-stream"]);
  });

  it("with payload.goal: progress + set-goal + upsert patch in that order", () => {
    const goal = {
      goalId: "g-1",
      objective: "ship W2",
      status: "active",
      updatedAt: 100,
    };
    const result = reduceWebuiEffect(
      makeState(),
      event({
        type: "thread_goal.objective_updated",
        payload: { sessionId: SESSION, goal },
      }),
      SESSION,
    );
    expect(commandTypes(result.commands)).toEqual([
      "set-stream",
      "set-goal",
      "set-stream",
    ]);
    expect(findCommand(result.commands, "set-goal")?.goal).toEqual(goal);
    expect(result.state.stream.messages.map((m) => m.id)).toEqual([
      "thread-goal-g-1",
    ]);
  });

  it("re-running with the same goalId replaces the existing message in place", () => {
    const firstGoal = {
      goalId: "g-1",
      objective: "first",
      status: "active",
      updatedAt: 1,
    };
    const secondGoal = { ...firstGoal, objective: "second", updatedAt: 2 };
    let state = makeState();
    state = reduceWebuiEffect(
      state,
      event({
        type: "thread_goal.objective_updated",
        payload: { sessionId: SESSION, goal: firstGoal },
      }),
      SESSION,
    ).state;
    state = reduceWebuiEffect(
      state,
      event({
        type: "thread_goal.objective_updated",
        payload: { sessionId: SESSION, goal: secondGoal },
      }),
      SESSION,
    ).state;
    expect(state.stream.messages).toHaveLength(1);
    expect(state.stream.messages[0]?.answer).toBe("second");
  });
});

describe("W2 · trace 8 · questionnaire.dismiss/superseded only resumes the shown request", () => {
  it("mismatched id: progress + set-questionnaire(no-op patch) + set-stream that keeps waiting", () => {
    const before = makeState({
      questionnaire: QUESTIONNAIRE,
      stream: { ...initialWebuiStreamState, phase: "waiting" },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "questionnaire.dismiss",
        payload: { sessionId: SESSION, requestId: "different" },
      }),
      SESSION,
    );
    expect(result.state.questionnaire).toEqual(QUESTIONNAIRE);
    expect(commandTypes(result.commands)).toEqual([
      "set-stream",
      "set-questionnaire",
      "set-stream",
    ]);
    // A dismiss naming another request is a late echo, not a resume.
    expect(result.state.stream.phase).toBe("waiting");
  });

  it("matching id clears the questionnaire AND flips stream to streaming", () => {
    const before = makeState({
      questionnaire: QUESTIONNAIRE,
      stream: { ...initialWebuiStreamState, phase: "waiting" },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "questionnaire.superseded",
        payload: { sessionId: SESSION, requestId: QUESTIONNAIRE.id },
      }),
      SESSION,
    );
    expect(result.state.questionnaire).toBeUndefined();
    expect(commandTypes(result.commands)).toEqual([
      "set-stream",
      "set-questionnaire",
      "set-stream",
    ]);
    expect(result.state.stream.phase).toBe("streaming");
  });

  it("late dismiss after a local skip does not revive the streaming pulse", () => {
    // handleQuestionnaire already set phase:"idle" and cleared the card.
    const before = makeState({
      questionnaire: undefined,
      stream: { ...initialWebuiStreamState, phase: "idle" },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "questionnaire.dismiss",
        payload: {
          sessionId: SESSION,
          requestId: QUESTIONNAIRE.id,
          // The runtime reports a skip as answered; the payload cannot
          // distinguish it from a normal answer.
          status: "answered",
        },
      }),
      SESSION,
    );
    expect(result.state.stream.phase).toBe("idle");
  });

  it("late dismiss after a local answer does not disturb the streaming phase", () => {
    const before = makeState({
      questionnaire: undefined,
      stream: { ...initialWebuiStreamState, phase: "streaming" },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "questionnaire.dismiss",
        payload: { sessionId: SESSION, requestId: QUESTIONNAIRE.id },
      }),
      SESSION,
    );
    expect(result.state.stream.phase).toBe("streaming");
  });
});

describe("W2 · trace 9 · progress is ALWAYS the first command when the guard passes", () => {
  it("cross-session event: guard rejects, zero commands, same state", () => {
    // Cross-session events no longer touch progress. The previous W2
    // design wrote the progress slice first; this rewrite enforces the
    // original closure's order (guard first, state never touched on
    // mismatch). The trace asserts that.
    const before = makeState({
      stream: { ...initialWebuiStreamState, phase: "streaming" },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "session.start",
        payload: { sessionId: "other" },
      }),
      SESSION,
    );
    expect(result.commands).toEqual([]);
    expect(result.state).toBe(before);
  });

  it("in-session session.start: commands[0] is the progress write (fails if swapped to last)", () => {
    // This assertion is the mutation test: push the progress write to
    // the back of `commands` in `reduceWebuiEffect` and this test goes
    // red. See brief-w2.9-wire-reducer.md §3 for the procedure.
    const result = reduceWebuiEffect(
      makeState(),
      event({
        type: "session.start",
        payload: { sessionId: SESSION },
      }),
      SESSION,
    );
    const first = result.commands[0];
    expect(first?.type).toBe("set-stream");
    if (first?.type === "set-stream") {
      // The first patch is the workspace-progress write. The patch
      // spreads the input, so we assert that the new progress slice is
      // present, but more importantly we assert that the *resulting*
      // workspace progress slice matches what the reducer computed —
      // swapping the patches puts a different slice here.
      //
      // The sentinel phase is deliberately outside `phase`'s union: a real
      // phase value would be indistinguishable from one the patch recomputed,
      // so the only way to prove the patch *copies* `phase` is to seed a
      // value no reducer can produce. One documented cast is the price of that
      // sentinel; the runtime value and the expectation below are unchanged.
      const next = first.patch({
        ...initialWebuiStreamState,
        phase: "PREVIOUSLY_STREAMING" as WebuiStreamState["phase"],
      });
      expect(next.workspaceProgress).toEqual(
        result.state.stream.workspaceProgress,
      );
      // And the previous phase survives unchanged (the patch only
      // touches workspaceProgress).
      expect(next.phase).toBe("PREVIOUSLY_STREAMING");
    }
    const last = result.commands.findLastIndex(
      (command) => command.type === "set-stream",
    );
    const lastSetStream = result.commands[last];
    expect(lastSetStream?.type).toBe("set-stream");
    if (lastSetStream?.type === "set-stream") {
      // The phase write is the last set-stream command.
      const next = lastSetStream.patch({
        ...initialWebuiStreamState,
        workspaceProgress: result.state.stream.workspaceProgress,
      });
      expect(next.phase).toBe("streaming");
    }
  });

  it("in-session unknown event: commands[0] is still the progress write (no early bail-out)", () => {
    const before = makeState();
    const result = reduceWebuiEffect(
      before,
      event({
        type: "todo_updated",
        payload: {
          sessionId: SESSION,
          todos: [{ content: "t1", status: "in_progress" }],
        },
      }),
      SESSION,
    );
    expect(commandTypes(result.commands)).toEqual(["set-stream"]);
    expect(result.state.stream.workspaceProgress.todos).toEqual([
      { content: "t1", status: "in_progress" },
    ]);
  });

  it("in-session session.start after a seeded todo: progress write absorbs new state", () => {
    const seeded = reduceWebuiWorkspaceProgressEvent(
      initialWebuiWorkspaceProgress,
      {
        type: "todo_updated",
        sessionId: SESSION,
        todos: [{ content: "x", status: "pending" }],
      },
    );
    const before = makeState({
      stream: { ...initialWebuiStreamState, workspaceProgress: seeded },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "session.start",
        payload: { sessionId: SESSION },
      }),
      SESSION,
    );
    // The seeded `x` todo survives — the new event adds nothing new
    // but the slice gets replaced with a (logically equal) fresh object.
    expect(result.state.stream.workspaceProgress.todos).toEqual([
      { content: "x", status: "pending" },
    ]);
  });
});

describe("W2 · trace 10 · reducer purity + cross-session rejection (no cleanup path)", () => {
  it("reducer is pure: applying the same event twice yields the same state and commands", () => {
    const first = reduceWebuiEffect(
      makeState(),
      event({
        type: "permission.ask",
        payload: { ...PERMISSION },
      }),
      SESSION,
    );
    const second = reduceWebuiEffect(
      makeState(),
      event({
        type: "permission.ask",
        payload: { ...PERMISSION },
      }),
      SESSION,
    );
    expect(second.state.permissions).toEqual(first.state.permissions);
    expect(second.state.stream).toEqual(first.state.stream);
    expect(second.commands.length).toBe(first.commands.length);
  });

  it("cross-session rejection: state identity preserved even when a deep field would change", () => {
    const before = makeState({
      permissions: [PERMISSION],
      stream: {
        ...initialWebuiStreamState,
        workspaceProgress: reduceWebuiWorkspaceProgressEvent(
          initialWebuiWorkspaceProgress,
          { type: "session.start" },
        ),
      },
    });
    const result = reduceWebuiEffect(
      before,
      event({
        type: "session.start",
        payload: { sessionId: "other" },
      }),
      SESSION,
    );
    expect(result.commands).toEqual([]);
    expect(result.state).toBe(before);
  });
});

describe("D3 · watchEvents reduces each event against the latest stream", () => {
  it("keeps a spawned child available to the following completion event", () => {
    let store = makeState();
    const read = () => store;
    const callback = createWebuiWatchEventCallback(
      SESSION,
      () => read().stream,
      () => ({
        permissions: read().permissions,
        questionnaire: read().questionnaire,
        goal: read().goal,
      }),
      {
        refreshPending: () => undefined,
        refreshGoal: () => undefined,
        setSending: () => undefined,
        setStream: (patch) => { store = { ...store, stream: patch(store.stream) }; },
        setPermissions: (patch) => { store = { ...store, permissions: patch(store.permissions) }; },
        setQuestionnaire: (patch) => { store = { ...store, questionnaire: patch(store.questionnaire) }; },
        setGoal: (goal) => { store = { ...store, goal }; },
      },
    );

    const spawned = event({
      type: "session.spawned",
      payload: {
        sessionId: SESSION,
        data: { sessionId: "child-1", agentName: "worker", status: "running" },
      },
    });
    const completed = event({
      type: "session.finish",
      payload: { sessionId: SESSION, data: { sessionId: "child-1" } },
    });
    callback(spawned);
    expect(store.stream.workspaceProgress.subagents).toEqual([
      expect.objectContaining({ sessionId: "child-1", status: "running" }),
    ]);
    callback(completed);
    expect(store.stream.workspaceProgress.subagents).toEqual([
      expect.objectContaining({ sessionId: "child-1", status: "completed" }),
    ]);
  });
});

/* --------------------------------------------------------------------------
 * Executor tests — `applyWebuiEffectCommands` walks the command list
 * against a handler bag and calls each setter. The point is to lock down
 * the order: handlers fire in the order the reducer produces them, with
 * no reordering, skipping, or batching.
 * ------------------------------------------------------------------------ */

describe("W2.9 · executor · applyWebuiEffectCommands walks commands in order", () => {
  function makeCapturingHandlers(): WebuiEffectHandlers & {
    calls: { type: string; payload: unknown }[];
  } {
    const calls: { type: string; payload: unknown }[] = [];
    // Annotated `: void` so `calls.push`'s numeric return is discarded, and
    // the parameter is optional so one recorder fits both the zero-argument
    // handlers (`refreshPending`) and the ones that take a value. Without
    // this the recorder returned `(payload: unknown) => number`, which no
    // handler signature accepts.
    const record =
      (type: string) =>
      (payload?: unknown): void => {
        calls.push({ type, payload });
      };
    return {
      calls,
      refreshPending: record("refreshPending"),
      refreshGoal: record("refreshGoal"),
      setSending: record("setSending"),
      setStream: record("setStream"),
      setPermissions: record("setPermissions"),
      setQuestionnaire: record("setQuestionnaire"),
      setGoal: record("setGoal"),
    };
  }

  it("session.start handlers fire in the order progress → set-sending → phase-stream", () => {
    const handlers = makeCapturingHandlers();
    const result = reduceWebuiEffect(
      makeState(),
      event({ type: "session.start", payload: { sessionId: SESSION } }),
      SESSION,
    );
    applyWebuiEffectCommands(result.commands, handlers);
    expect(handlers.calls.map((c) => c.type)).toEqual([
      "setStream",
      "setSending",
      "setStream",
    ]);
  });

  it("set-sending passes the boolean value, not a patch", () => {
    const handlers = makeCapturingHandlers();
    const result = reduceWebuiEffect(
      makeState(),
      event({ type: "session.start", payload: { sessionId: SESSION } }),
      SESSION,
    );
    applyWebuiEffectCommands(result.commands, handlers);
    expect(handlers.calls[1]).toEqual({ type: "setSending", payload: true });
  });

  it("set-stream passes the patch function itself (functional updater)", () => {
    const handlers = makeCapturingHandlers();
    const result = reduceWebuiEffect(
      makeState(),
      event({ type: "session.start", payload: { sessionId: SESSION } }),
      SESSION,
    );
    applyWebuiEffectCommands(result.commands, handlers);
    expect(typeof handlers.calls[0]?.payload).toBe("function");
  });

  it("refresh-goal is executed like any other handler", () => {
    const handlers = makeCapturingHandlers();
    applyWebuiEffectCommands([{ type: "refresh-goal" }], handlers);
    expect(handlers.calls.map((call) => call.type)).toEqual(["refreshGoal"]);
  });

  it("refresh-pending is called even when it returns a rejecting promise", async () => {
    let calls = 0;
    const handlers: WebuiEffectHandlers = {
      refreshPending: () => {
        calls += 1;
        return Promise.reject(new Error("boom"));
      },
      refreshGoal: () => undefined,
      setSending: () => undefined,
      setStream: () => undefined,
      setPermissions: () => undefined,
      setQuestionnaire: () => undefined,
      setGoal: () => undefined,
    };
    const result = reduceWebuiEffect(
      makeState(),
      event({
        type: "session.queue.updated",
        payload: { sessionId: SESSION },
      }),
      SESSION,
    );
    applyWebuiEffectCommands(result.commands, handlers);
    expect(calls).toBe(1);
    // Wait a tick to let the rejection settle; the executor must have
    // attached a catch handler that swallows it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });

  it("set-goal is invoked with the value, not a patch function", () => {
    const handlers = makeCapturingHandlers();
    const goal = {
      goalId: "g-1",
      objective: "ship",
      status: "active",
      updatedAt: 1,
    };
    const result = reduceWebuiEffect(
      makeState(),
      event({
        type: "thread_goal.objective_updated",
        payload: { sessionId: SESSION, goal },
      }),
      SESSION,
    );
    applyWebuiEffectCommands(result.commands, handlers);
    expect(handlers.calls).toContainEqual({ type: "setGoal", payload: goal });
  });

  it("empty command list is a no-op", () => {
    const handlers = makeCapturingHandlers();
    applyWebuiEffectCommands([], handlers);
    expect(handlers.calls).toEqual([]);
  });
});
