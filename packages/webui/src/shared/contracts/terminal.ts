// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiTerminalFrame` | One terminal output frame (terminalId, data, exited). | Server `WebuiTerminalManager.watch` (`server/terminal.ts`, via the `watchTerminal` handler). | `client/contracts/terminal-port.ts`; `client/transport.ts`. |
// | `WebuiRunCommandRequest` | A slash-command run request (command, input, session/agent/workspace). | Browser `client/transport.ts` (`runCommand`). | `server/operation/provider.ts` (`runCommandOperation`). |
// | `WebuiRunCommandResult` | The command outcome (handled output/data). | Runtime `runWebuiCommand` (`runtime/commands/runner.ts`). | `server/operation/operation-handlers.ts` `runCommand`; `server/operation/provider.ts`. |
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
