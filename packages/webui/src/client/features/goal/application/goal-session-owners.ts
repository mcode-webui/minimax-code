// The goal owner, keyed by session.
//
// The goal duty had two problems that this module fixes together:
//
//   * its fence was one cell for the whole application, so a goal read for one
//     session could be fenced by a write to another. The fence belongs to the
//     session whose goal it orders, so it is created with that session's owner;
//   * the owner was constructed by the composer, which meant a goal event that
//     arrived with no view mounted had no owner to commit through: an empty
//     registry drops a `thread_goal.updated` for a session nobody has
//     registered.
//
// So the owner lives here, in the application, and an event route can commit
// through it whether or not anything is on screen. Owners are created on first
// touch and kept for the session's life: a re-read that is in flight must still
// find the fence it captured, which is the same reason the fence cannot live in a
// component.
//
// Framework-free: no React, no DOM. The policy stays in `goal-coordinator.ts`;
// this module owns *whose* policy it is and when it exists.

import type { WebuiGoal } from "../../../../shared/contracts/goal.js";
import type { WebuiSessionStore } from "../../../application/session-store.js";
import {
  createWebuiGoalCoordinator,
  type WebuiGoalCoordinator,
  type WebuiGoalPortSlice,
} from "./goal-coordinator.js";
import type { WebuiVersionCell } from "../../../application/version-cell.js";

export interface WebuiGoalSessionOwners {
  /**
   * The owner for one session, created on first touch. The same session always
   * gets the same owner, so its fence and its in-flight reads survive a remount.
   */
  readonly owner: (sessionId: string) => WebuiGoalCoordinator;
  /** The sessions that have an owner, in the order they were first touched. */
  readonly sessions: () => readonly string[];
  /**
   * A view reaction on the steering re-read: after a re-read lands, the listener
   * is told the goal it returned. This is the *view's* half — the composer's goal
   * mode is not this owner's state — and it is a subscription rather than a
   * replaceable effect set, so a reaction cannot displace the authoritative route.
   */
  readonly subscribe: (
    sessionId: string,
    listener: (goal: WebuiGoal | undefined) => void,
  ) => () => void;
  /** Drop one session's owner and fence (purge / session delete). */
  readonly purge: (sessionId: string) => void;
  /** Application disposal: every owner and fence goes. */
  readonly dispose: () => void;
  readonly isDisposed: () => boolean;
}

export function createWebuiGoalSessionOwners(deps: {
  readonly store: WebuiSessionStore;
  /** The goal capability. Absent on a host with nothing wired. */
  readonly port?: WebuiGoalPortSlice;
}): WebuiGoalSessionOwners {
  const owners = new Map<string, WebuiGoalCoordinator>();
  const listeners = new Map<string, Set<(goal: WebuiGoal | undefined) => void>>();
  let disposed = false;

  return {
    owner: (sessionId) => {
      const existing = owners.get(sessionId);
      if (existing) return existing;
      // The fence is this session's: `goalVersion` orders this session's reads
      // against this session's writes and nothing else.
      const goalVersionRef: WebuiVersionCell = { current: 0 };
      const owner = createWebuiGoalCoordinator({
        port: deps.port ?? {},
        sessionId,
        goalVersionRef,
        sink: {
          // The narrow writer: the goal slice of this session's record, and
          // nothing else in it.
          applyGoal: (goal) => {
            if (disposed) return;
            deps.store.updateSession(sessionId, (current) => ({ ...current, goal }));
          },
          afterGoalReRead: (goal) => {
            for (const listener of [...(listeners.get(sessionId) ?? [])]) listener(goal);
          },
        },
      });
      owners.set(sessionId, owner);
      return owner;
    },
    sessions: () => [...owners.keys()],
    subscribe: (sessionId, listener) => {
      const held = listeners.get(sessionId) ?? new Set();
      held.add(listener);
      listeners.set(sessionId, held);
      return () => held.delete(listener);
    },
    purge: (sessionId) => {
      owners.delete(sessionId);
      listeners.delete(sessionId);
    },
    dispose: () => {
      disposed = true;
      owners.clear();
      listeners.clear();
    },
    isDisposed: () => disposed,
  };
}
