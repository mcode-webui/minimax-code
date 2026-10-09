// Dedicated handlers: account sign-out.
//
// `signOut` cannot be a plain binding: the real sign-out removes the credential
// (revoke + wipe) through `signOutAccount`, but a host assembled before
// `signOutAccount` existed only has `invalidateAuth`. A plain binding would
// fail on those hosts; this handler degrades to the historical
// invalidation-only behaviour instead.
import type { WebuiOperationPort } from "../bind-handlers.js";
import { signOutOperation } from "../provider.js";
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

export function createAccountHandlerEntries(
  port: WebuiOperationPort,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const signOut: DedicatedHandler<typeof signOutOperation> = async () => {
    // The real sign-out removes the credential (revoke + wipe). The
    // invalidation-only path remains as a fallback for hosts assembled
    // before `signOutAccount` existed; on those, sign-out degrades to the
    // historical behaviour instead of failing the operation.
    if (port.signOutAccount) await port.signOutAccount();
    else await port.invalidateAuth();
    return { body: { success: true as const } };
  };
  return new Map([
    [
      signOutOperation.name,
      {
        operation: signOutOperation,
        handle: signOut as WebuiOperationHandler<unknown>,
      },
    ],
  ]);
}
