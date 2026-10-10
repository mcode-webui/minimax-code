import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { WebSocket } from "ws";

import { createHarnessPortFromHost } from "../../src/runtime/harness/adapter.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";
import { createOperationRegistry } from "../../src/server/index.js";
import { dispatchWebuiFrame } from "../../src/server/operation/operation-dispatch.js";
import type {
  WebuiOperation,
  WebuiOperationHandler,
  WebuiOperationRegistryEntry,
} from "../../src/server/operation/operation-contract.js";
import {
  WebuiErrorCode,
  WEBUI_PROTOCOL_VERSION,
} from "../../src/shared/envelope.js";

interface Socket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly sent: string[];
  send(payload: string): void;
}

function socket(): Socket {
  const value: Socket = {
    readyState: 1,
    OPEN: 1,
    sent: [],
    send(payload) {
      value.sent.push(payload);
    },
  };
  return value;
}

function legacyRecordOnlyOperation(): WebuiOperation<
  Record<string, unknown>,
  unknown
> {
  // The old providerRecordOperation validator from 89907fb3 accepts every
  // object record unchanged; it does not require candidate or modelId.
  return {
    name: "testUserModelCandidate",
    validate(body) {
      return body !== null && typeof body === "object" && !Array.isArray(body)
        ? { ok: true, body: body as Record<string, unknown> }
        : {
            ok: false,
            code: WebuiErrorCode.invalidBody,
            message: "testUserModelCandidate body must be an object",
          };
    },
  };
}

function request(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify({
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "candidate-1",
      operation: "testUserModelCandidate",
      body,
    }),
  );
}

describe("testUserModelCandidate wire failure compatibility", () => {
  it("keeps old direct forwarding and the new runtime adapter byte-identical for missing/null fields", async () => {
    const calls: Array<{ candidate: unknown; modelId: unknown }> = [];
    const target = async (input: { candidate: unknown; modelId: unknown }) => {
      calls.push(input);
      if (input.candidate === undefined || input.candidate === null) {
        throw new TypeError(
          input.candidate === null
            ? "Cannot read properties of null (reading 'providerId')"
            : "Cannot read properties of undefined (reading 'providerId')",
        );
      }
      if (typeof input.modelId !== "string")
        throw new Error("modelId must be a string");
      return { ok: true };
    };
    const legacyPort = { testUserModelCandidate: target };
    const runtimePort: WebuiHarnessPort = createHarnessPortFromHost({
      cliService: { testUserModelCandidate: target },
    } as never);
    const oldEntry: WebuiOperationRegistryEntry = {
      operation: legacyRecordOnlyOperation(),
      handle: (async (_context, body) => ({
        body: await legacyPort.testUserModelCandidate(
          body as { candidate: unknown; modelId: unknown },
        ),
      })) as WebuiOperationHandler<unknown>,
    };
    const oldRegistry = new Map([["testUserModelCandidate", oldEntry]]);
    const currentRegistry = createOperationRegistry(runtimePort);

    for (const body of [
      { candidate: { providerId: "p1" } },
      { modelId: "m1" },
      { candidate: null, modelId: "m1" },
      null,
      undefined,
    ]) {
      const oldSocket = socket();
      const newSocket = socket();
      await dispatchWebuiFrame(
        oldSocket as unknown as WebSocket,
        request(body),
        oldRegistry,
        true,
        () => undefined,
      );
      await dispatchWebuiFrame(
        newSocket as unknown as WebSocket,
        request(body),
        currentRegistry,
        true,
        () => undefined,
      );
      assert.ok(
        Buffer.from(oldSocket.sent[0] ?? "", "utf8").equals(
          Buffer.from(newSocket.sent[0] ?? "", "utf8"),
        ),
      );
    }
    assert.deepEqual(
      calls.map(({ candidate, modelId }) => [candidate, modelId]),
      [
        [{ providerId: "p1" }, undefined],
        [{ providerId: "p1" }, undefined],
        [undefined, "m1"],
        [undefined, "m1"],
        [null, "m1"],
        [null, "m1"],
      ],
    );
  });
});
