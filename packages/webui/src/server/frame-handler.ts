// Inbound WebSocket frame handling for the loopback service: reject binary
// frames, enforce the message-size cap, parse JSON and invoke the dispatcher.
// Split from `service.ts` (plan section 7.1) with no behaviour change — the
// error codes, the messages and the dispatcher call are the ones the service
// wrote before.

import type { RawData, WebSocket } from "ws";

import {
  dispatchWebuiFrame,
  errorFrame,
  sendFrame,
} from "./operation/operation-dispatch.js";
import { WebuiErrorCode } from "../shared/envelope.js";
import type { WebuiOperationRegistryEntry } from "./operation/operations.js";

export interface WebuiFrameHandlerContext {
  readonly maxMessageBytes: number;
  readonly operations: ReadonlyMap<string, WebuiOperationRegistryEntry>;
  readonly accepting: boolean;
  /** Resolved lazily so the dispatcher sees the connection's current signal. */
  readonly signalFor: () => AbortSignal | undefined;
}

export async function handleInboundFrame(
  ws: WebSocket,
  raw: RawData,
  isBinary: boolean,
  context: WebuiFrameHandlerContext,
): Promise<void> {
  if (isBinary) {
    sendFrame(
      ws,
      errorFrame(
        "anonymous",
        WebuiErrorCode.invalidEnvelope,
        "binary frames are not accepted",
      ),
    );
    return;
  }
  const text = raw.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > context.maxMessageBytes) {
    sendFrame(
      ws,
      errorFrame(
        "anonymous",
        WebuiErrorCode.payloadTooLarge,
        "frame exceeds the message size limit",
      ),
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendFrame(
      ws,
      errorFrame(
        "anonymous",
        WebuiErrorCode.invalidEnvelope,
        "frame is not valid JSON",
      ),
    );
    return;
  }
  await dispatchWebuiFrame(
    ws,
    parsed,
    context.operations,
    context.accepting,
    context.signalFor,
  );
}
