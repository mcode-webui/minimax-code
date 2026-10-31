/**
 * Provider write-body ingress validation.
 *
 * Five malformed Provider write bodies fail at ingress. This
 * file covers all of them: `createUserModelProvider`, `updateUserModelProvider`,
 * `discoverUserModelsCandidate`, `saveUserModelProviderCandidate` and `testUserModelCandidate`. Each
 * block asserts the same two things — the frame is `invalidBody` and the runtime was never invoked —
 * and each carries a positive case, because a validator that rejected everything would otherwise
 * satisfy every negative assertion here.
 *
 * The `testUserModelCandidate` block is the one this file started as: it used to compare the old
 * record-forwarding validator with the new registry byte for byte and assert that each malformed body
 * reached the runtime anyway. That expectation no longer holds, so it is replaced in full
 * rather than kept beside the new one — keeping it would require weakening the validator back to a
 * record-forwarder.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { WebSocket } from "ws";

import { createHarnessPortFromHost } from "../../src/runtime/harness/adapter.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";
import { createOperationRegistry } from "../../src/server/index.js";
import { dispatchWebuiFrame } from "../../src/server/operation/operation-dispatch.js";
import { WebuiErrorCode, WEBUI_PROTOCOL_VERSION } from "../../src/shared/envelope.js";

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

function request(operation: string, body: unknown): unknown {
  return JSON.parse(
    JSON.stringify({
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: `${operation}-1`,
      operation,
      body,
    }),
  );
}

/**
 * A runtime target that records what reached it and answers with a marker.
 *
 * The harness method name is the operation name for every write operation here, so one argument serves
 * both the registry lookup and the recording target.
 */
function recordingTarget(method: string) {
  const calls: Array<Record<string, unknown>> = [];
  const target = async (input: Record<string, unknown>) => {
    calls.push(input);
    return { ok: true };
  };
  const runtimePort: WebuiHarnessPort = createHarnessPortFromHost({
    cliService: { [method]: target },
  } as never);
  return { calls, registry: createOperationRegistry(runtimePort) };
}

async function dispatch(
  operation: string,
  body: unknown,
  registry: ReturnType<typeof createOperationRegistry>,
): Promise<{ readonly kind?: string; readonly code?: string; readonly body?: unknown }> {
  const ws = socket();
  await dispatchWebuiFrame(
    ws as unknown as WebSocket,
    request(operation, body),
    registry,
    true,
    () => undefined,
  );
  return JSON.parse(ws.sent[0] ?? "{}") as {
    readonly kind?: string;
    readonly code?: string;
    readonly body?: unknown;
  };
}

/** The one assertion every malformed body owes: refused at ingress, and the runtime never reached. */
async function refusesAtIngress(operation: string, body: unknown): Promise<void> {
  const { calls, registry } = recordingTarget(operation);
  const frame = await dispatch(operation, body, registry);
  assert.equal(frame.kind, "error", `expected an error frame, got ${JSON.stringify(frame)}`);
  assert.equal(frame.code, WebuiErrorCode.invalidBody);
  assert.deepEqual(calls, [], "the runtime must not be invoked for a malformed body");
}

const BASE_URL = "https://example.test/v1";

describe("testUserModelCandidate refuses malformed bodies at ingress", () => {
  // The first five reached the runtime regardless, where the missing fields
  // became a TypeError inside the adapter. All of them are ingress failures now.
  const malformed: ReadonlyArray<{ readonly name: string; readonly body: unknown }> = [
    { name: "a candidate with no modelId", body: { candidate: { providerId: "p1" } } },
    { name: "a modelId with no candidate", body: { modelId: "m1" } },
    { name: "a null candidate", body: { candidate: null, modelId: "m1" } },
    { name: "a null body", body: null },
    { name: "an undefined body", body: undefined },
    {
      name: "a candidate without a base URL",
      body: { candidate: { name: "p", apiKey: "k", apiFormat: "openai" }, modelId: "m1" },
    },
    {
      name: "a candidate whose base URL is not a string",
      body: { candidate: { baseUrl: 7 }, modelId: "m1" },
    },
    {
      name: "an empty modelId",
      body: { candidate: { baseUrl: "https://example.test" }, modelId: "  " },
    },
    {
      name: "a candidate whose models entry has no id",
      body: {
        candidate: { baseUrl: "https://example.test", models: [{ displayName: "x" }] },
        modelId: "m1",
      },
    },
    {
      name: "a candidate whose header value is not a string",
      body: {
        candidate: { baseUrl: "https://example.test", headers: { "X-A": 1 } },
        modelId: "m1",
      },
    },
  ];

  for (const { name, body } of malformed) {
    it(`refuses ${name} without invoking the runtime`, () =>
      refusesAtIngress("testUserModelCandidate", body));
  }
});

