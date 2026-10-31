// Wire envelope for the WebUI transport (ADR 0004).
//
// The harness layer carries `AsyncIterable` sources and `AbortSignal`
// contexts but no RPC envelope, no correlation, and no identity, so the
// WebUI owns its own thin protocol on top of the existing data structures.
// The fields below are the only surface the browser sees.
//
// `protocolVersion` is bumped when the envelope changes shape; the version
// query returns it so a browser can refuse to talk to a service that does
// not match.
//
// This module holds the frame shape, the protocol version and the error
// codes. The runtime validation behaviour stays in `server/envelope.ts`, so
// the shared side never imports an execution layer.

export const WEBUI_PROTOCOL_VERSION = 1 as const;

/**
 * The identity the service puts on a refusal it could not attribute to a request.
 *
 * It is a protocol fact, not an absence: a frame whose request could not be read
 * (malformed, or refused before the identity was established) is answered on the
 * socket it arrived on with this identity. A one-request socket can therefore
 * attribute such a refusal to its own pending request instead of dropping it and
 * waiting for a timeout.
 */
export const WEBUI_ANONYMOUS_REQUEST_ID = "anonymous" as const;

export type WebuiEnvelopeKind = "request" | "response" | "error" | "event";

export interface WebuiRequestFrame {
  readonly protocolVersion: typeof WEBUI_PROTOCOL_VERSION;
  readonly kind: "request";
  readonly requestId: string;
  readonly operation: string;
  readonly body: unknown;
}

export interface WebuiResponseFrame {
  readonly protocolVersion: typeof WEBUI_PROTOCOL_VERSION;
  readonly kind: "response";
  readonly requestId: string;
  readonly body: unknown;
}

export interface WebuiErrorFrame {
  readonly protocolVersion: typeof WEBUI_PROTOCOL_VERSION;
  readonly kind: "error";
  readonly requestId: string;
  readonly code: string;
  readonly message: string;
}

export interface WebuiEventFrame {
  readonly protocolVersion: typeof WEBUI_PROTOCOL_VERSION;
  readonly kind: "event";
  readonly requestId: string;
  readonly body: unknown;
}

export type WebuiServerFrame =
  WebuiResponseFrame | WebuiErrorFrame | WebuiEventFrame;
export type WebuiClientFrame = WebuiRequestFrame;
export type WebuiFrame = WebuiServerFrame | WebuiClientFrame;

/**
 * Stable error codes the service emits over the wire. Clients should
 * branch on `code`, not on `message`, because messages are diagnostic.
 */
export const WebuiErrorCode = {
  protocolMismatch: "protocol_mismatch",
  invalidEnvelope: "invalid_envelope",
  payloadTooLarge: "payload_too_large",
  unknownOperation: "unknown_operation",
  invalidBody: "invalid_body",
  runtimeRejected: "runtime_rejected",
  harnessError: "harness_error",
  shuttingDown: "shutting_down",
  /**
   * The host does not implement this capability at all.
   *
   * Distinct from `harness_error` on purpose, because the two need opposite
   * responses. A capability this host does not implement will fail the same way
   * forever, so a surface hides the control and stops asking. A harness error is
   * a supported capability that failed on this attempt, so the surface offers a
   * retry. Reporting both as one code is what made a missing feature look like a
   * broken one.
   */
  capabilityUnavailable: "capability_unavailable",
  /**
   * The host implements the capability but is not ready to answer right now —
   * still starting, or its own prerequisite is missing. Also distinct: a surface
   * that treats this as "unsupported" hides a control that will work in a moment,
   * and one that treats it as a failure reports an error for something that is
   * merely early.
   */
  capabilityNotReady: "capability_not_ready",
} as const;

export type WebuiErrorCodeValue =
  (typeof WebuiErrorCode)[keyof typeof WebuiErrorCode];

/**
 * A wire error's code, kept open.
 *
 * The named codes are what this build emits, not what a service may emit: a
 * runtime that raises a stable code of its own has said something more precise
 * than `harness_error`, and the client's correct response to that is not to
 * flatten it. The union keeps the known codes literal — so `error.code ===
 * WebuiErrorCode.shuttingDown` narrows, and a typo is a type error — while an
 * unrecognised code still arrives intact.
 */
export type WebuiWireErrorCode = WebuiErrorCodeValue | (string & {});

/**
 * Why an inbound frame could not be accepted.
 *
 * Three failures that used to share one verdict, and that a client must tell
 * apart: a socket that said something that was not JSON at all, a frame from a
 * service speaking a different version of this protocol, and a frame that claims
 * this version but is not shaped like one.
 */
