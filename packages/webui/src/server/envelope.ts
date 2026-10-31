// Runtime envelope validation for the WebUI transport (ADR 0004).
//
// The frame shape, protocol version and error codes are declarations and
// live in `shared/envelope.ts`; only the validation behaviour stays here so
// runtime code keeps depending on shared contracts, not on server code.

import { WEBUI_PROTOCOL_VERSION, type WebuiFrame } from "../shared/envelope.js";

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

/**
 * What an inbound frame is, or the stable refusal it earns.
 *
 * A frame that cannot be understood has two genuinely different causes, and this
 * judgement used to report both as a protocol mismatch. They are not the same
 * message to send: a version mismatch means this client and this service were
 * not built to talk to each other, while a malformed frame from the right
 * version means the *frame* is wrong. Collapsing them told a client to reload
 * when the request it sent was the problem.
 */
export type WebuiFrameJudgement =
  | { readonly ok: true; readonly frame: WebuiFrame }
  | {
      readonly ok: false;
      readonly code: "protocol_mismatch" | "invalid_envelope";
      readonly message: string;
    };

export function judgeWebuiFrame(value: unknown): WebuiFrameJudgement {
  if (isWebuiFrame(value)) return { ok: true, frame: value };
  if (!value || typeof value !== "object") {
    return { ok: false, code: "invalid_envelope", message: "frame is not an object" };
  }
  const candidate = value as Record<string, unknown>;
  // Version first: a frame from another protocol version cannot be judged
  // against this one's shape, because its shape may legitimately differ.
  if (candidate.protocolVersion !== WEBUI_PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "protocol_mismatch",
      message: `frame speaks protocol version ${String(candidate.protocolVersion)}, this service speaks ${String(WEBUI_PROTOCOL_VERSION)}`,
    };
  }
  if (typeof candidate.requestId !== "string" || !candidate.requestId) {
    return {
      ok: false,
      code: "invalid_envelope",
      message: "frame carries no request identity",
    };
  }
  return {
    ok: false,
    code: "invalid_envelope",
    message: `frame kind ${JSON.stringify(candidate.kind)} is not a WebUI frame`,
  };
}
