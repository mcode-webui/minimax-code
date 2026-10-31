// React subscription to the account business's own owner, published as a
// public module.
//
// The account lifetime — login, status, check-in and sign-out — is
// `createWebuiAccountWorkflows`'s, created once by the composition root. This
// binding is the only React edge to it: a surface reads the snapshot and
// invokes the owner's named commands, and never receives the owner object or a
// transport method for the account operations.
//
// Three peers read through these hooks: the account business's `UserMenu` and
// `AccountLoginDialog` need the workflow handle and the live snapshot to drive
// their panels, the settings dialog mounts both the workflows and the state
// to drive its account tab and the sign-out button, and the composer's draft
// loop watches the workflows state so its banner tracks the signed-in user.
// None of those consumers own the account business, so none of them may
// re-implement the hook pair, and the React surface — Provider plus the two
// hooks — moves here to the publication marker.
//
// This module is `.public` because the settings, composer and account
// businesses all need to mount the account workflow handle on the React
// tree. The `.public` suffix is a publication marker; the context shape, the
// Provider, and the non-throwing default snapshot are unchanged, and the
// underlying workflow owner stays inside the application layer the shell
// subscribes to.
//
// The context is deliberately non-throwing: an SSR render or a unit test that
// mounts a panel without the provider reads the initial snapshot and submits
// no-ops, which is the correct behaviour with no runtime attached.

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  initialWebuiAccountWorkflowsState,
  type WebuiAccountWorkflows,
  type WebuiAccountWorkflowsState,
} from "../application/account-workflows.js";

const WebuiAccountWorkflowsContext = createContext<WebuiAccountWorkflows | undefined>(
  undefined,
);

/**
 * What a peer surface may do with the account owner.
 *
 * Reading its state and submitting its named commands, and nothing about its
 * life: `dispose` is the composition root's, because the root built the owner and
 * is the only thing that can end it. Publishing the whole owner made teardown
 * reachable from any surface that mounted the handle — legal by shape, wrong by
 * authority — and narrowing here is what corrects it without a forwarding object
 * and without changing the instance a consumer receives.
 */
export type WebuiAccountWorkflowsConsumer = Omit<WebuiAccountWorkflows, "dispose">;

export function WebuiAccountWorkflowsProvider({
  workflows,
  children,
}: {
  readonly workflows: WebuiAccountWorkflows;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <WebuiAccountWorkflowsContext.Provider value={workflows}>
      {children}
    </WebuiAccountWorkflowsContext.Provider>
  );
}

export function useWebuiAccountWorkflows(): WebuiAccountWorkflowsConsumer | undefined {
  return useContext(WebuiAccountWorkflowsContext);
}

export function useWebuiAccountWorkflowsState(): WebuiAccountWorkflowsState {
  const workflows = useContext(WebuiAccountWorkflowsContext);
  return useSyncExternalStore(
    workflows ? workflows.subscribe : noopSubscribe,
    workflows ? workflows.getSnapshot : accountInitialSnapshot,
    workflows ? workflows.getSnapshot : accountInitialSnapshot,
  );
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function accountInitialSnapshot(): WebuiAccountWorkflowsState {
  return initialWebuiAccountWorkflowsState;
}
