// The goal owner for one session, read from the application.
//
// The owner used to be constructed by the composer on every render, which is why
// a goal event that arrived with nothing mounted had no owner to commit through,
// and why the fence was one cell for every session. It is the application's now,
// keyed by session, and these bindings are how a surface reads the one it belongs
// to and subscribes to its re-reads — the same arrangement as the version cells
// and the session store.
//
// The fallback exists for a composer mounted without an application (unit tests, a
// standalone surface): a per-mount owner registry, so the surface keeps working
// rather than silently writing goals through a second path.

import { useEffect, useMemo, useRef } from "react";

import type { WebuiGoal } from "../../../../shared/contracts/goal.js";
import type { WebuiGoalCoordinator } from "../application/goal-coordinator.js";
import {
  createWebuiGoalSessionOwners,
  type WebuiGoalSessionOwners,
} from "../application/goal-session-owners.js";
import { WEBUI_HOME_SESSION_KEY } from "../../../application/state.js";
import { useWebuiApplicationOptional, useWebuiSessionStoreContext } from "../../../bindings/application-context.js";

/** The record key a session-less surface works under: the home slot. */
export function webuiGoalRecordKey(sessionId: string | undefined): string {
  return sessionId ?? WEBUI_HOME_SESSION_KEY;
}

function useWebuiGoalOwners(): WebuiGoalSessionOwners {
  const application = useWebuiApplicationOptional();
  const store = useWebuiSessionStoreContext();
  const fallback = useMemo(() => createWebuiGoalSessionOwners({ store }), [store]);
  return application?.goals ?? fallback;
}

export function useWebuiGoalOwner(
  sessionId: string | undefined,
): WebuiGoalCoordinator {
  const owners = useWebuiGoalOwners();
  return owners.owner(webuiGoalRecordKey(sessionId));
}

/**
 * The view's half of a steering re-read: after one lands, the listener is told
 * the goal it returned. A subscription rather than a replaceable effect, so a
 * reaction cannot displace the authoritative route.
 */
export function useWebuiGoalReaction(
  sessionId: string | undefined,
  listener: (goal: WebuiGoal | undefined) => void,
): void {
  const owners = useWebuiGoalOwners();
  const key = webuiGoalRecordKey(sessionId);
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => owners.subscribe(key, (goal) => latest.current(goal)), [owners, key]);
}
