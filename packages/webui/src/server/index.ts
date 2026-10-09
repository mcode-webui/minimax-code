// Server entry for the WebUI package. The server owns a runtime host,
// binds loopback, refuses
// foreign Host / Origin headers and missing per-start credentials, answers
// the version query, and shuts down in the order the assembly checklist
// step 13 requires. The standalone CLI build never bundles the server
// module (it is its own entry in `scripts/build-webui.mjs`).

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
export {
  WEBUI_PROTOCOL_VERSION,
  WebuiErrorCode,
  isWebuiFrame,
  type WebuiRequestFrame,
  type WebuiResponseFrame,
  type WebuiErrorFrame,
  type WebuiEventFrame,
  type WebuiServerFrame,
  type WebuiClientFrame,
  type WebuiFrame,
  type WebuiEnvelopeKind,
  type WebuiErrorCodeValue,
} from "./envelope.js";
export type { WebuiHarnessPort } from "./port.js";
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
export {
  createHarnessPortFromHost,
  type WebuiRuntimeHostHandle,
} from "./host.js";
export {
  createWebuiRuntimeHost,
  type CreateWebuiRuntimeHostOptions,
  type WebuiAssembledHost,
  type WebuiRuntimeHost,
  type WebuiRuntimeHostFactory,
  type WebuiBrowserAdapter,
  type WebuiBrowserToolExposure,
  type WebuiBrowserProvider,
} from "./assembly.js";
export {
  prepareWebuiMcodeToolsIntegration,
  createWebuiAuthLeaseSession,
  type WebuiMcodeToolsReadiness,
  type WebuiMcodeToolsIntegrationOptions,
  type WebuiMcodeToolsIntegrationDependencies,
} from "./mcode-tools.js";
