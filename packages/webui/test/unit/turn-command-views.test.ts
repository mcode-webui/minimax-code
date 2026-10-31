// The writer-command regroup.
//
// `session-commands.ts` used to publish one `WebuiSessionCommands` bag of eleven
// members plus a separate four-member `WebuiInteractionCommands`. The regroup
// makes the three views — **stream phase**, **turn lifecycle** and
// **interaction** — three separate objects, each with its own factory and its
// own injected write targets, so a consumer handed one view cannot reach
// another's commands.
//
// This file is the disposition record in executable form. `DISPOSITION` below
// is the complete enumeration of the writer commands that existed before the
// regroup, each assigned to exactly one view — including `clearStream` — and
// the assertions check that the published views are exactly that partition:
// nothing dropped, nothing duplicated, and no member reachable from a view it
// does not belong to.
//
// `RETIRED` records the one command that was later withdrawn from a view, and
// why. It is checked too: a command that was retired on purpose must stay
// retired, and its return has to be a deliberate act rather than a copy that
// found its way back.
//
// Interface *counts* are deliberately not asserted: what matters is that each
// member has one home and that the homes are disjoint.

import { describe, expect, it, vi } from "vitest";

import { createWebuiInteractionCommands } from "../../src/client/features/sessions/application/session-commands.js";
import { createWebuiStreamPhaseCommands } from "../../src/client/features/turn/application/stream-phase-commands.js";
import { createWebuiTurnLifecycleCommands } from "../../src/client/features/turn/application/turn-lifecycle-commands.js";
import { initialWebuiStreamState } from "../../src/client/features/turn/projection/stream-state.js";
import type { WebuiStreamState } from "../../src/client/features/turn/projection/stream-state.js";

/** The view a command belongs to, and why. */
const DISPOSITION: readonly {
  readonly view: "stream-phase" | "turn-lifecycle" | "interaction";
  readonly member: string;
}[] = [
  // Stream phase: the five commands that write `phase` and nothing else.
  { view: "stream-phase", member: "markStreamPhase" },
  { view: "stream-phase", member: "startStreaming" },
  { view: "stream-phase", member: "endStreaming" },
  { view: "stream-phase", member: "awaitInteraction" },
  { view: "stream-phase", member: "settleStoppedStream" },
  // Turn lifecycle: opening, clearing, recording and closing a turn's stream.
  // `resetStreamForTurn` opens one; `clearStream` clears the slice for New Task
  // (it is a whole-slice reset, not a phase move, so it is not in the phase
  // view); `setStreamRefusal` records its failure; `setTurnSending` is the
  // submit-lifecycle flag; `releaseStreamSubscription` closes its lease.
  { view: "turn-lifecycle", member: "resetStreamForTurn" },
  { view: "turn-lifecycle", member: "clearStream" },
  { view: "turn-lifecycle", member: "setStreamRefusal" },
  { view: "turn-lifecycle", member: "setTurnSending" },
  { view: "turn-lifecycle", member: "releaseStreamSubscription" },
  // Interaction: unchanged, and validated separately (it writes permissions,
  // the questionnaire and the goal — none of them the stream slice).
  { view: "interaction", member: "replacePendingPermissions" },
  { view: "interaction", member: "removePendingPermission" },
  { view: "interaction", member: "applyQuestionnaire" },
  { view: "interaction", member: "applyGoal" },
];

const membersFor = (view: string): string[] =>
  DISPOSITION.filter((entry) => entry.view === view).map((entry) => entry.member);

/**
 * The commands that were withdrawn from a view, and what withdrew them.
 *
 * `setContextUsage` applied a HISTORY-derived context snapshot to the LIVE
 * turn's record. That put a fact the turn did not produce into the record that
 * owns the turn, and the record is reset every time a turn starts — so the
 * reading was lost with it, and a read that lost its race with a page refresh
 * left the composer's ring blank with nothing to retry it. The reading now
 * comes from the record that owns it (the live turn while one runs, the
 * transcript page otherwise), so there is nothing for this command to write.
 */
const RETIRED: readonly {
  readonly view: "turn-lifecycle";
  readonly member: string;
  readonly because: string;
}[] = [
  {
    view: "turn-lifecycle",
    member: "setContextUsage",
    because: "a history reading does not belong on the live turn's record",
  },
];

/** One writer over one cell, so a view's writes can be observed directly. */
function cell() {
  let current: WebuiStreamState = initialWebuiStreamState;
  const sendings: boolean[] = [];
  return {
    get state(): WebuiStreamState {
      return current;
    },
    get sendings(): readonly boolean[] {
      return sendings;
    },
    setStream: (update: (current: WebuiStreamState) => WebuiStreamState) => {
      current = update(current);
    },
    setSending: (sending: boolean) => sendings.push(sending),
  };
}

