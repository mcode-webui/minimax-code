// Unit tests for `createSessionStreamRetry` — the manual arm of the stream
// loop's recovery.
//
// The loop's own tests cover the automatic arm (drop → `reconnecting` → one
// `resumeSession` attempt). What this suite pins is the arm the user pulls:
// after the loop has committed `refused` and stopped, the retry has to
//
//   * clear the standing refusal synchronously (a banner that still says
//     连接失败 over a loop that is already streaming is a lie),
//   * re-run the SAME attach loop with the last cursor this client applied,
//   * be exactly one attempt: a still-dead server refuses again through the
//     identical path, and the banner returns with the new reason.
//
// Driven against the real module-level runtime store — the same Map the shell
// and the composer read — because the retry's entire job is to move that
// store from `refused` back to a live subscription.

import { describe, expect, it, vi } from "vitest";

import { createSessionStreamRetry } from "../../src/client/session-stream-retry.js";
import {
  readSessionRuntimeState,
  updateSessionRuntimeState,
} from "../../src/client/session-runtime-store.js";
import type { WebuiClientSessionResumer } from "../../src/client/contracts.js";
import type { WebuiStreamState } from "../../src/client/stream.js";

type ResumeRequest = Parameters<WebuiClientSessionResumer>[0];

function seed(
  sessionId: string,
  patch: Partial<
    Pick<WebuiStreamState, "phase" | "refusal" | "cursor" | "transcriptIncomplete">
  >,
): string {
  updateSessionRuntimeState(sessionId, (current) => ({
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

describe("createSessionStreamRetry", () => {
  it("clears the standing refusal and re-attaches from the recorded cursor", () => {
    const sessionId = seed("srt-cursor", {
      phase: "refused",
      refusal: "WebUI connection closed before [DONE]",
      cursor: "c9",
    });
    const resumeSession = pendingResume();
    const retry = createSessionStreamRetry({ sessionId, resumeSession });

    retry();

    const stream = readSessionRuntimeState(sessionId).stream;
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
    );
  });

  it("anchors on persisted history when no cursor was recorded", () => {
    const sessionId = seed("srt-nocursor", {
      phase: "refused",
      refusal: "connection failed",
    });
    const resumeSession = pendingResume();
    const retry = createSessionStreamRetry({
      sessionId,
      resumeSession,
      loadMessages: async () => ({
        messages: [
          { msgId: "m2", role: "assistant", msgContent: "partial answer", timestamp: 2 },
          { msgId: "msg-user-3", role: "user", msgContent: "the question", timestamp: 3 },
        ],
        hasMore: false,
      }),
    });

    retry();
    // The loadMessages history seeding is awaited inside the loop; flush the
    // microtask queue before reading what the resume was anchored on.
    void vi.waitFor(() => {
      expect(resumeSession).toHaveBeenCalled();
    });

    return vi.waitFor(() => {
      expect(resumeSession).toHaveBeenCalledWith(
        // No `afterCursor` (there was none), and the anchor is the newest
        // persisted message so the server replays from the recorded edge.
        expect.objectContaining({ id: "srt-nocursor", afterMsgId: "msg-user-3" }),
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
    });
    const retry = createSessionStreamRetry({ sessionId, resumeSession });

    retry();

    return vi.waitFor(() => {
      const stream = readSessionRuntimeState(sessionId).stream;
      // Back to the terminal state with the NEW reason — the banner returns,
      // it does not spin: one click ran exactly one resume.
      expect(stream.phase).toBe("refused");
      expect(stream.refusal).toBe("connection refused again");
      // And the failed attempt leaves no lease behind for the next retry to
      // collide with.
      expect(stream.subscription).toBeUndefined();
    });
  });
});
