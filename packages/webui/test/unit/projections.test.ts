// The server-side projections the operation handlers still perform.
//
// `getMessages` enriches its response with the session context snapshot and the
// turn usage, so those two are what this file covers. The session-stream
// projection that used to be tested here is gone — it attached a per-session
// permission/compaction snapshot to every stream frame and nothing on the
// client read it. The shared event corpus it consumed is now covered against
// the live client reducer in `webui-event-corpus.test.ts`.
import { describe, expect, it } from "vitest";
import {
  projectContextSnapshot,
  projectUsage,
} from "../../src/server/projections/index.js";
import { isTurnCompactionMessage } from "../../src/server/projections/usage.js";

describe("WebUI server projections", () => {
  it("projects usage from completed message fixtures, not a wire event", () => {
    const messages = [
      {
        role: "assistant",
        turnId: "t1",
        kind: "compaction",
        usage: { totalTokens: 100 },
      },
      {
        role: "assistant",
        turnId: "t1",
        usage: { totalTokens: 20, inputTokens: 10 },
      },
    ];
    expect(
      isTurnCompactionMessage(
        { role: "assistant", kind: "compaction", turnId: "t1" },
        "t1",
      ),
    ).toBe(true);
    expect(projectUsage(messages, "t1")).toEqual({
      totalTokens: 20,
      inputTokens: 10,
    });
  });

  it("projects the latest context usage and compaction state", () => {
    // The message shape is the one a PERSISTED session message actually has:
    // the session message's view spells its usage `totalTokens` /
    // `contextWindow`. This test used to write
    // `contextUsage: { contextWindowTokens, usedTokens }`, which pinned a shape
    // no message in the database has ever had — so it passed green while the
    // composer's context readout rendered nowhere. It then pinned the
    // snake_case pair instead, which pinned the PROTOCOL's spelling rather
    // than the stored one, and the readout was still nowhere.
    //
    // The stored spelling is the one the session message's view publishes, so
    // that is what this fixture carries.
    expect(
      projectContextSnapshot({
        active: false,
        messages: [
          { kind: "compaction_start", timestamp: 1 },
          { kind: "compaction", timestamp: 2 },
          {
            rawJson: JSON.stringify({
              usage: { contextWindow: 100, totalTokens: 40 },
            }),
          },
        ],
      }),
    ).toMatchObject({
      status: "live",
      window: 100,
      usedTokens: 40,
      compaction: { state: "completed" },
    });
  });

  it("reads the stored camelCase spelling and publishes the protocol's names", () => {
    // The two spellings arrive from two different places and neither is wrong
    // on its own: the runtime PROTOCOL fixes `total_tokens` /
    // `context_window` on the wire, and the persisted session message carries
    // the same two numbers as `totalTokens` / `contextWindow`. A projection
    // that read only one of them answered half the sessions with a usage
    // record whose fields it could not see.
    //
    // It publishes the protocol's names either way, so the client reads ONE
    // shape and the two cannot drift apart again.
    const camelCase = projectContextSnapshot({
      active: false,
      messages: [
        { rawJson: JSON.stringify({ usage: { totalTokens: 7, contextWindow: 70 } }) },
      ],
    });
    expect(camelCase).toMatchObject({ status: "live", window: 70, usedTokens: 7 });
    expect(camelCase.usage).toMatchObject({ total_tokens: 7, context_window: 70 });

    const snakeCase = projectContextSnapshot({
      active: false,
      messages: [
        { rawJson: JSON.stringify({ usage: { total_tokens: 7, context_window: 70 } }) },
      ],
    });
    expect(snakeCase).toMatchObject({ status: "live", window: 70, usedTokens: 7 });
    expect(snakeCase.usage).toMatchObject({ total_tokens: 7, context_window: 70 });
  });

  it("keeps the usage record's own fields while normalising its names", () => {
    // The breakdown reads `components` off the record; a rename must not take
    // them with it.
    const snapshot = projectContextSnapshot({
      active: false,
      messages: [
        {
          rawJson: JSON.stringify({
            usage: { totalTokens: 7, contextWindow: 70, components: [{ kind: "MESSAGES", tokens: 4 }] },
          }),
        },
      ],
    });

    expect(snapshot.usage).toMatchObject({
      totalTokens: 7,
      total_tokens: 7,
      components: [{ kind: "MESSAGES", tokens: 4 }],
    });
  });

  it("reports empty rather than a fabricated zero for a turn that reported no usage", () => {
    // The failure mode this whole change is about: a shape mismatch must
    // surface as "no data", never as 0% — a zero would look like a real
    // reading of an untouched context.
    expect(
      projectContextSnapshot({
        active: false,
        messages: [{ rawJson: JSON.stringify({ finish_reason: "stop" }) }],
      }),
    ).toMatchObject({ status: "empty" });
  });
});
