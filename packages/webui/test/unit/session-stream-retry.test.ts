// Unit tests for the turn coordinator's manual retry — the manual arm of the
// stream loop's recovery, owned by
// `features/turn/application/turn-coordinator.ts`.
//
// The three properties are pinned here against the command that owns the retry,
// through `createWebuiApplication`:
//
//   * clear the standing refusal synchronously (a banner that still says
//     连接失败 over a loop that is already streaming is a lie),
//   * re-run the SAME attach loop with the last cursor this client applied,
//   * be exactly one attempt: a still-dead server refuses again through the
//     identical path, and the banner returns with the new reason.
//
// Driven against the application store the command reads and writes, so the
// command's entire job — moving that store from `refused` back to a live
// subscription — is what the assertions observe.

import { describe, expect, it, vi } from "vitest";

import { createWebuiApplication } from "../../src/client/application/create-application.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import type { WebuiProcessEventChannel } from "../../src/client/features/turn/application/event-channel.js";
import type {WebuiClientSessionResumer} from "../../src/client/features/turn/contracts/execution-port.js";
import type { WebuiStreamState } from "../../src/client/features/turn/projection/stream-state.js";

type ResumeRequest = Parameters<WebuiClientSessionResumer>[0];

/** The one application store the retry moves. */
const store = createWebuiSessionStore();

const channel: WebuiProcessEventChannel = {
  subscribe: () => () => undefined,
};

function seed(
  sessionId: string,
  patch: Partial<
    Pick<WebuiStreamState, "phase" | "refusal" | "cursor" | "transcriptIncomplete">
  >,
): string {
  store.updateSession(sessionId, (current) => ({
    ...current,
    stream: { ...current.stream, ...patch },
    sending: false,
  }));
  return sessionId;
}

/** A `resumeSession` that never settles, so the reopened loop stays parked in `streaming`. */
function pendingResume() {
  return vi.fn(
    (_request: ResumeRequest, _onFrame: Parameters<WebuiClientSessionResumer>[1]) =>
      new Promise<void>(() => {}),
  );
}

function appWithResume(resumeSession: WebuiClientSessionResumer) {
  // The command reads and writes the shared store; the application is built on
  // it (not a second map) so the assertions observe the same records. The
  // instance is started explicitly: construction opens no ingress.
  const application = createWebuiApplication({
    openEventChannel: () => channel,
    store,
    turns: { resumeSession },
  });
  application.start();
  return application;
}

describe("the turn coordinator's manual retry", () => {
  it("V07 detaches an active public retry on disposal without aborting the host", async () => {
    const sessionId = "srt-dispose";
    const store = createWebuiSessionStore();
    store.updateSession(sessionId, (current) => ({ ...current,
      stream: { ...current.stream, phase: "refused", cursor: "c1" } }));
    const close = vi.fn();
    const abortSession = vi.fn(async () => ({ success: true }));
    let finish!: () => void;
    let frame!: Parameters<WebuiClientSessionResumer>[1];
    const resumeSession: WebuiClientSessionResumer = (_request, onFrame, onDelivery) => {
      frame = onFrame;
      onDelivery?.({ close });
      return new Promise<void>((resolve) => { finish = resolve; });
    };
    const application = createWebuiApplication({
      openEventChannel: () => channel, store, turns: { resumeSession },
      turnCapabilities: { abortSession },
    });
    application.start();
    const pending = application.turns.retry(sessionId);
    expect(application.deliveries.count(sessionId)).toBe(1);
    expect(application.sessionScope.kinds(sessionId)).toContain("delivery");
    application.dispose(); application.dispose();
    const after = store.readSession(sessionId);
    frame({ cursor: "late", dataJson: JSON.stringify({ type: "agent_message", agent_message: { type: "assistant", content: "late" } }) });
    finish(); await pending;
    expect(close).toHaveBeenCalledTimes(1);
    expect(application.deliveries.count()).toBe(0);
    expect(application.sessionScope.interested()).toEqual([]);
    expect(store.readSession(sessionId)).toBe(after);
    expect(abortSession).not.toHaveBeenCalled();
  });
  it("clears the standing refusal and re-attaches from the recorded cursor", () => {
    const sessionId = seed("srt-cursor", {
      phase: "refused",
      refusal: "WebUI connection closed before [DONE]",
      cursor: "c9",
    });
    const resumeSession = pendingResume();
    const application = appWithResume(resumeSession);
    void application.turns.retry(sessionId);

    const stream = store.readSession(sessionId).stream;
    // The attach loop's synchronous prefix: the lease is claimed and the
    // phase is `streaming` by the time the click handler returns, and the
    // old refusal is gone rather than lingering under the new attempt.
    expect(stream.phase).toBe("streaming");
    expect(stream.refusal).toBeUndefined();
    expect(stream.transcriptIncomplete).toBe(false);
    expect(stream.subscription?.owner).toBe("recovered");
    // Anchored on the cursor the failed loop had applied — resuming from
    // anywhere else would either replay the transcript or skip frames.
    expect(resumeSession).toHaveBeenCalledWith(
      { id: "srt-cursor", afterCursor: "c9" },
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("anchors on persisted history when no cursor was recorded", () => {
    const sessionId = seed("srt-nocursor", {
      phase: "refused",
      refusal: "connection failed",
    });
    const resumeSession = pendingResume();
    const application = createWebuiApplication({
      openEventChannel: () => channel,
      store,
      turns: {
        resumeSession,
        loadMessages: async () => ({
          messages: [
            { msgId: "m2", role: "assistant", msgContent: "partial answer", timestamp: 2 },
            { msgId: "msg-user-3", role: "user", msgContent: "the question", timestamp: 3 },
          ],
          hasMore: false,
        }),
      },
    });
    application.start();

    void application.turns.retry(sessionId);
    // The loadMessages history seeding is awaited inside the loop; flush the
    // microtask queue before reading what the resume was anchored on.
    return vi.waitFor(() => {
      expect(resumeSession).toHaveBeenCalledWith(
        // No `afterCursor` (there was none), and the anchor is the newest
        // persisted message so the server replays from the recorded edge.
        expect.objectContaining({ id: "srt-nocursor", afterMsgId: "msg-user-3" }),
        expect.any(Function),
        expect.any(Function),
      );
      const request = resumeSession.mock.calls[0]?.[0];
      expect(request?.afterCursor).toBeUndefined();
    });
  });

  it("is one attempt: a still-dead server refuses again through the same path", () => {
    const sessionId = seed("srt-dead", {
      phase: "refused",
      refusal: "old reason",
      cursor: "c1",
    });
    const resumeSession = vi.fn(async () => {
      throw new Error("connection refused again");
    }) as unknown as WebuiClientSessionResumer;
    const application = createWebuiApplication({
      openEventChannel: () => channel,
      store,
      turns: { resumeSession },
    });
    application.start();

    return application.turns.retry(sessionId).then(() => {
      const stream = store.readSession(sessionId).stream;
      // Back to the terminal state with the NEW reason — the banner returns,
      // it does not spin: one click ran exactly one resume.
      expect(stream.phase).toBe("refused");
      expect(stream.refusal).toBe("connection refused again");
      // And the failed attempt leaves no lease behind for the next retry to
      // collide with.
      expect(stream.subscription).toBeUndefined();
      expect(resumeSession).toHaveBeenCalledTimes(1);
    });
  });
});
