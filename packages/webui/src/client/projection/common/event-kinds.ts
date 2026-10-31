// The event-kind registry.
//
// **What this file is for.** A new event kind used to mean editing every place
// that knows how to recognise one: the parser that turns a payload into a view,
// the render path that decides what to draw, and — for the kinds that move state
// — the effect reducer.
//
// So this is the **one** enumeration for the kinds the `goal` and `interactions`
// businesses own. A parse site asks it whether an event is a goal event instead
// of testing a literal prefix; a render site asks it which kind it is holding
// instead of re-listing the names. The effect reducer keeps its own `case` labels
// — a purely presentational kind leaves it untouched — and
// `event-kinds.test.ts` asserts the two enumerations cannot drift: every goal or
// interaction label in the reducer has to be in this table, and no parse or
// render site may restate one.
//
// **Goal is matched by prefix and the interactions by exact type, and that
// difference is data here, not a convention at each call site.** The goal family
// arrives as `thread_goal.<verb>` and a new verb is a new kind in the same family;
// the interaction kinds are discrete names. Keeping both as `match` rules means a
// parser needs no knowledge of which family behaves which way.

/** One kind of runtime event, as the parse and render paths see it. */
export interface WebuiEventKindEntry {
  /** The stable key callers switch on. */
  readonly kind: string;
  /** Which business owns the event. */
  readonly family: "goal" | "interaction";
  /**
   * How an event type is recognised: an exact `type`, or a `prefix` for the
   * families that arrive as `<family>.<verb>`.
   */
  readonly match:
    | { readonly type: string }
    | { readonly prefix: string };
  /**
   * Whether this kind carries the objective text a steering re-read has to
   * replace. The goal banner re-reads on these and not on the others, and that
   * subset used to be a second literal list in `goal-state.ts`.
   */
  readonly carriesObjective?: boolean;
}

/** The goal family: `thread_goal.<verb>`. */
export const WEBUI_GOAL_EVENT_KINDS = [
  {
    kind: "goal.updated",
    family: "goal",
    match: { type: "thread_goal.updated" },
    carriesObjective: true,
  },
  {
    kind: "goal.objective-updated",
    family: "goal",
    match: { type: "thread_goal.objective_updated" },
    carriesObjective: true,
  },
  {
    kind: "goal.objective-steering",
    family: "goal",
    match: { type: "thread_goal.objective_steering" },
    carriesObjective: true,
  },
  // The reducer knows this kind, and `projectWebuiThreadGoalMessage` deliberately
  // does **not** project a goal message from it: the pre-registry code listed
  // exactly `objective_updated`, `objective_steering` and `updated`, and this
  // registry reproduces that set rather than a plausible-looking one. `carriesObjective`
  // therefore means "projects the goal message", not "mentions an objective".
  {
    kind: "goal.objective-updated-steering",
    family: "goal",
    match: { type: "thread_goal.objective_updated_steering" },
  },
  { kind: "goal.cleared", family: "goal", match: { type: "thread_goal.cleared" } },
  // A safety net for a verb of the same family this table has not learned yet:
  // the family is recognised, so the session id inside the payload is still
  // found, and nothing silently stops routing an event it used to route.
  { kind: "goal.family", family: "goal", match: { prefix: "thread_goal." } },
] as const satisfies readonly WebuiEventKindEntry[];

/** The interaction family: pending permissions and questionnaires. */
export const WEBUI_INTERACTION_EVENT_KINDS = [
  { kind: "permission.ask", family: "interaction", match: { type: "permission.ask" } },
  {
    kind: "permission.resolved",
    family: "interaction",
    match: { type: "permission.resolved" },
  },
  {
    kind: "questionnaire.ask",
    family: "interaction",
    match: { type: "questionnaire.ask" },
  },
  {
    kind: "questionnaire.dismiss",
    family: "interaction",
    match: { type: "questionnaire.dismiss" },
  },
  {
    kind: "questionnaire.superseded",
    family: "interaction",
    match: { type: "questionnaire.superseded" },
  },
] as const satisfies readonly WebuiEventKindEntry[];

/** Every kind this registry owns. */
export const WEBUI_EVENT_KINDS: readonly WebuiEventKindEntry[] = [
  ...WEBUI_GOAL_EVENT_KINDS,
  ...WEBUI_INTERACTION_EVENT_KINDS,
];

/**
 * The event **types** that carry the objective, derived from the table — never
 * restated at a call site. `goal-state.ts` used to list three literals to decide
 * whether a goal event projects a transcript message, which was a second place
 * that had to learn a new verb.
 */
export const WEBUI_GOAL_OBJECTIVE_EVENT_TYPES: readonly string[] =
  WEBUI_GOAL_EVENT_KINDS.filter(
    (entry) => "carriesObjective" in entry && entry.carriesObjective === true,
  ).map((entry) => ("type" in entry.match ? entry.match.type : entry.match.prefix));

function matches(entry: WebuiEventKindEntry, type: string): boolean {
  return "type" in entry.match
    ? entry.match.type === type
    : type.startsWith(entry.match.prefix);
}

/**
 * The kind an event type belongs to, or `undefined` when the registry does not
 * own it. Exact matches win over a family prefix, so `thread_goal.updated`
 * resolves to `goal.updated` rather than to the family entry.
 */
export function resolveWebuiEventKind(
  type: string,
): WebuiEventKindEntry | undefined {
  const exact = WEBUI_EVENT_KINDS.find(
    (entry) => "type" in entry.match && entry.match.type === type,
  );
  if (exact) return exact;
  return WEBUI_EVENT_KINDS.find(
    (entry) => "prefix" in entry.match && matches(entry, type),
  );
}

/** Whether an event type belongs to the goal family. */
export function isWebuiGoalEventKind(type: string): boolean {
  return resolveWebuiEventKind(type)?.family === "goal";
}

/** Whether an event type belongs to the interaction family. */
export function isWebuiInteractionEventKind(type: string): boolean {
  return resolveWebuiEventKind(type)?.family === "interaction";
}
