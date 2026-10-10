// Terminal capability port.
//
// Terminal create/list/write/dispose and the per-terminal frame stream. Split
// from the monolithic `WebuiTransport` in the former `client/contracts.ts`;
// `transport.ts` composes it. Every method stays optional — `undefined` means
// "the operation is not wired".

import type { WebuiTerminalFrame } from "../../shared/contracts/terminal.js";

export interface TerminalPort {
  readonly createTerminal?: (request: {
    readonly workspaceDir: string;
  }) => Promise<{ readonly terminalId: string; readonly status: string }>;
  readonly listTerminals?: () => Promise<readonly Record<string, unknown>[]>;
  readonly writeTerminal?: (request: {
    readonly terminalId: string;
    readonly data: string;
  }) => Promise<unknown>;
  readonly disposeTerminal?: (request: {
    readonly terminalId: string;
  }) => Promise<unknown>;
  readonly watchTerminal?: (
    request: { readonly terminalId: string },
    onFrame: (frame: WebuiTerminalFrame) => void,
  ) => () => void;
}
