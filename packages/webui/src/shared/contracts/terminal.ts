// Wire contract record: every exported declaration below records its wire
// purpose, its producer and its consumers, verified against the tree.
// Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiTerminalFrame` | One terminal output frame (terminalId, data, exited). | Runtime `WebuiTerminalManager.watch` (`runtime/terminal.ts`, via the `watchTerminal` handler). | `client/features/terminal/contracts/terminal-port.ts`; `client/platform/transport.ts`. |
// | `WebuiRunCommandRequest` | A slash-command run request (command, input, session/agent/workspace). | Browser `client/platform/transport.ts` (`runCommand`). | `runtime/commands/runner.ts`; `runtime/port.ts`. |
// | `WebuiRunCommandResult` | The command outcome (handled output/data). | Runtime `runWebuiCommand` (`runtime/commands/runner.ts`). | `server/operation/handlers/commands.ts` `runCommand`; `server/operation/provider.ts`. |
export interface WebuiTerminalFrame {
  readonly terminalId: string;
  readonly data: string;
  readonly exited: boolean;
}

export interface WebuiRunCommandRequest {
  readonly command: "help" | "new" | "compact" | "status" | "usage" | "model";
  readonly input?: string;
  readonly sessionId?: string;
  readonly agentName?: string;
  readonly workspaceDir?: string;
}

export type WebuiRunCommandResult =
  | { readonly handled: true; readonly output: string; readonly data?: unknown }
  | { readonly handled: true; readonly output?: undefined; readonly data: unknown };
