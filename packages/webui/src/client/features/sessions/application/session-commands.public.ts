// Purpose-named domain commands for the migrated execution state, published
// as a public module.
//
// The session store owns the session record — the live stream, the `sending`
// flag, the pending permissions, the questionnaire and the goal — and every
// write to it is one of the named changes below, never a raw setter call
// from a component.
//
// Two peers reach for the command factory: the interactions business's
// session-keyed owner applies the same named commands after a questionnaire
// settles, and the global bindings (`client/bindings/use-session-state.ts`)
// wire the commands into the per-session React hook so the composer never
// holds a store writer. The execution substrate's stream-phase and
// turn-lifecycle writers live in `features/turn/application/`, and the
// component using this module submits a command instead of holding a store
// writer. The interaction owner's request is the same shape the binding
// builds, and the naming narrows authority: nothing in this surface accepts
// a raw reducer-taking writer, so a caller cannot walk around the
// generation fence the owner applies.
//
// This module is `.public` because the interactions business's session-keyed
// owner and the global React surface both build the interaction command
// view by going through the publication marker. The `.public` suffix is a
// publication marker; the command names, the targets, and the rule that
// no command accepts a raw reducer are unchanged.

import type { WebuiGoal } from "../../../../shared/contracts/goal.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
} from "../../../../shared/contracts/interactions.js";

/** The write targets the interaction commands are bound to. */
export interface WebuiInteractionCommandTargets {
  readonly setPermissions: (
    update: (
      current: readonly WebuiPendingPermission[],
    ) => readonly WebuiPendingPermission[],
  ) => void;
  readonly setQuestionnaire: (
    value:
      | WebuiQuestionnaireRequest
      | undefined
      | ((
          current: WebuiQuestionnaireRequest | undefined,
        ) => WebuiQuestionnaireRequest | undefined),
  ) => void;
  readonly setGoal: (goal: WebuiGoal | undefined) => void;
}

export interface WebuiInteractionCommands {
  /** A fresh read of the pending permissions replaces the current list. */
  readonly replacePendingPermissions: (
    permissions: readonly WebuiPendingPermission[],
  ) => void;
  /** Answering one permission drops exactly that request. */
  readonly removePendingPermission: (requestId: string) => void;
  /** Apply or clear the pending questionnaire. */
  readonly applyQuestionnaire: (
    request: WebuiQuestionnaireRequest | undefined,
  ) => void;
  /** Apply or clear the session goal. */
  readonly applyGoal: (goal: WebuiGoal | undefined) => void;
}

export function createWebuiInteractionCommands(
  targets: WebuiInteractionCommandTargets,
): WebuiInteractionCommands {
  const { setPermissions, setQuestionnaire, setGoal } = targets;
  return {
    replacePendingPermissions: (permissions) =>
      setPermissions(() => permissions),
    removePendingPermission: (requestId) =>
      setPermissions((current) =>
        current.filter((item) => item.requestId !== requestId),
      ),
    applyQuestionnaire: (request) => setQuestionnaire(request),
    applyGoal: (goal) => setGoal(goal),
  };
}
