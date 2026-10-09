// Browser-local review view types.
//
// The diff-state machine the review UI consumes. Split from the former
// `client/contracts.ts`.

import type { WebuiTurnDiffView } from "../../shared/contracts/session.js";

export interface WebuiDiffState {
  readonly view?: WebuiTurnDiffView;
  readonly unsupported: boolean;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly reviewing: boolean;
  /** Why the last revert/reapply did not apply, when it did not apply.
   *
   * Deliberately NOT the same thing as `unsupported`: that flag means the
   * runtime never offered the capability, this one means the runtime answered
   * and the operation did not take effect. Collapsing the two made every
   * failure read as "当前运行时未提供 session diff 能力", which is both
   * untrue and, because `buildWebuiDiffMutationRequest` refuses every request
   * once `unsupported` is set and nothing ever resets it, permanently
   * unrecoverable. */
  readonly mutationError?: string;
}

export type WebuiDiffStateAction =
  | { readonly type: "loaded"; readonly view: WebuiTurnDiffView }
  | { readonly type: "unsupported" }
  | { readonly type: "begin-mutation" }
  | { readonly type: "mutation-succeeded"; readonly view: WebuiTurnDiffView }
  | { readonly type: "mutation-failed"; readonly error?: string }
  | { readonly type: "dismiss-mutation-error" }
  | { readonly type: "toggle-expanded" }
  | { readonly type: "toggle-review" };
