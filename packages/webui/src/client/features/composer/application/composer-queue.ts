import type { WebuiComposerStore } from "./composer-store.js";
import type { WebuiCommandWorkflows } from "./command-workflows.js";
import { formatWebuiError } from "../../../contracts/value-readers.js";

/** Queue-mirror commands for one composer application owner. */
export function createWebuiComposerQueueCommands(deps: {
  readonly store: WebuiComposerStore;
  readonly workflows: WebuiCommandWorkflows;
  readonly onError: (message: string) => void;
}) {
  const refresh = (sessionId: string, acceptedGeneration?: number): void => {
    const generation = acceptedGeneration ?? deps.store.claimQueueDestination(sessionId);
    void deps.workflows.refreshQueue(sessionId).then((queue) => {
      if (!queue) return;
      deps.store.applyQueueRead(sessionId, generation, {
        items: queue.items ?? [],
        paused: queue.paused === true,
      });
    }).catch((error: unknown) => deps.onError(formatWebuiError(error)));
  };

  return {
    captureDestination: (sessionId: string): number => deps.store.claimQueueDestination(sessionId),
    refresh,
    remove: async (input: { readonly sessionId: string; readonly itemId: string; readonly selectedSessionId?: string }): Promise<void> => {
      if (!deps.workflows.canRemoveQueued || input.selectedSessionId !== input.sessionId) return;
      const generation = deps.store.claimQueueDestination(input.sessionId);
      try {
        await deps.workflows.removeQueued({ sessionId: input.sessionId, itemId: input.itemId });
        const queue = await deps.workflows.refreshQueue(input.sessionId);
        if (!deps.store.queueClaimIsCurrent(input.sessionId, generation)) return;
        if (queue) {
          deps.store.applyQueueRead(input.sessionId, generation, { items: queue.items ?? [], paused: queue.paused === true });
        } else {
          deps.store.setQueue((current) => ({ items: current.items.filter((item) => item.itemId !== input.itemId) }));
        }
      } catch (error) {
        deps.onError(formatWebuiError(error));
      }
    },
  };
}
