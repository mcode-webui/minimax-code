// Dedicated handlers: slash-command execution.
//
// `runCommand` cannot be a plain binding: it does not forward one request body
// to one harness capability. It interprets a slash command (`help`, `new`,
// `compact`, `status`, `usage`, `model`) by calling several port methods and
// shaping a handled/unhandled result. The command runner keeps that logic in
// the runtime layer; this handler is its wire entry.
import type { WebuiOperationPort } from "../bind-handlers.js";
import { runCommandOperation } from "../provider.js";
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

export function createCommandHandlerEntries(
  port: WebuiOperationPort,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const runCommand: DedicatedHandler<typeof runCommandOperation> = async (
    _context,
    body,
  ) => ({ body: await port.runCommand(body) });
  return new Map([
    [
      runCommandOperation.name,
      {
        operation: runCommandOperation,
        handle: runCommand as WebuiOperationHandler<unknown>,
      },
    ],
  ]);
}
