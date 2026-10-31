// Dedicated handlers: account sign-out.
//
// `signOut` cannot be a plain binding: the real sign-out removes the credential
// (revoke + wipe) through `signOutAccount`, which the port requires, so the
// handler has one path. It used to fall back to `invalidateAuth` for hosts
// assembled before `signOutAccount` existed; that fallback became unreachable
// when the method was made required, and it went with the member it read.
import type { WebuiOperationPort } from "../bind-handlers.js";
import { signOutOperation } from "../account.js";
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
    // The real sign-out removes the credential (revoke + wipe).
    await port.signOutAccount();
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
