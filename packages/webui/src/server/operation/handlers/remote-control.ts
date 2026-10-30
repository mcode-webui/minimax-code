// Dedicated handlers: the remote-control status stream.
//
// `watchRemoteControlStatus` cannot be a plain binding: it returns a `{ stream }` envelope, not a
// body. The other eight remote-control operations are ordinary bindings (see `bind-handlers.ts`).
import type { WebuiOperationPort } from "../bind-handlers.js";
import { watchRemoteControlStatusOperation } from "../remote-control.js";
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

export function createRemoteControlHandlerEntries(
  port: WebuiOperationPort,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const watchRemoteControlStatus: DedicatedHandler<
    typeof watchRemoteControlStatusOperation
  > = async (_context, _body) => ({
    // The adapter answers with the envelope itself — a source of frames, or a structured refusal
    // when this host cannot hold the phone link. Passing it through unchanged keeps that refusal a
    // refusal instead of an empty stream.
    stream: await port.watchRemoteControlStatus(),
  });

  return new Map([
    [
      watchRemoteControlStatusOperation.name,
      {
        operation: watchRemoteControlStatusOperation,
        handle: watchRemoteControlStatus as WebuiOperationHandler<unknown>,
      },
    ],
  ]);
}
