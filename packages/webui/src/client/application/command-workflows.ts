// The command workflow (plan §7.1 `application/`; ticket #49 criterion 8).
//
// The composer's slash-command runner was the one business request a component
// still issued straight through the transport (`runCommand({...})` inside the
// 3000-line `SessionComposer`). It moves here so the component submits a
// workflow and holds no transport call, exactly as the session and execution
// commands already do.
//
// It is deliberately thin: `runCommand` is a request the runtime answers, with
// no browser state to reconcile on success. The point is not to add logic but
// to remove the direct transport edge from the presentation layer, so the one
// place a command reaches the wire is the application.

import type { ExecutionPort } from "../contracts/execution-port.js";

type CommandPort = Pick<ExecutionPort, "runCommand">;

export type WebuiRunCommandRequest = Parameters<
  NonNullable<ExecutionPort["runCommand"]>
>[0];
export type WebuiRunCommandResult = Awaited<
  ReturnType<NonNullable<ExecutionPort["runCommand"]>>
>;

export interface WebuiCommandWorkflows {
  /** Whether a command runner is wired. */
  readonly canRunCommand: boolean;
  /** Run one slash command through the transport. */
  readonly runCommand: (request: WebuiRunCommandRequest) => Promise<WebuiRunCommandResult>;
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
  };
}
