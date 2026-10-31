// The goal coordinator.
//
// `goal` publishes the objective and the write that moves it, and it owns the
// **version fence** that keeps a late re-read from resurrecting the objective a
// newer write already replaced. The fence used to live in
// `interaction-coordinator.ts`, which had absorbed the goal duty as a third
// responsibility.
//
// What moved is the duty, not the mechanism: the counter is still injected by the
// caller (`WebuiVersionCell`, one cell per duty) because a coordinator may be
// constructed on every render and a counter living in it would reset each time
// and silently disable the guard. The interaction fence keeps its own separate
// cell, so bumping one is not observable to the other — that separation is
// asserted, not assumed, in `goal-coordinator.test.ts`.
//
// Framework-free: no React, no DOM. The policy — what a read captures, what a
// write bumps, what a late answer does — lives here; the transport call and the
// store write arrive through the port and the sink.

import type { GoalPort } from "../contracts/goal-port.js";
import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalEnabledResult,
  WebuiGoalPatchRequest,
  WebuiGoalSessionRequest,
} from "../../../../shared/contracts/goal.js";
import type { WebuiVersionCell } from "../../../application/version-cell.js";

/** The goal capability this owner drives. Absent means the operation is unwired. */
export type WebuiGoalPortSlice = Pick<
  GoalPort,
  "getGoal" | "isGoalEnabled" | "createGoal" | "patchGoal" | "clearGoal"
>;

/** The store write a goal flow drives. */
export interface WebuiGoalSink {
  /** The one goal write path; every writer goes through it. */
  readonly applyGoal: (goal: WebuiGoal | undefined) => void;
  /**
   * After a steering re-read actually lands. The re-read is eventually
   * consistent, so the caller may want to reconcile view-only state (the
   * composer's goal mode) with what the read returned; this owner does not own
   * that state and does not guess at it.
   */
  readonly afterGoalReRead: (goal: WebuiGoal | undefined) => void;
}

/** The result of a re-read. `error` is the message the caller shows in its slot. */
export type WebuiGoalOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface WebuiGoalCoordinator {
  /**
   * The goal version, bumped by every goal write. A re-read captures it before
   * asking and compares after, so a late answer cannot resurrect the goal a
   * newer write already replaced.
   */
  readonly goalVersion: () => number;
  /**
   * The one goal write path. Every writer goes through it — a direct store write
   * would let an in-flight re-read resurrect the state it was meant to replace.
   */
  readonly applyGoal: (goal: WebuiGoal | undefined) => void;
  /**
   * The steering re-read. Goal events announce that the objective moved without
   * carrying the new goal, so the banner is re-read rather than patched.
   */
  readonly refreshGoal: () => Promise<WebuiGoalOutcome>;
  /**
   * The enable probe, published as part of this business's surface. `undefined`
   * when the host does not wire it, which is what lets a caller keep its
   * "assume enabled" default instead of inventing one.
   */
  readonly isGoalEnabled?: () => Promise<WebuiGoalEnabledResult>;
  /**
   * The objective patch — this business's published write, not a capability a
   * presentation reaches for.
   *
   * It applies the returned goal on the versioned write path. That is the point
   * of publishing it: the write used to leave the store to the `thread_goal.*`
   * event, which left an in-flight re-read free to answer with the pre-patch
   * objective and overwrite it — the failure the fence exists to prevent, on the
   * one writer the fence did not cover.
   */
  readonly patchGoal?: (request: WebuiGoalPatchRequest) => Promise<WebuiGoal>;
  /** The clear, published the same way; a successful clear applies `undefined`. */
  readonly clearGoal?: (
    request: WebuiGoalSessionRequest,
  ) => Promise<{ readonly success: boolean }>;
  /**
   * The create, published so no caller needs the port. The create's own result is
   * applied by its caller (the submit flow constructs the session's goal and
   * commits it as one transition), so this one does not apply it here.
   */
  readonly createGoal?: (request: WebuiGoalCreateRequest) => Promise<WebuiGoal>;
}

export interface WebuiGoalCoordinatorOptions {
  readonly port: WebuiGoalPortSlice;
  readonly sink: WebuiGoalSink;
  readonly goalVersionRef: WebuiVersionCell;
  /** The session this owner belongs to. Absent means nothing to refresh. */
  readonly sessionId?: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWebuiGoalCoordinator({
  port,
  sink,
  goalVersionRef,
  sessionId,
}: WebuiGoalCoordinatorOptions): WebuiGoalCoordinator {
  const { getGoal, isGoalEnabled, createGoal, patchGoal, clearGoal } = port;

  const applyGoal = (goal: WebuiGoal | undefined): void => {
    goalVersionRef.current += 1;
    sink.applyGoal(goal);
  };

  return {
    ...(isGoalEnabled ? { isGoalEnabled } : {}),

    ...(patchGoal
      ? {
          patchGoal: async (request: WebuiGoalPatchRequest) => {
            const next = await patchGoal(request);
            // The versioned write path, so a re-read already in flight cannot
            // answer with the objective this patch just replaced.
            applyGoal(next);
            return next;
          },
        }
      : {}),

    ...(createGoal ? { createGoal } : {}),

    ...(clearGoal
      ? {
          clearGoal: async (request: WebuiGoalSessionRequest) => {
            const result = await clearGoal(request);
            if (result.success) applyGoal(undefined);
            return result;
          },
        }
      : {}),

    goalVersion: () => goalVersionRef.current,

    applyGoal,

    refreshGoal: async () => {
      if (!sessionId || !getGoal) return { ok: true };
      // The same monotonically increasing cell orders reads and writes. A later
      // read supersedes an earlier one even when no event or user write lands
      // between them.
      const versionAtRequest = ++goalVersionRef.current;
      try {
        const nextGoal = await getGoal({ sessionId });
        // A newer write landed while this read was in flight: its answer is
        // stale and is dropped rather than applied over the newer goal.
        if (goalVersionRef.current !== versionAtRequest) return { ok: true };
        // Query completion is a goal commit too; keep every commit on the
        // versioned entry point so the next in-flight read observes it.
        applyGoal(nextGoal);
        sink.afterGoalReRead(nextGoal);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },
  };
}
