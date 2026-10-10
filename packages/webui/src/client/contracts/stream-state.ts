// Client-side stream state contracts. These shapes are shared by the stream
// mechanism (`client/stream-loop.ts`, layer `mechanisms`) and the projections
// that reduce frames into them (`client/projection/stream-state.ts` and
// `client/projection/workspace-progress.ts`). A mechanism may import only
// `contracts` and `shared` (plan §7.2), so the state types live here instead of
// in the projection that reduces them: the loop operates on these types and
// must not reach into `view` to name them.

export type WebuiWorkspaceTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";
export interface WebuiWorkspaceTodo {
  readonly content: string;
  readonly status: WebuiWorkspaceTodoStatus;
  readonly priority?: "high" | "medium" | "low";
}
export type WebuiWorkspaceSubagentStatus =
  | "running"
  | "completed"
  | "error";
export interface WebuiWorkspaceSubagent {
  readonly sessionId: string;
  readonly agentName: string;
  readonly title?: string;
  readonly status: WebuiWorkspaceSubagentStatus;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly parentSessionId?: string;
}
export interface WebuiWorkspaceProgressState {
  readonly todos: readonly WebuiWorkspaceTodo[];
  readonly subagents: readonly WebuiWorkspaceSubagent[];
  readonly hasTodoSnapshot: boolean;
  readonly hasSubagentSnapshot: boolean;
}
export interface WebuiStreamMessage {
  readonly id: string;
  readonly answer: string;
  readonly thinking: string;
  readonly timestamp?: number;
  readonly isGoal?: boolean;
  readonly toolCalls?: readonly Record<string, unknown>[];
  /** Ordered Desktop activity parts carried by the existing agent_message frame. */
  readonly parts?: readonly Record<string, unknown>[];
  /** Runtime-reported `TokenUsage` (with `request_duration_ms` / `output_tokens`)
   *  from the agent_message wire frame. The WebUI uses it to render the
   *  Desktop-style "共执行 N 分 M 秒 · {rate} token/s" row. */
  readonly usage?: Record<string, unknown>;
  /** Runtime context-window snapshot attached to the assistant message. */
  readonly contextUsage?: Record<string, unknown>;
  /** The server replays the user's own line as a `msg-user-*` frame; it
   * renders as the right-aligned bubble instead of an assistant body. */
  readonly role?: "user";
}
/**
 * Which live stream this client currently holds for a session.
 *
 * A turn can start without this client sending anything — the goal flow posts
 * a hidden continuation prompt, a queued message drains, another client sends
 * — and those turns only reach the transcript if someone opens a stream. At
 * the same time a locally sent turn already owns one, and opening a second
 * would corrupt the state: chunks append in `applyFrameData`, so the answer
 * would double, and `applyFrameCursor` overwrites the cursor without comparing
 * order, so the resume point would follow whichever stream reported last.
 *
 * This field is deliberately independent of `phase`. `phase` answers "is a
 * turn live"; this answers "is *this* client attached to it".
 */
export interface WebuiStreamSubscription {
  /** `local-send` was opened by `sendMessage`; `recovered` was opened after
   * the server started a turn we did not initiate. */
  readonly owner: "local-send" | "recovered";
  /**
   * Turn this subscription belongs to. A local send does not know it yet —
   * `runWebuiStreamLoop` opens the stream before the runtime publishes
   * `session.start` — so it is adopted from the first matching event.
   */
  readonly turnId?: string;
  /**
   * Identifies the loop that opened this stream, so a loop that lost its lease
   * can recognise its own stale writes. Frames carry no turn id on the wire
   * (`WebuiStreamFrame` is cursor/event/data only), so turn id alone cannot
   * tell a superseded loop apart from the current one — and the window before
   * a local send learns its turn id is exactly when two loops are most
   * likely to overlap. A superseded stream is not cancelled by the server
   * (`resumeSession` exposes no handle), so without this field its late
   * chunks and its `[DONE]` would land in the store the new loop owns.
   */
  readonly generation: number;
}
export interface WebuiStreamState {
  /**
   * Generation of the most recent claim, kept even after the lease is
   * released. `subscription` answers "is a lease held right now"; this
   * answers "which loop is the newest one" — and that answer has to outlive
   * the release. If fencing only compared against the live subscription, a
   * superseded loop would start writing again the instant the newer turn's
   * `[DONE]` cleared the lease, and its late chunks would land in a session
   * that had already moved on.
   */
  readonly lastClaimedGeneration?: number;
  /** Live stream this client holds for the session, if any. */
  readonly subscription?: WebuiStreamSubscription;
  /** Turn start for the live 已执行 N 秒 row and the thinking counter. */
  readonly processingStartedAtMs?: number;
  readonly phase:
    | "idle"
    | "streaming"
    | "waiting"
    | "done"
    | "refused"
    | "error"
    | "reconnecting";
  readonly messages: readonly WebuiStreamMessage[];
  readonly runtimeEvents: readonly Record<string, unknown>[];
  readonly actionDeltas: readonly Record<string, unknown>[];
  /** Latest session context snapshot, restored from history and refreshed by live messages. */
  readonly contextUsage?: Record<string, unknown>;
  /** The session-scoped Todo/Subagent projection fed by Desktop-compatible events. */
  readonly workspaceProgress: WebuiWorkspaceProgressState;
  /** The server-owned projection snapshot carried by the current stream. */
  readonly projection?: unknown;
  readonly status?: string;
  readonly refusal?: string;
  /**
   * Stream cursor of the last fully-applied frame group. The cursor rides only
   * on the last mapped frame of each source-frame group, so it advances only
   * on cursor-bearing frames. Holding the cursor in the reducer means a
   * reconnect can resume from exactly where the rendered transcript left off
   * without ever landing mid-group.
   */
  readonly cursor?: string;
  /**
   * True when the server emitted `resume_overflow`: the client's view has
   * fallen too far behind and must reload authoritative history through
   * `getMessages` before establishing a new subscription.
   */
  readonly resumeRequired: boolean;
  /**
   * True when the loop ended in `refused` because a sink callback
   * failed after frames had already been accepted by the reducer.
   * The user-visible transcript may be incomplete — the frames the
   * shell rendered before the failure are authoritative, but later
   * frames from the same turn never reached the UI. The shell
   * renders a user-visible message alongside the refusal when this
   * flag is set. It is only set on the recoverable path (when the
   * raw refuse callback still works); the unrecoverable path (every
   * callback broken) is necessarily silent beyond `console.error`.
   */
  readonly transcriptIncomplete: boolean;
}
/**
 * What a release is allowed to clear. An empty scope releases whatever is
 * held; naming a `generation` or a `turnId` releases only a matching lease,
 * so a superseded loop's late terminal frame and a late terminal *event*
 * cannot strip the lease the current loop just took.
 */
export interface WebuiSubscriptionReleaseScope {
  readonly generation?: number;
  readonly turnId?: string;
}
/**
 * Recognised wire-frame payload kinds. The two consumers — the reducer
 * (state machine) and the loop's `captureFrame` (failure-signal
 * detection) — used to parse the same payload twice. Centralising the
 * recognition here lets both sides agree on what a `{type:…}` body
 * means without parsing the JSON twice, and keeps future envelope
 * additions in one place.
 */
export type WebuiStreamPayloadKind =
  | "empty"
  | "done"
  | "resume_overflow"
  | "heartbeat"
  | "agent_message"
  | "agent_message_chunk"
  | "session_status"
  | "generic_event";
export interface WebuiStreamPayloadRecognised {
  readonly kind: WebuiStreamPayloadKind;
  readonly event?: Record<string, unknown>;
}
