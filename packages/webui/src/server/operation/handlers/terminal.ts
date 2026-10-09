// Dedicated handlers: the terminal PTY bridge.
//
// The six terminal operations cannot be plain bindings: they drive a real
// second runtime surface (the PTY bridge the WebUI shares with the desktop),
// not a harness port method. `watchTerminal` is a stream. The adapter is only
// supplied by the service, and when it is absent these operations stay
// unregistered (see `operations.ts`) rather than becoming registered operations
// that fail with a missing-capability error.
import type { WebuiTerminalManager } from "../../terminal.js";
import {
  createTerminalOperation,
  listTerminalsOperation,
  writeTerminalOperation,
  resizeTerminalOperation,
  disposeTerminalOperation,
  watchTerminalOperation,
} from "../workspace.js";
import type {
  WebuiOperationHandler,
  WebuiOperationRegistryEntry,
  WebuiOperationValidation,
} from "../operation-contract.js";

type BodyOf<Descriptor> = Descriptor extends {
  readonly validate: (body: unknown) => WebuiOperationValidation<infer Body>;
}
  ? Body
  : never;

type DedicatedHandler<Descriptor> = WebuiOperationHandler<
  BodyOf<Descriptor>,
  unknown
>;

export function createTerminalHandlerEntries(
  terminal: WebuiTerminalManager,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const createTerminal: DedicatedHandler<typeof createTerminalOperation> = async (
    _context,
    body,
  ) => ({
    body: terminal.create(
      String((body as Record<string, unknown>).workspaceDir ?? process.cwd()),
    ),
  });
  const listTerminals: DedicatedHandler<typeof listTerminalsOperation> = async () => ({
    body: terminal.list() as readonly {
      readonly terminalId: string;
      readonly status: "running" | "exited";
      readonly output: string;
    }[],
  });
  const writeTerminal: DedicatedHandler<typeof writeTerminalOperation> = async (
    _context,
    body,
  ) => ({
    body: terminal.write(String(body.terminalId), String(body.data ?? "")),
  });
  const resizeTerminal: DedicatedHandler<typeof resizeTerminalOperation> = async (
    _context,
    body,
  ) => {
    const value = body as Record<string, unknown>;
    return {
      body: terminal.resize(
        String(value.terminalId),
        Number(value.cols),
        Number(value.rows),
      ),
    };
  };
  const disposeTerminal: DedicatedHandler<typeof disposeTerminalOperation> = async (
    _context,
    body,
  ) => ({
    body: terminal.dispose(String((body as Record<string, unknown>).terminalId)),
  });
  const watchTerminal: DedicatedHandler<typeof watchTerminalOperation> = (
    context,
    body,
  ) => ({
    stream: {
      ok: true,
      source: terminal.watch(
        String((body as Record<string, unknown>).terminalId),
        context.signal,
      ) as unknown as AsyncIterable<Record<string, unknown>>,
    },
  });

  return new Map([
    [createTerminalOperation.name, { operation: createTerminalOperation, handle: createTerminal as WebuiOperationHandler<unknown> }],
    [listTerminalsOperation.name, { operation: listTerminalsOperation, handle: listTerminals as WebuiOperationHandler<unknown> }],
    [writeTerminalOperation.name, { operation: writeTerminalOperation, handle: writeTerminal as WebuiOperationHandler<unknown> }],
    [resizeTerminalOperation.name, { operation: resizeTerminalOperation, handle: resizeTerminal as WebuiOperationHandler<unknown> }],
    [disposeTerminalOperation.name, { operation: disposeTerminalOperation, handle: disposeTerminal as WebuiOperationHandler<unknown> }],
    [watchTerminalOperation.name, { operation: watchTerminalOperation, handle: watchTerminal as WebuiOperationHandler<unknown> }],
  ]);
}
