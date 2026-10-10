// Session queries, mutations, history, diff and rewind.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`; the
// bodies are unchanged, only the module boundary moved.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService } from "./requirements.js";

export function createSessionsAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<WebuiHarnessPort, "listSessions" | "listVisibleProjects" | "getSessionTree" | "archiveSession" | "deleteSession" | "updateSession" | "getSessionForkOptions" | "forkSession" | "createSession" | "getSession" | "getMessages" | "exportSessionTransfer" | "importSessionTransfer" | "getSessionDiff" | "getTurnDiff" | "revertTurnDiff" | "reapplyTurnDiff" | "getSessionRewindPreview" | "rewindSession" | "editSessionMessage"> {
  return {
    async listSessions(request) {
      return requireCliService(host).listSessions(request, {});
    },

    async listVisibleProjects(request) {
      const service = requireCliService(host);
      if (!service.listVisibleProjects) throw new Error("runtime host does not expose project listing");
      return service.listVisibleProjects(request.limit ?? 100);
    },

    async getSessionTree(request) {
      return requireCliService(host).getSessionTree(request, {});
    },

    async archiveSession(request) {
      return requireCliService(host).archiveSession(request, {});
    },

    async deleteSession(request) {
      return requireCliService(host).deleteSession(request, {});
    },

    async updateSession(request) {
      return requireCliService(host).updateSession(request, {});
    },

    async getSessionForkOptions(request) {
      return requireCliService(host).getSessionForkOptions(request, {});
    },

    async forkSession(request) {
      return requireCliService(host).forkSession(request, {});
    },

    async createSession(request) {
      return requireCliService(host).createSession(request, {});
    },

    async getSession(request) {
      return requireCliService(host).getSession(request, {});
    },

    async getMessages(request) {
      return requireCliService(host).getMessages(request, {});
    },

    async exportSessionTransfer(request) {
      return requireCliService(host).exportSessionTransfer(request.id);
    },

    async importSessionTransfer(request) {
      return requireCliService(host).importSessionTransfer(request);
    },

    async getSessionDiff(request) {
      return requireCliService(host).getSessionDiff(request, {});
    },

    async getTurnDiff(request) {
      return requireCliService(host).getTurnDiff(request, {});
    },

    async revertTurnDiff(request) {
      return requireCliService(host).revertTurnDiff(request, {});
    },

    async reapplyTurnDiff(request) {
      return requireCliService(host).reapplyTurnDiff(request, {});
    },

    async getSessionRewindPreview(request) {
      return requireCliService(host).getSessionRewindPreview(request, {});
    },

    async rewindSession(request) {
      return requireCliService(host).rewindSession(request, {});
    },

    async editSessionMessage(request) {
      return requireCliService(host).editSessionMessage(request, {});
    },
  };
}
