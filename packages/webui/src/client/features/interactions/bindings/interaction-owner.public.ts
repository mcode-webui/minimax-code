// The interaction owner for one session, read from the application.
//
// Permissions and the questionnaire are the session's, and so is the fence that
// orders their reads against their replies. The owner is the application's now,
// keyed by session, and this binding is how a surface reads the one it belongs
// to — the same arrangement as the goal owner and the version cells.
//
// The fallback exists for a composer mounted without an application (unit tests, a
// standalone surface): a per-mount registry, so the surface keeps working rather
// than silently reading through a second fence.

import { useMemo } from "react";

import type { WebuiInteractionCoordinator } from "../application/interaction-coordinator.js";
import { createWebuiInteractionSessionOwners } from "../application/interaction-session-owners.js";
import { createWebuiInteractionPhaseIntents } from "../../turn/contracts/interaction-phase-intents.js";
import { createWebuiInteractionCommands } from "../../sessions/application/session-commands.public.js";
import { WEBUI_HOME_SESSION_KEY } from "../../../application/state.js";
import { useWebuiApplicationOptional, useWebuiSessionStoreContext } from "../../../bindings/application-context.js";

/** The record key a session-less surface works under: the home slot. */
export function webuiInteractionRecordKey(sessionId: string | undefined): string {
  return sessionId ?? WEBUI_HOME_SESSION_KEY;
}

export function useWebuiInteractionOwner(
  sessionId: string | undefined,
): WebuiInteractionCoordinator {
  const application = useWebuiApplicationOptional();
  const store = useWebuiSessionStoreContext();
  const fallback = useMemo(
    () =>
      createWebuiInteractionSessionOwners({
        store,
        readPhaseIntents: (sessionId) =>
          createWebuiInteractionPhaseIntents({
            setStream: store.createSessionWriter({ kind: "session", sessionId }).setStream,
          }),
        // The fallback composes the same pair the assembly does: Sessions'
        // published commands, built for the session this owner is being made for.
        commandsFor: (sessionId) =>
          createWebuiInteractionCommands(
            store.createInteractionWriter({ kind: "session", sessionId }),
          ),
      }),
    [store],
  );
  const owners = application?.interactions ?? fallback;
  return owners.owner(webuiInteractionRecordKey(sessionId));
}
