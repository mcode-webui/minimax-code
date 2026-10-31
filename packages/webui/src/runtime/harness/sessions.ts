// Session queries, mutations, history, diff and rewind.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`; the
// bodies are unchanged, only the module boundary moved.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService, requireHostSlot } from "./requirements.js";
import {
  toWebuiSessionDiff,
  toWebuiTurnDiff,
  toWebuiRevertResult,
  toWebuiReapplyResult,
  toWebuiEditMessageResult,
  toWebuiMessagesResult,
  toWebuiRecord,
  toWebuiSessionPage,
  toWebuiSessionTreePage,
  toRuntimeAttachmentRequest,
} from "./result-conversion.js";

/**
 * What the sessions adapter needs beyond the host.
 *
 * The release hook is the edge a session's end needs, and it does not exist
 * in the runtime yet: a session is removed by deletion, by archiving, and by
 * a transfer away, and the three reach this adapter differently. The release
 * is therefore wired to the **session** rather than to one operation, so
 * whichever way a session goes away, the same nothing is left behind.
 */
export interface CreateSessionsAdapterOptions {
  /**
   * Called when a session has ended.
   *
   * The composition root hands this to the browser service, so a session that
   * ends leaves no page behind in the isolated Chromium.
   */
  readonly onSessionEnded?: (sessionId: string) => void | Promise<void>;
}

/**
 * Releases a session's resources, when the session really ended.
 *
 * An explicit `success: false` means the session is still there, and a
 * session that is still open keeps its pages — releasing them would close a
 * page out from under a session that is still running.
 */
async function releaseSessionIfItEnded(
  options: CreateSessionsAdapterOptions,
  sessionId: string,
  result: { readonly success?: boolean } | undefined,
): Promise<void> {
  if (!options.onSessionEnded) return;
  if (result?.success === false) return;
  await options.onSessionEnded(sessionId);
}

export function createSessionsAdapter(
  host: WebuiRuntimeHostHandle,
  options: CreateSessionsAdapterOptions = {},
): Pick<
  WebuiHarnessPort,
  | "listSessions"
  | "listVisibleProjects"
  | "getSessionTree"
  | "archiveSession"
  | "deleteSession"
  | "updateSession"
  | "getSessionForkOptions"
  | "forkSession"
  | "createSession"
  | "getSession"
  | "getMessages"
  | "exportSessionTransfer"
  | "importSessionTransfer"
  | "getSessionDiff"
  | "getTurnDiff"
  | "revertTurnDiff"
  | "reapplyTurnDiff"
  | "getSessionRewindPreview"
  | "rewindSession"
  | "editSessionMessage"
> {
  return {
    async listSessions(request) {
      // Converted: the runtime sends `sessionType` as a number and the wire
      // carries its name. The numbering is the runtime's business and a
      // migration can renumber it; translating here is what lets a client branch
      // on "is this a root session" without copying that numbering into a UI.
      return toWebuiSessionPage(
        await requireCliService(host).listSessions(request, {}),
      );
    },

    async listVisibleProjects(request) {
      const service = requireCliService(host);
      const listVisibleProjects = requireHostSlot(
        service.listVisibleProjects,
        "project listing",
      );
      return listVisibleProjects.call(service, request.limit ?? 100);
    },

    async getSessionTree(request) {
      return toWebuiSessionTreePage(
        await requireCliService(host).getSessionTree(request, {}),
      );
    },

    async archiveSession(request) {
      const result = await requireCliService(host).archiveSession(request, {});
      await releaseSessionIfItEnded(options, request.id, result);
      return result;
    },

    async deleteSession(request) {
      const result = await requireCliService(host).deleteSession(request, {});
      await releaseSessionIfItEnded(options, request.id, result);
      return result;
    },

    async updateSession(request) {
      return toWebuiRecord(
        await requireCliService(host).updateSession(request, {}),
      );
    },

    async getSessionForkOptions(request) {
      return requireCliService(host).getSessionForkOptions(request, {});
    },

    async forkSession(request) {
      return toWebuiRecord(
        await requireCliService(host).forkSession(request, {}),
      );
    },

    async createSession(request) {
      return toWebuiRecord(
        await requireCliService(host).createSession(request, {}),
      );
    },

    async getSession(request) {
      return requireCliService(host).getSession(request, {});
    },

    async getMessages(request) {
      // Each message is copied so the wire's `msgId` requirement is a place the
      // adapter can enforce, rather than a field a surface has to discover is
      // missing once it is already rendering the transcript.
      return toWebuiMessagesResult(
        await requireCliService(host).getMessages(request, {}),
      );
    },

    async exportSessionTransfer(request) {
      return requireCliService(host).exportSessionTransfer(request.id);
    },

    async importSessionTransfer(request) {
      return requireCliService(host).importSessionTransfer(request);
    },

    async getSessionDiff(request) {
      return toWebuiSessionDiff(
        await requireCliService(host).getSessionDiff(request, {}),
      );
    },

    async getTurnDiff(request) {
      return toWebuiTurnDiff(
        await requireCliService(host).getTurnDiff(request, {}),
      );
    },

    async revertTurnDiff(request) {
      return toWebuiRevertResult(
        await requireCliService(host).revertTurnDiff(request, {}),
      );
    },

    async reapplyTurnDiff(request) {
      return toWebuiReapplyResult(
        await requireCliService(host).reapplyTurnDiff(request, {}),
      );
    },

    async getSessionRewindPreview(request) {
      return requireCliService(host).getSessionRewindPreview(request, {});
    },

    async rewindSession(request) {
      return requireCliService(host).rewindSession(request, {});
    },

    async editSessionMessage(request) {
      return toWebuiEditMessageResult(
        await requireCliService(host).editSessionMessage(
          toRuntimeAttachmentRequest(request),
          {},
        ),
      );
    },
  };
}
