// The workspace-progress view the panels and the shell read.
//
// What is left here: the consolidated view selector and the history rebuild,
// both consumed by surfaces (the shell, the workspace panels). The reducers and
// their event-name tables moved to `features/workspace/contracts/progress.ts`
// because the conversation substrate folds stream-frame events into the progress
// slice and may not import another business's private projection; they are
// imported back above.
//
// The progress *types* live in `features/turn/contracts/stream-state.ts` (the
// stream state carries `workspaceProgress`) and are re-exported here so a reader
// of this module keeps one import for the view's shape.

import type { WebuiClientMessage } from "../../transcript/contracts/message-view.js";
import type {
  WebuiWorkspaceTodoStatus,
  WebuiWorkspaceTodo,
  WebuiWorkspaceSubagentStatus,
  WebuiWorkspaceSubagent,
  WebuiWorkspaceProgressState,
} from "../../turn/contracts/stream-state.js";
export type {
  WebuiWorkspaceTodoStatus,
  WebuiWorkspaceTodo,
  WebuiWorkspaceSubagentStatus,
  WebuiWorkspaceSubagent,
  WebuiWorkspaceProgressState,
} from "../../turn/contracts/stream-state.js";
import {
  applyTodoToolCalls,
  historyEvents,
  initialWebuiWorkspaceProgress,
  reduceWebuiWorkspaceProgressEvent,
} from "../contracts/progress.js";

/**
 * The consolidated progress view.
 *
 * Progress keeps **distinct source inputs, not multiple writable final
 * values**: the history baseline, the tree's child metadata and the live
 * overlay stay separate, and this one pure selector derives what the panel
 * renders. It is the shell's former inline merge moved into a testable domain
 * function, and it preserves the current precedence exactly:
 *
 *   * Todos are a *choice*, not a merge. A live todo snapshot overrides the
 *     history baseline — including an empty live snapshot, which still wins
 *     (`hasTodoSnapshot`). Without a live snapshot the history baseline shows.
 *   * Subagents merge history, then tree, then live, later sources winning per
 *     `sessionId`, and the result sorts by `createdAt` ascending.
 */
export interface WebuiWorkspaceProgressInputs {
  readonly history: WebuiWorkspaceProgressState;
  readonly treeSubagents: readonly WebuiWorkspaceSubagent[];
  readonly live: WebuiWorkspaceProgressState;
}

export interface WebuiWorkspaceProgressView {
  readonly todos: readonly WebuiWorkspaceTodo[];
  readonly subagents: readonly WebuiWorkspaceSubagent[];
}

export function selectWebuiWorkspaceProgress(
  inputs: WebuiWorkspaceProgressInputs,
): WebuiWorkspaceProgressView {
  const todos = inputs.live.hasTodoSnapshot
    ? inputs.live.todos
    : inputs.history.todos;
  const merged = new Map<string, WebuiWorkspaceSubagent>();
  for (const subagent of inputs.history.subagents)
    merged.set(subagent.sessionId, subagent);
  for (const subagent of inputs.treeSubagents)
    merged.set(subagent.sessionId, subagent);
  for (const subagent of inputs.live.subagents)
    merged.set(subagent.sessionId, {
      ...merged.get(subagent.sessionId),
      ...subagent,
    });
  const subagents = [...merged.values()].sort(
    (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
  );
  return { todos, subagents };
}

/** Rebuild the last known workspace-progress state when opening a session. */
export function projectWebuiWorkspaceHistory(
  messages: readonly WebuiClientMessage[],
  sessionId?: string,
): WebuiWorkspaceProgressState {
  let state = initialWebuiWorkspaceProgress;
  for (const message of messages) {
    state = applyTodoToolCalls(state, message);
    for (const event of historyEvents(message))
      state = reduceWebuiWorkspaceProgressEvent(state, event, sessionId);
  }
  return state;
}
