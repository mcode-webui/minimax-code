// Dedicated handlers: transcript pages.
//
// `getMessages` cannot be a plain binding: it enriches the harness result with
// a context snapshot and a usage projection derived from the returned
// messages. The harness keeps returning the raw page; the shaping lives here.
import type { WebuiOperationPort } from "../bind-handlers.js";
import { projectContextSnapshot, projectUsage } from "../../projections/index.js";
import { getMessagesOperation } from "../messages.js";
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

export function createMessageHandlerEntries(
  port: WebuiOperationPort,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const getMessages: DedicatedHandler<typeof getMessagesOperation> = async (
    _context,
    body,
  ) => {
    const result = await port.getMessages(body);
    const messages = result.messages ?? [];
    const turnId =
      [...messages].reverse().find((message) => message.turnId)?.turnId ?? "";
    return {
      body: {
        ...result,
        contextSnapshot: projectContextSnapshot({
          active: false,
          messages: messages.map((message) => ({
            kind: message.kind,
            timestamp: message.timestamp,
            rawJson: JSON.stringify(message),
          })),
        }) as unknown as Record<string, unknown>,
        usage: projectUsage(messages, turnId),
      },
    };
  };
  return new Map([
    [
      getMessagesOperation.name,
      {
        operation: getMessagesOperation,
        handle: getMessages as WebuiOperationHandler<unknown>,
      },
    ],
  ]);
}
