// The Mini App catalogue, published for the surfaces that host the apps area.
//
// The plugin catalogue's apps area is the Mini App business's page, and the
// catalogue mounts it — but two facts about that page are the Mini App
// business's and not the catalogue's: how many rows the listing holds, and the
// ask to read it again. The catalogue shows the count in its own header and
// owns its own refresh button, so it needs both. Reaching into the Mini App
// business's private binding for them would make the catalogue a second holder
// of that business's state, which is what the publication marker exists to
// prevent: the owner publishes the surface, and a peer consumes it.
//
// Narrow on purpose. The catalogue gets a count and a refresh, not the owner.
// The owner also opens, stops, uninstalls and presents Mini Apps, and none of
// that is the catalogue's to drive; publishing the whole handle would make
// every one of those reachable from a peer surface — legal by shape, wrong by
// authority.

import { useCallback } from "react";

import {
  useWebuiMiniAppWorkflows,
  useWebuiMiniAppWorkflowsState,
} from "./use-miniapp-workflows.js";

/** What a peer surface may know about the Mini App catalogue. */
export interface WebuiMiniAppCatalogueSummary {
  /** How many Mini Apps the listing currently holds. */
  readonly rowCount: number;
  /** Ask the Mini App business to read the catalogue again. */
  readonly refresh: () => Promise<void>;
}

/**
 * The catalogue's count and refresh, for a surface that hosts the apps area.
 *
 * The count is read from the owner's own snapshot, so it is the same number the
 * list renders: a surface cannot show a count its rows disagree with.
 */
export function useWebuiMiniAppCatalogueSummary(): WebuiMiniAppCatalogueSummary {
  const workflows = useWebuiMiniAppWorkflows();
  const state = useWebuiMiniAppWorkflowsState();
  const refresh = useCallback(async (): Promise<void> => {
    await workflows?.loadListing();
  }, [workflows]);
  return { rowCount: state.listing.rows.length, refresh };
}