// The shared event corpus's live WebUI consumer.
//
// `packages/local-runtime-v2/test/fixtures/event-corpus/` is owned by the
// runtime maintainers: each file records one harness event shape next to the
// projection outcome the recording client expected, and its README asks every
// client to keep its own reducer covered against the same corpus.
//
// The corpus's WebUI consumer used to be `server/projections/index.ts`'s
// session-stream projection. That projection is gone — it attached a
// per-session snapshot to every stream frame and nothing on the client read it
// — so this file re-points the corpus at the module that actually renders:
// `client/features/turn/application/effect-reducer.ts` through
// `client/features/interactions/projection/event-parsers.ts`.
//
// Every expected value below is read from the fixture, never from an
// implementation constant, so a change on either side fails the test.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  applyWebuiEffectCommands,
  reduceWebuiSessionStatePatch,
  type WebuiEffectHandlers,
} from "../../src/client/features/turn/application/event-coordinator.js";
import {
  initialWebuiEffectState,
  reduceWebuiEffect,
  type WebuiEffectState,
} from "../../src/client/features/turn/application/effect-reducer.js";
import { eventSessionId } from "../../src/client/projection/common/event-parsers.js";
import { initialWebuiStreamState } from "../../src/client/features/turn/projection/stream-state.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";

interface CorpusFixture {
  readonly frame: { readonly eventJson: string };
  readonly expected: Record<string, unknown>;
}

const CORPUS = [
  "permission.ask",
  "permission.resolved",
  "questionnaire.ask",
  "questionnaire.dismissed",
  "compaction.completed",
] as const;

function fixture(name: string): CorpusFixture {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../local-runtime-v2/test/fixtures/event-corpus/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as CorpusFixture;
}

function corpusEvent(value: CorpusFixture): WebuiRuntimeEvent {
  return JSON.parse(value.frame.eventJson) as WebuiRuntimeEvent;
}

function sessionIdOf(value: CorpusFixture): string {
  const sessionId = eventSessionId(corpusEvent(value));
  if (sessionId === undefined) throw new Error("fixture carries no session id");
  return sessionId;
}

/**
 * Drive one fixture through the live reducer from `from`, applying each
 * command to a local state object the way the application's writers do.
 * `set-sending` writes a slice this state does not carry, so it is recorded
 * rather than folded in.
 */
function reduceFixture(
  from: WebuiEffectState,
  value: CorpusFixture,
): WebuiEffectState {
  const result = reduceWebuiEffect(from, corpusEvent(value), sessionIdOf(value));
  let state = from;
  const handlers: WebuiEffectHandlers = {
    refreshPending: () => undefined,
    refreshGoal: () => undefined,
    applyPatches: (patches) => {
      // `reduceWebuiSessionStatePatch` expects the writable session shape,
      // which carries the `sending` flag the `WebuiEffectState` slice omits.
      // The corpus fixtures never produce `set-sending` patches, so the field
      // stays at its seed value end-to-end and is discarded on the way out.
      const augmented = patches.reduce(reduceWebuiSessionStatePatch, {
        ...state,
        sending: false,
      });
      const { sending: _sending, ...next } = augmented;
      void _sending;
      state = next;
    },
    setGoal: (goal) => {
      state = { ...state, goal };
    },
  };
  applyWebuiEffectCommands(result.commands, handlers, () => state.stream);
  return state;
}

function initial(): WebuiEffectState {
  return initialWebuiEffectState(initialWebuiStreamState);
}

describe("the shared event corpus reaches the live WebUI reducer", () => {
  it("carries the session id every fixture records", () => {
    for (const name of CORPUS) {
      const value = fixture(name);
      expect(eventSessionId(corpusEvent(value))).toBe(value.expected.sessionId);
    }
  });

  it("lands a permission.ask fixture as a pending permission", () => {
    const value = fixture("permission.ask");
    const state = reduceFixture(initial(), value);
    expect(state.permissions.map((permission) => permission.requestId)).toEqual([
      value.expected.permissionRequestId,
    ]);
    // The reducer also parks the turn: the composer waits on the answer.
    expect(state.stream.phase).toBe("waiting");
  });

  it("clears the pending permission a permission.resolved fixture names", () => {
    const resolved = fixture("permission.resolved");
    const state = reduceFixture(
      reduceFixture(initial(), fixture("permission.ask")),
      resolved,
    );
    expect(resolved.expected.permissionRequestId).toBeNull();
    expect(state.permissions).toHaveLength(0);
  });

  it("lands a questionnaire.ask fixture as the pending questionnaire", () => {
    const value = fixture("questionnaire.ask");
    const state = reduceFixture(initial(), value);
    expect(state.questionnaire?.id).toBe(value.expected.questionnaireRequestId);
  });

  it("clears the questionnaire a questionnaire.dismiss fixture names", () => {
    const dismissed = fixture("questionnaire.dismissed");
    const state = reduceFixture(
      reduceFixture(initial(), fixture("questionnaire.ask")),
      dismissed,
    );
    expect(dismissed.expected.questionnaireRequestId).toBeNull();
    expect(state.questionnaire).toBeUndefined();
  });

  it("reduces a compaction.completed fixture without inventing interaction state", () => {
    // `expected.compaction` was the removed server projection's output; no
    // client surface reads a compaction *event*. What a live consumer still
    // honours is the session id (asserted above) and the reducer leaving the
    // interaction state untouched.
    const state = reduceFixture(initial(), fixture("compaction.completed"));
    expect(state.permissions).toEqual([]);
    expect(state.questionnaire).toBeUndefined();
  });
});