function views() {
  const write = cell();
  return {
    write,
    phase: createWebuiStreamPhaseCommands({ setStream: write.setStream }),
    lifecycle: createWebuiTurnLifecycleCommands({
      setStream: write.setStream,
      setSending: write.setSending,
    }),
    interaction: createWebuiInteractionCommands({
      setPermissions: () => undefined,
      setQuestionnaire: () => undefined,
      setGoal: () => undefined,
    }),
  };
}

describe("every writer command is enumerated and assigned to one view", () => {
  it("publishes a partition: no member dropped, none duplicated", () => {
    const { phase, lifecycle, interaction } = views();
    expect(Object.keys(phase).sort()).toEqual(membersFor("stream-phase").sort());
    expect(Object.keys(lifecycle).sort()).toEqual(membersFor("turn-lifecycle").sort());
    expect(Object.keys(interaction).sort()).toEqual(membersFor("interaction").sort());

    const all = DISPOSITION.map((entry) => entry.member);
    // Nothing duplicated: the regroup must not widen a surface.
    expect(new Set(all).size).toBe(all.length);
    // Nothing dropped: the union across the views is exactly the roster.
    const published = [
      ...Object.keys(phase),
      ...Object.keys(lifecycle),
      ...Object.keys(interaction),
    ];
    expect(published.sort()).toEqual([...all].sort());
  });

  it("assigns clearStream to the lifecycle view, and keeps it out of the phase view", () => {
    const { phase, lifecycle } = views();
    // Explicit, not incidental: it is a whole-slice write that the phase
    // view's single-field rule cannot hold.
    expect(Object.keys(lifecycle)).toContain("clearStream");
    expect(phase).not.toHaveProperty("clearStream");
  });

  it("keeps the retired commands retired", () => {
    const { phase, lifecycle, interaction } = views();
    for (const entry of RETIRED) {
      expect(lifecycle).not.toHaveProperty(entry.member);
      expect(phase).not.toHaveProperty(entry.member);
      expect(interaction).not.toHaveProperty(entry.member);
    }
  });
});

describe("a consumer of one view cannot reach another view's commands", () => {
  it("keeps the three surfaces disjoint at runtime", () => {
    const { phase, lifecycle, interaction } = views();
    for (const member of membersFor("turn-lifecycle")) {
      expect(phase).not.toHaveProperty(member);
      expect(interaction).not.toHaveProperty(member);
    }
    for (const member of membersFor("stream-phase")) {
      expect(lifecycle).not.toHaveProperty(member);
      expect(interaction).not.toHaveProperty(member);
    }
    for (const member of membersFor("interaction")) {
      expect(phase).not.toHaveProperty(member);
      expect(lifecycle).not.toHaveProperty(member);
    }
  });

  it("writes only the phase from the phase view", () => {
    const { phase, write } = views();
    write.setStream((current) => ({ ...current, messages: [] }));
    phase.markStreamPhase("refused");
    expect(write.state.phase).toBe("refused");
    // Nothing else on the slice moved, and the `sending` flag was never in
    // reach: the phase view's targets carry no `setSending`.
    expect(write.state.messages).toEqual([]);
    expect(write.sendings).toEqual([]);
  });

  it("writes the sending flag only from the lifecycle view", () => {
    const { lifecycle, write } = views();
    lifecycle.setTurnSending(true);
    lifecycle.clearStream();
    expect(write.sendings).toEqual([true]);
    expect(write.state).toEqual(initialWebuiStreamState);
  });
});

describe("the views are the composition a turn command writer uses", () => {
  it("reaches only the lifecycle view's open/refuse/sending writes", async () => {
    const { lifecycle, write } = views();
    const settle = vi.fn();
    lifecycle.resetStreamForTurn();
    expect(write.state.phase).toBe("streaming");
    expect(typeof write.state.processingStartedAtMs).toBe("number");
    lifecycle.setStreamRefusal("upstream refused");
    expect(write.state.refusal).toBe("upstream refused");
    settle();
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

/**
 * The same claims as types. `Extract<…>` collapses to `never` while a view holds
 * none of another view's members; if one is ever added the `const` below stops
 * compiling, and `pnpm typecheck:webui-full` is the gate that holds it.
 */
type AcrossViews = Extract<
  keyof ReturnType<typeof createWebuiStreamPhaseCommands>,
  keyof ReturnType<typeof createWebuiTurnLifecycleCommands>
>;
type OnlyTrue<T extends true> = T;

const viewsAreDisjoint: OnlyTrue<AcrossViews extends never ? true : never> = true;

describe("the view types are disjoint", () => {
  it("share no member name between the phase and lifecycle views", () => {
    expect(viewsAreDisjoint).toBe(true);
  });
});
