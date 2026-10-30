// Dedicated handlers: the SSH remote terminal's stream.
//
// `watchSshTerminal` cannot be a plain binding: it returns a `{ stream }` envelope, not a body.
// The other fourteen SSH operations are ordinary bindings (see `bind-handlers.ts`).
import type { WebuiOperationPort } from "../bind-handlers.js";
import { watchSshTerminalOperation } from "../ssh.js";
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

export function createSshHandlerEntries(
  port: WebuiOperationPort,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const watchSshTerminal: DedicatedHandler<typeof watchSshTerminalOperation> = async (
    _context,
    body,
  ) => ({
    // The adapter answers with the envelope itself — a source of frames, or a
    // structured refusal when this host cannot host the terminal. Passing it
    // through unchanged keeps that refusal a refusal instead of an empty stream.
    stream: await port.watchSshTerminal(body),
  });

  return new Map([
    [
      watchSshTerminalOperation.name,
      {
        operation: watchSshTerminalOperation,
        handle: watchSshTerminal as WebuiOperationHandler<unknown>,
      },
    ],
  ]);
}
