// The session event vocabulary this client accepts, as a closed list.
//
// The wire carries `type` as a string, and until this file existed the client's
// vocabulary was implicit: `readWebuiSessionFact` had a `switch` and everything else
// fell into the same silence as an event that was never routed at all. A fact the
// runtime started publishing therefore reached no page and nothing failed — the
// client would simply stop being current about it.
//
// Two lists, one decision each:
//
//   * `WEBUI_SESSION_FACT_TYPES` — the catalogue facts the runtime publishes about a
//     session's lifecycle. Every one of them is either applied by the decoder or
//     named in its deliberately-unapplied list, and the decoder asserts that
//     partition exhaustively, so adding a name here forces the decision.
//   * `WEBUI_NON_CATALOGUE_SESSION_EVENTS` — event names that share the vocabulary
//     but are not catalogue facts: turn progress, queue state, and the local session
//     index. The client routes each of them elsewhere, and they are written down
//     with the reason so "not handled here" is a statement rather than an omission.
//
// The host-derived union is generated from actual runtime event declarations.
// WebUI typechecking first checks source freshness, and the decoder's partition
// checks this union rather than a second hand-written list. Regenerating after a
// new host fact therefore forces an explicit decoder decision before compilation.
import type { HostPublishedEventType } from "./host-event-types.generated.js";

// Compatibility with older hosts/TUI producers; these names are not emitted by
// the current local-runtime-v2 tree. They remain explicit rather than widening to string.
type LegacySessionFactType = "session.renamed" | "session.pinned_updated" | "rotation.completed";

/** A session catalogue fact: something the runtime publishes about a session. */
export const WEBUI_SESSION_FACT_TYPES = [
  // Applied by the session-fact decoder.
  "session.created",
  "session.renamed",
  "session.title_updated",
  "session.model_updated",
  "session.interaction_mode.changed",
  "session.visibility_updated",
  "session.pinned_updated",
  "session.deleted",
  // Received and deliberately not applied, with the reason at the list in
  // `features/turn/application/session-fact.ts`.
  "session.compaction.started",
  "session.compaction.completed",
  "session.compaction.failed",
  "session.llm_retry",
  "message.rewind",
  "agent.created",
  "agent.updated",
  "rotation.completed",
  "content.retry.exceeded",
] as const satisfies readonly WebuiSessionFactType[];

export type WebuiSessionFactType = Exclude<HostPublishedEventType,
  (typeof WEBUI_NON_CATALOGUE_SESSION_EVENTS)[number]["type"]> | LegacySessionFactType;

/** One event name in the vocabulary that is not a session catalogue fact. */
export interface WebuiNonCatalogueSessionEvent {
  readonly type: string;
  /** Who handles it, so a reader knows where "not here" sends it. */
  readonly handledBy: string;
}

/**
 * Names that are not catalogue facts.
 *
 * Each is published by the runtime and consumed by another route in this client —
 * the turn effect reducer, the queue view, the event coordinator's own paths, or the
 * local session index. Listing them turns "the decoder does not answer for this" into
 * a claim with an owner.
 */
export const WEBUI_NON_CATALOGUE_SESSION_EVENTS = [
  { type: "session.start", handledBy: "turn/application/effect-reducer" },
  { type: "session.finish", handledBy: "turn/application/effect-reducer" },
  { type: "session.abort", handledBy: "turn/application/effect-reducer" },
  { type: "session.error", handledBy: "turn/application/effect-reducer" },
  { type: "session.queue.updated", handledBy: "turn/application/event-coordinator" },
  { type: "session.discovered", handledBy: "the runtime's own session index, not the wire catalogue" },
] as const satisfies readonly WebuiNonCatalogueSessionEvent[];