export type WebuiFrameRejectionReason =
  | "invalid_json"
  | "protocol_mismatch"
  | "invalid_envelope";

/** One decoded frame, or the reason there is none. */
export type WebuiFrameDecode =
  | { readonly ok: true; readonly frame: WebuiServerFrame }
  | {
      readonly ok: false;
      readonly reason: WebuiFrameRejectionReason;
      readonly message: string;
    };

/**
 * Decodes one inbound frame from its wire text.
 *
 * This is the single place an envelope is judged, and both ends use it: the
 * server to decide what to refuse, the client to decide what it received. Before
 * this, each side re-implemented the check differently — the server reported any
 * malformed frame as a protocol mismatch, and the client did not check the
 * version or the shape at all, so a frame from a service speaking a different
 * protocol version was accepted as if it were an answer.
 *
 * The checks in order are the ones a reader can act on: parse, then version,
 * then kind, then the identity the frame claims. `kind` is checked before the
 * identity because a frame of an unknown kind has no identity to trust.
 */
export function decodeWebuiServerFrame(text: string): WebuiFrameDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "invalid_json",
      message: "frame is not valid JSON",
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      reason: "invalid_envelope",
      message: "frame is not an object",
    };
  }
  const candidate = parsed as Record<string, unknown>;
  // Absent is not the same as different. A payload with no version at all is
  // malformed — reporting it as a mismatch would tell a client its peer was built
  // incompatibly, when in fact the thing that arrived was not a frame.
  const version = candidate.protocolVersion;
  if (version === undefined || version === null) {
    return {
      ok: false,
      reason: "invalid_envelope",
      message: "frame carries no protocol version",
    };
  }
  if (version !== WEBUI_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: "protocol_mismatch",
      message: `frame speaks protocol version ${String(version)}, this client speaks ${String(WEBUI_PROTOCOL_VERSION)}`,
    };
  }
  const kind = candidate.kind;
  if (kind !== "response" && kind !== "error" && kind !== "event") {
    return {
      ok: false,
      reason: "invalid_envelope",
      message: `frame kind ${JSON.stringify(kind)} is not a server frame`,
    };
  }
  if (typeof candidate.requestId !== "string" || !candidate.requestId) {
    return {
      ok: false,
      reason: "invalid_envelope",
      message: "frame carries no request identity",
    };
  }
  // An error frame's code and message are the frame's payload; validating them
  // here means a client never has to read the raw shape to decide what happened.
  if (kind === "error") {
    if (typeof candidate.message !== "string" || typeof candidate.code !== "string") {
      return {
        ok: false,
        reason: "invalid_envelope",
        message: "error frame carries no code or message",
      };
    }
    return {
      ok: true,
      frame: {
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "error",
        requestId: candidate.requestId,
        code: candidate.code,
        message: candidate.message,
      },
    };
  }
  return {
    ok: true,
    frame: {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind,
      requestId: candidate.requestId,
      body: candidate.body,
    },
  };
}

/**
 * A refusal that arrived over the wire, carrying the service's own code.
 *
 * Before this, the client collapsed every refusal into `new Error(message)`, so
 * "the service is shutting down", "this operation is not supported by this host"
 * and "the request body was invalid" were three situations a caller could only
 * tell apart by matching on English prose that no gate protects. `code` is the
 * stable half and `message` stays diagnostic.
 */
export class WebuiWireError extends Error {
  readonly code: WebuiWireErrorCode;
  /** The request this refusal answers, or {@link WEBUI_ANONYMOUS_REQUEST_ID} for one that could not be attributed. */
  readonly requestId: string;

  constructor(
    code: WebuiWireErrorCode,
    message: string,
    requestId: string = WEBUI_ANONYMOUS_REQUEST_ID,
  ) {
    super(message);
    this.name = "WebuiWireError";
    this.code = code;
    this.requestId = requestId;
  }
}

/** True when `reason` is a refusal, so a caller can branch without knowing its class. */
export function isWebuiWireError(value: unknown): value is WebuiWireError {
  return value instanceof WebuiWireError;
}

/**
 * A capability this host does not implement.
 *
 * Lives beside the codes rather than in the runtime because both ends have to be
 * able to raise it: the runtime raises it when a host slot is absent, and the
 * operation bindings raise it when a port method is. The server may not import
 * from the runtime, so a class declared there would have been unusable here — and
 * a wire-level fact needs one home that both ends can name.
 */
export class WebuiCapabilityUnavailableError extends Error {
  readonly code = WebuiErrorCode.capabilityUnavailable;

  constructor(message: string) {
    super(message);
    this.name = "WebuiCapabilityUnavailableError";
  }
}
