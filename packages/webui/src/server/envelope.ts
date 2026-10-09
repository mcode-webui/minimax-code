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
