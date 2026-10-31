// The turn-review binding: the React surface of the review owner, published
// as a public module.
//
// The owner lives on the application, so a card that mounts reads whatever the
// owner already holds for that turn — including an answer a second surface asked
// for — and its unmount does not take the answer with it.
//
// Two peers bind to this surface: the transcript's diff card subscribes to the
// per-turn diff state, and the assistant body's footer asks whether the runtime
// offers turn diffs at all. Neither consumer owns the concept of "the turn
// diff", so neither may re-derive the hook, and both read through this
// publication marker. Anything that lives only inside the review business —
// a special error read, a secret re-render guard — stays in the private
// bindings the owner wires internally; only the public hook surface leaves
// the business.
//
// This module is `.public` because the transcript business needs the turn
// diff hook (and its available query) to render the diff card and ask the
// runtime capability question. The `.public` suffix is a publication marker;
// the read-and-mutate lifecycle, the unmount-without-loss semantics, and the
// subscription to the owner's read are all unchanged.

import { useCallback, useEffect, useState } from "react";

import {
  initialWebuiDiffState,
  type WebuiDiffState,
} from "../contracts/review-view.js";
import type { WebuiTurnReviewKey } from "../contracts/turn-review.js";
import { useWebuiApplicationOptional } from "../../../bindings/application-context.js";

export function useWebuiTurnReview(key: WebuiTurnReviewKey | undefined): {
  readonly state: WebuiDiffState;
  readonly mutate: (action: "revert" | "reapply") => void;
  readonly dismissError: () => void;
} {
  const owner = useWebuiApplicationOptional()?.turnReview;
  const sessionId = key?.sessionId;
  const turnId = key?.turnId;
  const assistantMessageId = key?.assistantMessageId;
  const changeSetId = key?.changeSetId;
  const [state, setState] = useState<WebuiDiffState>(initialWebuiDiffState);
  const keyOf = useCallback(
    (): WebuiTurnReviewKey | undefined =>
      sessionId
        ? {
            sessionId,
            ...(turnId ? { turnId } : {}),
            ...(assistantMessageId ? { assistantMessageId } : {}),
            ...(changeSetId ? { changeSetId } : {}),
          }
        : undefined,
    [assistantMessageId, changeSetId, sessionId, turnId],
  );
  useEffect(() => {
    const current = keyOf();
    if (!owner || !current) {
      setState(initialWebuiDiffState);
      return undefined;
    }
    setState(owner.read(current));
    const unsubscribe = owner.subscribe(() => setState(owner.read(current)));
    // Opening the card is the read: the owner joins it with any read already in
    // flight for the same turn.
    void owner.load(current);
    return unsubscribe;
  }, [keyOf, owner]);
  const mutate = useCallback(
    (action: "revert" | "reapply") => {
      const current = keyOf();
      if (!owner || !current) return;
      void owner.mutate(current, action);
    },
    [keyOf, owner],
  );
  const dismissError = useCallback(() => {
    const current = keyOf();
    if (!owner || !current) return;
    owner.dismissError(current);
  }, [keyOf, owner]);
  return { state, mutate, dismissError };
}

/** Whether the runtime offers turn diffs at all (see the owner's
 *  `supportsQueries`). Read from the owner so no surface keeps its own copy of
 *  the capability. */
export function useWebuiTurnReviewAvailable(): boolean {
  const owner = useWebuiApplicationOptional()?.turnReview;
  return owner?.supportsQueries() ?? false;
}
