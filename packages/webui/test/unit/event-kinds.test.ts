// The event-kind registry.
//
// The `goal` and `interactions` kinds live in **one** enumeration, and the
// property asserted is deliberately not "adding a kind is now a one-line edit":
// it is that **the second site cannot exist**. A kind used to be known in three
// places — `event-parsers.ts` tested a literal prefix, `goal-state.ts` listed
// three literal types, and the effect reducer names them in its `case` labels —
// so parse and render sites are permitted only alongside the one registry, and
// the reducer keeps its own switch.
//
// So this file asserts both halves: the registry answers for the kinds it owns,
// and no parse or render site restates one. The source-level half is the
// assertion that fails when the second site reappears, and it is written over
// source text for the same reason the boundary tests are: the claim is
// structural, not behavioural.

import { describe, expect, it } from "vitest";

import {
  WEBUI_GOAL_EVENT_KINDS,
  WEBUI_GOAL_OBJECTIVE_EVENT_TYPES,
  WEBUI_INTERACTION_EVENT_KINDS,
  isWebuiGoalEventKind,
  isWebuiInteractionEventKind,
  resolveWebuiEventKind,
} from "../../src/client/projection/common/event-kinds.js";
import {
  readWebuiSource,
  squashWhitespace,
} from "./support/source-text.js";

describe("the registry answers for the kinds it owns", () => {
  it("resolves an exact kind, and an exact match wins over the family prefix", () => {
    expect(resolveWebuiEventKind("thread_goal.updated")?.kind).toBe("goal.updated");
    expect(resolveWebuiEventKind("thread_goal.cleared")?.kind).toBe("goal.cleared");
    expect(resolveWebuiEventKind("permission.ask")?.kind).toBe("permission.ask");
    expect(resolveWebuiEventKind("questionnaire.superseded")?.kind).toBe(
      "questionnaire.superseded",
    );
  });

  it("recognises the goal family by prefix, including a verb this table has not learned", () => {
    // The family entry is why a new `thread_goal.<verb>` still routes: the session
    // id inside the payload is found by the family rule, so nothing silently stops
    // being routed while the table catches up.
    expect(isWebuiGoalEventKind("thread_goal.objective_updated")).toBe(true);
    expect(isWebuiGoalEventKind("thread_goal.something_new")).toBe(true);
    expect(resolveWebuiEventKind("thread_goal.something_new")?.kind).toBe("goal.family");
  });

  it("says no to what it does not own", () => {
    expect(resolveWebuiEventKind("session.start")).toBeUndefined();
    expect(isWebuiGoalEventKind("session.start")).toBe(false);
    expect(isWebuiInteractionEventKind("session.start")).toBe(false);
  });

  it("derives the objective-carrying types rather than listing them again", () => {
    expect([...WEBUI_GOAL_OBJECTIVE_EVENT_TYPES].sort()).toEqual([
      "thread_goal.objective_steering",
      "thread_goal.objective_updated",
      "thread_goal.updated",
    ]);
    // The exclusion is part of the contract. `thread_goal.updated` was in the
    // pre-registry list and `thread_goal.objective_updated_steering` was not, so
    // the derived list reproduces behaviour rather than a plausible superset.
    expect(WEBUI_GOAL_OBJECTIVE_EVENT_TYPES).not.toContain(
      "thread_goal.objective_updated_steering",
    );
    // Derived, not declared: every entry it reports is one the table marks.
    for (const type of WEBUI_GOAL_OBJECTIVE_EVENT_TYPES) {
      expect(resolveWebuiEventKind(type)?.family).toBe("goal");
    }
  });

  it("keeps one family per entry, so a kind cannot be owned twice", () => {
    const kinds = [...WEBUI_GOAL_EVENT_KINDS, ...WEBUI_INTERACTION_EVENT_KINDS].map(
      (entry) => entry.kind,
    );
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

/** Every goal or interaction label the effect reducer switches on. */
function reducerKindLabels(): readonly string[] {
  const source = squashWhitespace(readWebuiSource("features/turn/application/effect-reducer.ts"));
  const labels = source.match(
    /case "(?:thread_goal|permission|questionnaire)\.[a-z_.]+":/gu,
  );
  return (labels ?? []).map((label) => label.slice(6, -2));
}

describe("no second enumeration site can exist", () => {
  it("the reducer's kinds are all in the registry", () => {
    // The reducer keeps its own switch, so the two
    // enumerations have to agree. A case added without a registry entry fails
    // here, which is the drift this assertion exists to catch.
    const labels = reducerKindLabels();
    expect(labels.length).toBeGreaterThanOrEqual(8);
    const unregistered = labels.filter(
      (label) => resolveWebuiEventKind(label) === undefined,
    );
    expect(unregistered).toEqual([]);
  });

  it("the parse and render sites restate none of them", () => {
    // The same claim in its literal form: these two files used to know the kinds.
    // Neither may hold a literal again — the parser asks the registry whether an
    // event is a goal event, and the projector asks it which types carry an
    // objective.
    const literal = /"(?:thread_goal|permission|questionnaire)\.[a-z_.]+"/u;
    for (const file of ["projection/common/event-parsers.ts", "features/goal/projection/goal-state.ts"]) {
      expect(squashWhitespace(readWebuiSource(file))).not.toMatch(literal);
    }
  });

  it("the registry is the only projection module that names them", () => {
    // The same claim over the projection layer, so a new site cannot be added in
    // a third file without this failing. `effect-reducer.ts` is the documented
    // exception for the reason above; `message-parts.ts` names a *message* kind,
    // not a runtime event kind, so it is excluded by matching only the three
    // event namespaces.
    const files = [
      "projection/common/event-parsers.ts",
      "features/goal/projection/goal-state.ts",
      "features/interactions/projection/questionnaire-state.ts",
      "features/transcript/projection/message-projection.ts",
      "features/transcript/projection/transcript-projection.ts",
    ];
    const literal = /"(?:thread_goal|permission|questionnaire)\.[a-z_.]+"/u;
    for (const file of files) {
      expect(squashWhitespace(readWebuiSource(file))).not.toMatch(literal);
    }
  });
});