describe("testUserModelCandidate forwards a valid body unchanged", () => {
  it("passes the candidate, its extensions and the model id through", async () => {
    const { calls, registry } = recordingTarget("testUserModelCandidate");
    const candidate = {
      providerId: "p1",
      expectedRevision: "rev-9",
      name: "mine",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      apiFormat: "openai",
      headers: { "X-A": "1" },
      removeHeaders: ["X-Old"],
      models: [{ modelId: "m1", enabled: true }],
      // An extension the client sends and the runtime forwards: it must survive
      // the validator rather than be dropped by a rebuilt whitelist.
      futureField: { nested: [1, 2] },
    };
    const frame = await dispatch("testUserModelCandidate", { candidate, modelId: "m1" }, registry);

    assert.equal(frame.kind, "response");
    assert.deepEqual(frame.body, { ok: true });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.candidate, candidate);
    assert.equal(calls[0]?.modelId, "m1");
  });
});

describe("createUserModelProvider refuses malformed bodies at ingress", () => {
  const malformed: ReadonlyArray<{ readonly name: string; readonly body: unknown }> = [
    { name: "a body with no base URL", body: { apiKey: "sk" } },
    { name: "a base URL that is not a string", body: { baseUrl: 7, apiKey: "sk" } },
    { name: "a body with no api key", body: { baseUrl: BASE_URL } },
    { name: "an api key that is not a string", body: { baseUrl: BASE_URL, apiKey: 7 } },
    {
      name: "a header value that is not a string",
      body: { baseUrl: BASE_URL, apiKey: "sk", headers: { "X-A": 1 } },
    },
    {
      name: "a models entry with no model id",
      body: { baseUrl: BASE_URL, apiKey: "sk", models: [{ enabled: true }] },
    },
    { name: "a null body", body: null },
  ];

  for (const { name, body } of malformed) {
    it(`refuses ${name} without invoking the runtime`, () =>
      refusesAtIngress("createUserModelProvider", body));
  }

  it("forwards a valid body unchanged", async () => {
    const { calls, registry } = recordingTarget("createUserModelProvider");
    const body = {
      providerId: "p1",
      name: "mine",
      baseUrl: BASE_URL,
      apiKey: "sk-test",
      apiFormat: "openai",
      headers: { "X-A": "1" },
      models: [{ modelId: "m1", enabled: true }],
      saveAndUse: false,
      futureField: { nested: [1, 2] },
    };
    const frame = await dispatch("createUserModelProvider", body, registry);

    assert.equal(frame.kind, "response");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], body);
  });
});

describe("updateUserModelProvider refuses malformed bodies at ingress", () => {
  const malformed: ReadonlyArray<{ readonly name: string; readonly body: unknown }> = [
    { name: "a body with no provider id", body: { name: "mine" } },
    { name: "a provider id that is not a string", body: { providerId: 7 } },
    { name: "a base URL that is not a string", body: { providerId: "p1", baseUrl: 7 } },
    {
      name: "a header value that is not a string",
      body: { providerId: "p1", headers: { "X-A": 1 } },
    },
    {
      name: "a models entry with no model id",
      body: { providerId: "p1", models: [{ enabled: false }] },
    },
    { name: "a null body", body: null },
  ];

  for (const { name, body } of malformed) {
    it(`refuses ${name} without invoking the runtime`, () =>
      refusesAtIngress("updateUserModelProvider", body));
  }

  it("forwards a valid body unchanged", async () => {
    const { calls, registry } = recordingTarget("updateUserModelProvider");
    const body = {
      providerId: "p1",
      models: [{ modelId: "model-b" }, { modelId: "model-a" }],
      removeHeaders: ["X-Old"],
      enabled: false,
      futureField: { nested: [1, 2] },
    };
    const frame = await dispatch("updateUserModelProvider", body, registry);

    assert.equal(frame.kind, "response");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], body);
  });
});

