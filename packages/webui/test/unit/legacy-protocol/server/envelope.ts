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

export const WEBUI_PROTOCOL_VERSION = 1 as const;

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
} as const;

export type WebuiErrorCodeValue =
  (typeof WebuiErrorCode)[keyof typeof WebuiErrorCode];

export function isWebuiFrame(value: unknown): value is WebuiFrame {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.protocolVersion === WEBUI_PROTOCOL_VERSION &&
    (candidate.kind === "request" ||
      candidate.kind === "response" ||
      candidate.kind === "error" ||
      candidate.kind === "event") &&
    typeof candidate.requestId === "string"
  );
}
