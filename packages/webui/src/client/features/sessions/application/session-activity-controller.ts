import type { WebuiActiveTurnResult } from "../../../../shared/contracts/session.js";
import type { WebuiRuntimeEvent } from "../../../../shared/contracts/stream.js";
import type { WebuiClientSession } from "../contracts/session-view.js";
import {
  applyWebuiActiveTurn,
  reduceWebuiSessionActivity,
  seedWebuiSessionActivity,
  type WebuiSessionActivityMap,
} from "../projection/session-activity.js";
import type { WebuiActiveTurnProbe } from "../../turn/contracts/active-turn-probe.js";

export interface WebuiSessionActivityStore {
  readonly getSnapshot: () => { readonly activity: WebuiSessionActivityMap };
  readonly updateActivity: (
    update: (current: WebuiSessionActivityMap) => WebuiSessionActivityMap,
  ) => void;
}

export interface WebuiSessionActivityController {
  readonly seed: (
    sessions: readonly Pick<WebuiClientSession, "sessionId" | "updatedAt">[],
  ) => void;
  readonly recordEvent: (event: WebuiRuntimeEvent) => void;
  readonly applyActiveTurn: (
    sessionId: string,
    active: WebuiActiveTurnResult,
    at: number,
  ) => void;
  readonly probeActiveTurns: (args: {
    readonly sessions: readonly { readonly sessionId: string }[];
    readonly probe: WebuiActiveTurnProbe;
    readonly now: () => number;
  }) => () => void;
}

export function createWebuiSessionActivityController(
  store: WebuiSessionActivityStore,
): WebuiSessionActivityController {
  return {
    seed: (sessions) => {
      store.updateActivity((current) => seedWebuiSessionActivity(current, sessions));
    },
    recordEvent: (event) => {
      store.updateActivity((current) => reduceWebuiSessionActivity(current, event));
    },
    applyActiveTurn: (sessionId, active, at) => {
      store.updateActivity((current) => applyWebuiActiveTurn(current, sessionId, active, at));
    },
    probeActiveTurns: (args) => {
      let cancelled = false;
      for (const session of args.sessions) {
        void args.probe
          .probe(session.sessionId)
          .then((active: WebuiActiveTurnResult) => {
            if (cancelled) return;
            store.updateActivity((current) =>
              applyWebuiActiveTurn(current, session.sessionId, active, args.now()),
            );
          })
          .catch(() => undefined);
      }
      return () => {
        cancelled = true;
      };
    },
  };
}
