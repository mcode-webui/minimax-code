// The command workflow.
//
// The composer's slash-command runner was the one business request a component
// still issued straight through the transport (`runCommand({...})` inside the
// `SessionComposer`). It moves here so the component submits a
// workflow and holds no transport call, exactly as the session and execution
// commands already do.
//
// It is deliberately thin: `runCommand` is a request the runtime answers, with
// no browser state to reconcile on success. The point is not to add logic but
// to remove the direct transport edge from the presentation layer, so the one
// place a command reaches the wire is the application.
//
// The queue's read and its remove belong here for the same reason and with the same shape:
// `refreshQueue` and `removeQueued` are this owner's commands, and the component held both as
// props. What the caller does with the answer — applying it to the queue mirror the store owns —
// stays with the caller; nothing here holds state.

import type { ComposerPort } from "../contracts/command-port.js";

type CommandPort = Pick<
  ComposerPort,
  "runCommand" | "listQueueMessages" | "deleteQueueItem"
>;

export type WebuiRunCommandRequest = Parameters<
  NonNullable<ComposerPort["runCommand"]>
>[0];
export type WebuiRunCommandResult = Awaited<
  ReturnType<NonNullable<ComposerPort["runCommand"]>>
>;
export type WebuiQueueAnswer = Awaited<
  ReturnType<NonNullable<ComposerPort["listQueueMessages"]>>
>;

export interface WebuiCommandWorkflows {
  /** Whether a command runner is wired. */
  readonly canRunCommand: boolean;
  /** Run one slash command through the transport. */
  readonly runCommand: (request: WebuiRunCommandRequest) => Promise<WebuiRunCommandResult>;
  /** Whether the queue's read is wired. */
  readonly canRefreshQueue: boolean;
  /** Read one session's queue; the answer is the caller's to apply. */
  readonly refreshQueue: (sessionId: string) => Promise<WebuiQueueAnswer | undefined>;
  /** Whether removing a queued item is wired. */
  readonly canRemoveQueued: boolean;
  /** Remove one queued item by identity. */
  readonly removeQueued: (request: {
    readonly sessionId: string;
    readonly itemId: string;
  }) => Promise<void>;
}

export function createWebuiCommandWorkflows(deps: {
  readonly port: CommandPort;
}): WebuiCommandWorkflows {
  const { port } = deps;
  return {
    canRunCommand: port.runCommand !== undefined,
    runCommand: async (request) => {
      if (!port.runCommand) return {};
      return port.runCommand(request);
    },
    canRefreshQueue: port.listQueueMessages !== undefined,
    refreshQueue: async (sessionId) => {
      const list = port.listQueueMessages;
      if (!list) return undefined;
      return list({ id: sessionId });
    },
    canRemoveQueued: port.deleteQueueItem !== undefined,
    removeQueued: async (request) => {
      const remove = port.deleteQueueItem;
      if (!remove) return;
      await remove({ id: request.sessionId, itemId: request.itemId });
    },
  };
}
