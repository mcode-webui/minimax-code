// Dedicated handlers: the three data streams.
//
// `watchEvents`, `sendMessage` and `resumeSession` cannot be plain bindings:
// each returns a `{ stream }` envelope, and send/resume wrap the harness
// iterable through the session-stream projection. `watchEvents` is the one
// stream that opts into the acknowledgement frame (declared on its descriptor).
import type { WebuiOperationPort } from "../bind-handlers.js";
import { projectSessionStream } from "../../projections/index.js";
import { watchEventsOperation } from "../questionnaire.js";
import { sendMessageOperation, resumeSessionOperation } from "../interaction.js";
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

export function createStreamHandlerEntries(
  port: WebuiOperationPort,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const watchEvents: DedicatedHandler<typeof watchEventsOperation> = (context) => ({
    stream: { ok: true, source: port.watchEvents(context.signal) },
  });
  const sendMessage: DedicatedHandler<typeof sendMessageOperation> = async (
    context,
    body,
  ) => {
    const stream = await port.sendMessage(body, context.signal);
    return {
      stream: stream.ok
        ? { ...stream, source: projectSessionStream(stream.source) }
        : stream,
    };
  };
  const resumeSession: DedicatedHandler<typeof resumeSessionOperation> = async (
    context,
    body,
  ) => {
    const stream = await port.resumeSession(body, context.signal);
    return {
      stream: stream.ok
        ? { ...stream, source: projectSessionStream(stream.source) }
        : stream,
    };
  };
  return new Map([
    [watchEventsOperation.name, { operation: watchEventsOperation, handle: watchEvents as WebuiOperationHandler<unknown> }],
    [sendMessageOperation.name, { operation: sendMessageOperation, handle: sendMessage as WebuiOperationHandler<unknown> }],
    [resumeSessionOperation.name, { operation: resumeSessionOperation, handle: resumeSession as WebuiOperationHandler<unknown> }],
  ]);
}
