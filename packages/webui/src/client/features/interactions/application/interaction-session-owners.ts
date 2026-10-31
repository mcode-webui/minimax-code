// The interaction owner, keyed by session: goal and interaction owners retain
// independent policies and fences.
//
// Permissions and the questionnaire are the session's, and so is the fence that
// orders their reads against their replies. The owner used to be constructed by
// the composer, which meant:
//
//   * one fence for the whole application, so a reply for one session could
//     fence a pending read for another;
//   * an event that arrived with no view mounted had no owner to re-read through,
//     and a transcript's "approve" went through a registry lookup that only
//     worked while the composer was mounted on that session.
//
// So the owner lives here, in the application, one per session, created on first
// touch and kept for the session's life — a pending read in flight must still
// find the fence it captured.
//
// Framework-free: no React, no DOM. The policy stays in
// `interaction-coordinator.ts`; this module owns *whose* policy it is and when it
// exists.

import type { WebuiSessionStore } from "../../../application/session-store.js";
import type { WebuiInteractionCommands } from "../../sessions/application/session-commands.public.js";
import type { WebuiInteractionPhaseIntents } from "../../turn/contracts/interaction-phase-intents.js";
import {
  createWebuiInteractionCoordinator,
  type WebuiInteractionCoordinator,
  type WebuiInteractionPortSlice,
} from "./interaction-coordinator.js";
import type { WebuiVersionCell } from "../../../application/version-cell.js";

export interface WebuiInteractionSessionOwners {
  /** The owner for one session, created on first touch and then stable. */
  readonly owner: (sessionId: string) => WebuiInteractionCoordinator;
  readonly sessions: () => readonly string[];
  /** Drop one session's owner and fence (purge / session delete). */
  readonly purge: (sessionId: string) => void;
  readonly dispose: () => void;
  readonly isDisposed: () => boolean;
}

export function createWebuiInteractionSessionOwners(deps: {
  readonly store: WebuiSessionStore;
  /**
   * This session's interaction writers, composed by the assembly.
   *
   * Injected for the same reason the phase intents are: the commands are Sessions'
   * published contract, and the composition that knows the store is what builds
   * them for the session it is creating an owner for. Building them here meant an
   * owner registry reaching into a peer business's factory and supplying its own
   * writer — the caller-pair this seam exists to remove.
   */
  readonly commandsFor: (sessionId: string) => WebuiInteractionCommands;
  /**
   * The phase intents this owner drives, per session. Injected rather than built
   * here: the intents are turn's published contract, and
   * the composition that knows the store builds them for the session it is
   * creating the owner for. Required, so no caller silently loses the phase writes
   * a pending interaction implies.
   */
  readonly readPhaseIntents: (sessionId: string) => WebuiInteractionPhaseIntents;
  /** The interaction capability. Absent on a host with nothing wired. */
  readonly port?: WebuiInteractionPortSlice;
  /**
   * The fallback requester name for a session whose requests carry none. It is a
   * wire input (the questionnaire read names the agent), so it is read per
   * session rather than fixed at construction.
   */
  readonly readAgentName?: (sessionId: string) => string;
}): WebuiInteractionSessionOwners {
  const owners = new Map<string, WebuiInteractionCoordinator>();
  const readAgentName = deps.readAgentName;
  let disposed = false;

  return {
    owner: (sessionId) => {
      const existing = owners.get(sessionId);
      if (existing) return existing;
      // The narrow writers: this session's interaction slice and its stream
      // phase, and nothing else in the record. Both come from the assembly, which
      // is what holds the store these slices live in.
      const commands = deps.commandsFor(sessionId);
      const streams = deps.readPhaseIntents(sessionId);
      // The fence is this session's: a reply for this session cannot fence
      // another session's pending read, and the converse holds too.
      const pendingVersionRef: WebuiVersionCell = { current: 0 };
      const owner = createWebuiInteractionCoordinator({
        port: deps.port ?? {},
        sink: {
          replacePendingPermissions: commands.replacePendingPermissions,
          removePendingPermission: commands.removePendingPermission,
          applyQuestionnaire: commands.applyQuestionnaire,
        },
        streams,
        pendingVersionRef,
        sessionId,
        agentName: () => readAgentName?.(sessionId) ?? "main",
      });
      owners.set(sessionId, owner);
      return owner;
    },
    sessions: () => [...owners.keys()],
    purge: (sessionId) => {
      owners.delete(sessionId);
    },
    dispose: () => {
      disposed = true;
      owners.clear();
    },
    isDisposed: () => disposed,
  };
}
