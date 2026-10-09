// Pending permissions and the questionnaire reply surface.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`. Carries
// the questionnaire agent-ownership correction: the runtime keys pending
// interactions by the agent that owns the session, so this resolves the
// authoritative agent name through `getSession` before re-asking.
import type { WebuiHarnessPort } from "../../server/port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService } from "./requirements.js";
import type { WebuiPermissionDecision } from "../../shared/contracts/interactions.js";

export function createInteractionsAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<WebuiHarnessPort, "listPendingPermissions" | "getPendingQuestionnaire" | "replyPermission" | "replyQuestionnaire" | "dismissQuestionnaire"> {
  return {
    async listPendingPermissions() {
      return requireCliService(host).listPendingPermissions();
    },

    async getPendingQuestionnaire(request) {
      const service = requireCliService(host);
      const first = await service.getPendingQuestionnaire(request);
      if (first.request || !request.sessionId) return first;
      // The runtime keys pending interactions by the agent that OWNS the
      // session, but `listSessions` / `getSessionTree` echo back the `name`
      // they were queried with rather than the session's real agent — so the
      // same session lists under both "main" and "mavis" with whichever name
      // was passed, and a client that trusts that echo asks the wrong agent's
      // queue and reads a well-formed empty response as "nothing pending".
      // That is exactly how the plan card went missing: plan mode is raised by
      // the chat agent, and this client asks under the default agent name.
      // Resolve the authoritative name through `getSession`, which does return
      // it, and ask once more. Reached only on an empty result, and a second
      // empty result is still reported as empty rather than papered over.
      const resolved = await service.getSession({ id: request.sessionId }, {});
      const agentName = resolved.session?.agentName;
      if (!agentName || agentName === request.name) return first;
      return service.getPendingQuestionnaire({
        name: agentName,
        sessionId: request.sessionId,
      });
    },

    async replyPermission(request) {
      return requireCliService(host).replyPermission({
        name: request.name,
        requestId: request.requestId,
        reply: permissionReplyValue(request.reply),
      });
    },

    async replyQuestionnaire(request) {
      return requireCliService(host).replyQuestionnaire(request);
    },

    async dismissQuestionnaire(request) {
      return requireCliService(host).dismissQuestionnaire(request);
    },
  };
}

function permissionReplyValue(reply: WebuiPermissionDecision): number {
  switch (reply) {
    case "allowOnce":
      return 0;
    case "allowAlways":
      return 1;
    case "deny":
      return 2;
  }
}
