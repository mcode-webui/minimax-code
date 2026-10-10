// Server entry for the WebUI package. Exports the loopback network entry only:
// the service, the operation registry, credentials, the envelope and the wire
// DTOs. It holds no runtime implementation — the runtime factory and the
// harness adapter are exported from `../runtime/index.ts`, which the Node
// startup file imports separately (plan section 7.5). The standalone CLI build
// never bundles the server module (it is its own entry in
// `scripts/build-webui.mjs`).

export {
  WebuiService,
  WEBUI_MAX_MESSAGE_BYTES,
  type WebuiServiceInfo,
  type WebuiServiceOptions,
} from "./service.js";
export {
  createOperationRegistry,
  registerOperation,
  versionOperation,
  listSessionsOperation,
  getSessionTreeOperation,
  createSessionOperation,
  getSessionOperation,
  getMessagesOperation,
  sendMessageOperation,
  enqueueMessageOperation,
  resumeSessionOperation,
  type WebuiOperation,
  type WebuiOperationHandler,
  type WebuiOperationRegistryEntry,
  type WebuiOperationRegistration,
  type WebuiOperationResult,
} from "./operation/operations.js";
export {
  createWebuiCredential,
  credentialMatches,
  type WebuiCredential,
} from "./credentials.js";
export { isWebuiFrame } from "./envelope.js";
export {
  WEBUI_PROTOCOL_VERSION,
  WebuiErrorCode,
  type WebuiRequestFrame,
  type WebuiResponseFrame,
  type WebuiErrorFrame,
  type WebuiEventFrame,
  type WebuiServerFrame,
  type WebuiClientFrame,
  type WebuiFrame,
  type WebuiEnvelopeKind,
  type WebuiErrorCodeValue,
} from "../shared/envelope.js";
export type { WebuiHarnessPort } from "../runtime/port.js";
export type { WebuiVersionInfo } from "../shared/contracts/version.js";
export type {
  WebuiSessionListRequest,
  WebuiSessionListItem,
  WebuiSessionPage,
  WebuiSessionTreeRequest,
  WebuiSessionTreeNode,
  WebuiSessionTreePage,
  WebuiCreateSessionRequest,
  WebuiCreateSessionResult,
  WebuiSessionLookupRequest,
  WebuiSessionInfo,
  WebuiActiveTurnResult,
  WebuiSessionLookupResult,
  WebuiUpdateSessionRequest,
  WebuiUpdateSessionResult,
  WebuiGetSessionForkOptionsRequest,
  WebuiGetSessionForkOptionsResult,
  WebuiForkSessionRequest,
  WebuiForkSessionResult,
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult,
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
} from "../shared/contracts/session.js";
export type {
  WebuiMessage,
  WebuiMessagesRequest,
  WebuiMessagesResult,
} from "../shared/contracts/messages.js";
export type {
  WebuiSendMessageRequest,
  WebuiSendMessageResult,
  WebuiResumeSessionRequest,
  WebuiStreamResult,
  WebuiStreamFrame,
  WebuiRuntimeEvent,
} from "../shared/contracts/stream.js";
export type {
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
  WebuiQueueItem,
} from "../shared/contracts/queue.js";
export type {
  WebuiPendingPermission,
  WebuiQuestionnaireRequest,
  WebuiQuestionnaireAnswer,
  WebuiInteractionReplyResult,
  WebuiPermissionDecision,
} from "../shared/contracts/interactions.js";
export type { WebuiModelEntry } from "../shared/contracts/models.js";
