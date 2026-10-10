// Execution, queueing, streaming, active turn, goal and compaction.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`; the
// bodies are unchanged, only the module boundary moved.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService } from "./requirements.js";

export function createExecutionAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<WebuiHarnessPort, "getActiveTurn" | "isGoalEnabled" | "getGoal" | "createGoal" | "patchGoal" | "clearGoal" | "sendMessage" | "enqueueMessage" | "resumeSession" | "watchEvents" | "abortSession" | "listQueueMessages" | "deleteQueueItem" | "requestCompaction"> {
  return {
    async getActiveTurn(request) {
      return requireCliService(host).getActiveTurn(request.id);
    },

    async isGoalEnabled() {
      return { enabled: requireCliService(host).isGoalEnabled() };
    },

    async getGoal(request) {
      return requireCliService(host).getGoal(request.sessionId);
    },

    async createGoal(request) {
      return requireCliService(host).createGoal(request);
    },

    async patchGoal(request) {
      const { sessionId, ...patch } = request;
      return requireCliService(host).patchGoal(sessionId, patch);
    },

    async clearGoal(request) {
      return { success: await requireCliService(host).clearGoal(request.sessionId) };
    },

    async sendMessage(request, signal) {
      return requireCliService(host).sendMessage(request, signal ? { signal } : {});
    },

    async enqueueMessage(request) {
      return requireCliService(host).enqueueMessage(request, {});
    },

    async resumeSession(request, signal) {
      return requireCliService(host).resumeSession(request, signal ? { signal } : {});
    },

    watchEvents(signal) {
      return requireCliService(host).watchEvents(signal);
    },

    async abortSession(request) {
      return requireCliService(host).abortSession(request);
    },

    async listQueueMessages(request) {
      return requireCliService(host).listQueueMessages(request);
    },

    async deleteQueueItem(request) {
      return requireCliService(host).deleteQueueItem(request);
    },

    async requestCompaction(request) {
      // `cliService.requestCompaction` is optional on the harness. The
      // outer `cliService` guard stays even though the rest of the harness
      // port now goes through `requireCliService`: this is the one method
      // that the runner explicitly drives, so the failure message has to
      // be specific (the `/compact` slash command tells the user the host
      // does not support conversation compaction; folding the two errors
      // into one would only mention the CLI service).
      if (!host.cliService)
        throw new Error("runtime host does not expose the CLI service");
      if (!host.cliService.requestCompaction)
        throw new Error("runtime host does not expose requestCompaction");
      return host.cliService.requestCompaction(request);
    },
  };
}
