// The Mini App page bridge's two operations.
//
// The page's nine methods become two operations rather than nine because the
// split that matters is not the method name but how the call settles:
//
//   * `watchMiniAppAgentTurn` follows a turn. Its progress events and its
//     settlement arrive on one socket, so it is a stream, and a page's
//     cancellation is a separate call naming the request rather than that socket
//     being dropped — an `AbortSignal` does not cross `postMessage`, and a socket
//     that closes tells the service nothing about whether the turn is still
//     running.
//   * `miniAppAgentCall` is everything that is one round trip, refusals included.
//
// Neither operation answers a runtime refusal as a wire error. "The runtime said
// no" is a contract-shaped body or frame the page can branch on; "this body is
// malformed" is the wire's `invalid_body`. Folding the first into the second
// would tell a page its request was wrong when the plugin simply has no Agent
// access.
//
// Validators are the shared contract's readers, not a second copy of them:
// `@mavis/shared/miniapp-surface` is what the desktop preload and its Main process
// already validate against, so a page that validates there validates here.
import type {
  WebuiMiniAppAgentCallRequest,
  WebuiMiniAppAgentCallResponse,
  WebuiMiniAppAgentTurnRequest,
} from "../../shared/contracts/miniapp-agent.js";
import { readWebuiMiniAppAgentCallRequest, readWebuiMiniAppAgentTurnRequest } from "../../shared/contracts/miniapp-agent.js";
import { WebuiErrorCode } from "../../shared/envelope.js";
import {
  MINI_APP_AGENT_CALL_OPERATION_NAME,
  WATCH_MINI_APP_AGENT_TURN_OPERATION_NAME,
} from "../../shared/operation-names.js";
import type { WebuiOperation } from "./operation-contract.js";

/**
 * One followed turn.
 *
 * The body is validated in full here — including the identity fields the client
 * added — so the handler receives a value no page content can widen. What the
 * validator cannot check is whether that identity is the frame's own; that is the
 * service's record of which presentation it issued, and the handler is where it is
 * compared.
 */
export const watchMiniAppAgentTurnOperation: WebuiOperation<WebuiMiniAppAgentTurnRequest> = {
  name: WATCH_MINI_APP_AGENT_TURN_OPERATION_NAME,
  validate: (body) => {
    const read = readWebuiMiniAppAgentTurnRequest(body);
    if (read.ok) return { ok: true, body: read.request };
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: `${WATCH_MINI_APP_AGENT_TURN_OPERATION_NAME} body is not a Mini App agent turn request`,
    };
  },
  // A page sees the runtime's refusal as the stream's settlement, so nothing here
  // gains from an acknowledgement frame: the first frame a caller can act on is
  // the first event or the settlement.
  acknowledgesStream: false,
};

/** One short call. Its refusal is the body's `ok: false`, not a wire error. */
export const miniAppAgentCallOperation: WebuiOperation<
  WebuiMiniAppAgentCallRequest,
  WebuiMiniAppAgentCallResponse
> = {
  name: MINI_APP_AGENT_CALL_OPERATION_NAME,
  validate: (body) => {
    const request = readWebuiMiniAppAgentCallRequest(body);
    if (request) return { ok: true, body: request };
    return {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: `${MINI_APP_AGENT_CALL_OPERATION_NAME} body is not a Mini App agent call request`,
    };
  },
};
