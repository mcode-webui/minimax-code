// Which Agent run the panel is showing.
//
// The target selection belongs to a run (ADR 0019), so a panel that does not say
// which run it is acting for would be reading — and moving — a selection that may
// belong to somebody else. The run id it needs is the active session's, which
// the session store already carries and the session family already sends in its
// operation bodies; this binding is that same route, read through the bindings
// rather than taken as a prop, so the panel follows the run instead of being
// told about it.
//
// `undefined` means no run is active — the person is looking at a browser that
// nothing is driving yet. That is the panel's own selection, not another run's,
// and it is sent as an absent `runId` rather than as an invented id.

import { useSyncExternalStore } from "react";

import { useWebuiApplicationOptional } from "../../../bindings/application-context.js";

/** A no-op subscription, for a panel mounted outside an application. */
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** Nothing is selected when there is no application to ask. */
const NO_RUN = (): string | undefined => undefined;

/**
 * The active run's id, or `undefined` when no run is active.
 *
 * Reads the application's own snapshot rather than a second source: a run is a
 * session, and the session store is what says which one the person is on.
 */
export function useWebuiBrowserRunId(): string | undefined {
  const application = useWebuiApplicationOptional();
  const subscribe = application?.subscribe ?? NO_SUBSCRIPTION;
  const read = application
    ? (): string | undefined => application.getSnapshot().selectedSessionId
    : NO_RUN;
  return useSyncExternalStore(subscribe, read, read);
}