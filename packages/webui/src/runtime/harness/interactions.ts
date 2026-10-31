// Pending permissions and the questionnaire reply surface.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`. Carries
// the questionnaire agent-ownership correction: the runtime keys pending
// interactions by the agent that owns the session, so this resolves the
// authoritative agent name through `getSession` before re-asking.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService } from "./requirements.js";
import { toWebuiPendingPermissions } from "./result-conversion.js";
import type { WebuiPermissionDecision } from "../../shared/contracts/interactions.js";
import { PermissionReply } from "@mavis/local-runtime-v2/cli-service";

export function createInteractionsAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<
  WebuiHarnessPort,
  | "listPendingPermissions"
  | "getPendingQuestionnaire"
  | "replyPermission"
  | "replyQuestionnaire"
  | "dismissQuestionnaire"
> {
  return {
    async listPendingPermissions() {
      // The runtime's result makes `requests` optional
      // (`ListPendingPermissionsResult.requests?`) and omits it when nothing is
      // pending, while the port promises an array. Normalise here rather than in
      // every reader — the client already defends with `?? []`
      // (`interaction-coordinator.ts:183`). The runtime's own input type is an
      // empty record, so the absent argument is not a dropped request field.
      // The runtime's own input type is an empty record, so the argument
      // carries nothing; it is passed because the signature requires one.
      const result = await requireCliService(host).listPendingPermissions({});
      // Converted, and the required fields are the point: `ruleContents` is what
      // the dialog shows as the thing being asked for, so an entry without it is
      // refused here rather than rendered as a permission request that grants
      // nothing and explains nothing.
      return { requests: toWebuiPendingPermissions(result.requests) };
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
      return requireCliService(host).replyQuestionnaire({
        name: request.name,
        requestId: request.requestId,
        schemaVersion: request.schemaVersion,
        // Rebuilt per answer rather than forwarded: the wire's arrays are readonly and its
        // shape is the panel's, while the runtime's own answer type is mutable and narrower.
        // Forwarding the wire object type-checks only while the two happen to overlap.
        answers: request.answers.map((answer) => ({
          stepId: answer.stepId,
          ...(answer.selectedOptionIds === undefined
            ? {}
            : { selectedOptionIds: [...answer.selectedOptionIds] }),
          ...(answer.selectedOther === undefined ? {} : { selectedOther: answer.selectedOther }),
          ...(answer.otherText === undefined ? {} : { otherText: answer.otherText }),
          ...(answer.skipped === undefined ? {} : { skipped: answer.skipped }),
        })),
      });
    },

    async dismissQuestionnaire(request) {
      return requireCliService(host).dismissQuestionnaire(request);
    },
  };
}

function permissionReplyValue(reply: WebuiPermissionDecision): PermissionReply {
  switch (reply) {
    case "allowOnce":
      return PermissionReply.AllowOnce;
    case "allowAlways":
      return PermissionReply.AllowAlways;
    case "deny":
      return PermissionReply.Deny;
  }
}