describe("discoverUserModelsCandidate refuses malformed bodies at ingress", () => {
  // Discovery is a union of two branches, and whichever branch the caller
  // started has to be complete — so each branch gets its own incomplete bodies.
  const malformed: ReadonlyArray<{ readonly name: string; readonly body: unknown }> = [
    { name: "a body with no base URL", body: { providerId: "p1", expectedRevision: "rev-1" } },
    { name: "a base URL that is not a string", body: { baseUrl: 7 } },
    { name: "an empty provider id", body: { baseUrl: BASE_URL, providerId: "  " } },
    {
      name: "a saved-provider branch with no expected revision",
      body: { baseUrl: BASE_URL, providerId: "p1" },
    },
    { name: "a new-provider branch with no name", body: { baseUrl: BASE_URL, apiKey: "sk" } },
    {
      name: "a new-provider branch with no api key",
      body: { baseUrl: BASE_URL, name: "mine", apiFormat: "openai" },
    },
    { name: "a null body", body: null },
  ];

  for (const { name, body } of malformed) {
    it(`refuses ${name} without invoking the runtime`, () =>
      refusesAtIngress("discoverUserModelsCandidate", body));
  }

  it("forwards a saved-provider branch of a valid body unchanged", async () => {
    const body = { providerId: "p1", expectedRevision: "rev-1", baseUrl: BASE_URL };
    const { calls, registry } = recordingTarget("discoverUserModelsCandidate");
    const frame = await dispatch("discoverUserModelsCandidate", body, registry);

    assert.equal(frame.kind, "response");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], body);
  });

  it("forwards a new-provider branch of a valid body unchanged", async () => {
    const body = { name: "mine", apiKey: "sk-test", apiFormat: "openai", baseUrl: BASE_URL };
    const { calls, registry } = recordingTarget("discoverUserModelsCandidate");
    const frame = await dispatch("discoverUserModelsCandidate", body, registry);

    assert.equal(frame.kind, "response");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], body);
  });
});

describe("saveUserModelProviderCandidate refuses malformed bodies at ingress", () => {
  const malformed: ReadonlyArray<{ readonly name: string; readonly body: unknown }> = [
    { name: "a body with no candidate", body: { modelId: "m1" } },
    { name: "a null candidate", body: { candidate: null, modelId: "m1" } },
    { name: "a candidate without a base URL", body: { candidate: { name: "p" } } },
    {
      name: "a candidate whose models entry has no model id",
      body: { candidate: { baseUrl: BASE_URL, models: [{ enabled: true }] } },
    },
    {
      name: "a model id that is not a string",
      body: { candidate: { baseUrl: BASE_URL }, modelId: 7 },
    },
    {
      name: "a skip-connection flag that is not a boolean",
      body: { candidate: { baseUrl: BASE_URL }, skipConnectionTest: "yes" },
    },
    { name: "a null body", body: null },
  ];

  for (const { name, body } of malformed) {
    it(`refuses ${name} without invoking the runtime`, () =>
      refusesAtIngress("saveUserModelProviderCandidate", body));
  }

  it("forwards a valid body unchanged", async () => {
    const { calls, registry } = recordingTarget("saveUserModelProviderCandidate");
    const body = {
      candidate: {
        providerId: "p1",
        expectedRevision: "rev-1",
        name: "mine",
        baseUrl: BASE_URL,
        apiKey: "sk-test",
        models: [{ modelId: "m1" }],
      },
      modelId: "m1",
      saveAndUse: false,
      skipConnectionTest: false,
      futureField: { nested: [1, 2] },
    };
    const frame = await dispatch("saveUserModelProviderCandidate", body, registry);

    assert.equal(frame.kind, "response");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], body);
  });
});
