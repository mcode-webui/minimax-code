// The wire's two ends: what a frame is judged as, and what a refusal carries.
//
// Both checks used to be re-implemented per side and per file. The server called
// anything it could not parse a protocol mismatch, and the client checked nothing
// at all — so the two disagreed about what a given frame was. These cases pin the
// one shared judgement both ends now use.

import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { isWebuiFrame, judgeWebuiFrame } from "../../src/server/envelope.js";
import { dispatchWebuiFrame } from "../../src/server/operation/operation-dispatch.js";
import type { WebuiOperationRegistryEntry } from "../../src/server/operation/operations.js";
import {
  decodeWebuiServerFrame,
  WebuiErrorCode,
  WebuiWireError,
} from "../../src/shared/envelope.js";

const encode = (value: unknown): string => JSON.stringify(value);

/** A socket that records what the dispatcher wrote to it. */
function socket(): { readyState: number; OPEN: number; sent: string[]; send(payload: string): void } {
  const value = {
    readyState: 1,
    OPEN: 1,
    sent: [] as string[],
    send(payload: string) {
      value.sent.push(payload);
    },
  };
  return value;
}

describe("the service judges an inbound frame", () => {
  it("preserves the reason of a Mini App publication refusal", async () => {
    const ws = socket();
    const entry = {
      operation: { validate: () => ({ ok: true, body: {} }) },
      handle: async () => {
        throw Object.assign(new Error("Mini App publication preparation failed"), {
          code: "MINIAPP_PREPARATION_FAILED",
          reasonCode: "OWNED_ELSEWHERE",
        });
      },
    } as unknown as WebuiOperationRegistryEntry;
    await dispatchWebuiFrame(ws as unknown as WebSocket,
      { protocolVersion: 1, kind: "request", requestId: "open", operation: "openMiniApp", body: {} },
      new Map([["openMiniApp", entry]]), true, () => undefined);
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({
      code: "MINIAPP_PREPARATION_FAILED",
      reasonCode: "OWNED_ELSEWHERE",
    });
  });

  it("observes a rejecting finalizer once when abort interrupts a parked pull", async () => {
    const ws = socket();
    const controller = new AbortController();
    let pulled!: () => void;
    const pulling = new Promise<void>((resolve) => { pulled = resolve; });
    let returns = 0;
    const source = {
      [Symbol.asyncIterator]() { return this; },
      next: () => { pulled(); return new Promise<IteratorResult<unknown>>(() => {}); },
      return: async () => { returns += 1; throw new Error("subscription cleanup failed"); },
    };
    const entry = {
      operation: { validate: () => ({ ok: true, body: {} }) },
      handle: async () => ({ stream: { ok: true, source } }),
    } as unknown as WebuiOperationRegistryEntry;
    const dispatch = dispatchWebuiFrame(ws as unknown as WebSocket,
      { protocolVersion: 1, kind: "request", requestId: "cleanup", operation: "watch", body: {} },
      new Map([["watch", entry]]), true, () => controller.signal);
    await pulling;
    controller.abort();
    await dispatch;
    expect(returns).toBe(1);
    expect(ws.sent.map((frame) => JSON.parse(frame))).toEqual([
      { protocolVersion: 1, kind: "error", requestId: "cleanup", code: "harness_error", message: "subscription cleanup failed" },
    ]);
  });
  it("accepts a well-formed frame and narrows it", () => {
    const judged = judgeWebuiFrame({
      protocolVersion: 1,
      kind: "request",
      requestId: "r1",
      operation: "listSessions",
      body: {},
    });
    expect(judged.ok).toBe(true);
    // Narrowed: the caller reads `operation` without re-checking the shape.
    if (judged.ok) expect(judged.frame.kind === "request" && judged.frame.operation).toBe("listSessions");
  });

  it("tells a version mismatch from a malformed frame of the right version", () => {
    // These are different situations and needed different answers. Reporting both
    // as a protocol mismatch told a client to reload when the request it sent was
    // the problem.
    const wrongVersion = judgeWebuiFrame({
      protocolVersion: 99,
      kind: "request",
      requestId: "r1",
    });
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.code).toBe(WebuiErrorCode.protocolMismatch);

    const wrongShape = judgeWebuiFrame({ protocolVersion: 1, kind: "gossip", requestId: "r1" });
    expect(wrongShape.ok).toBe(false);
    if (!wrongShape.ok) expect(wrongShape.code).toBe(WebuiErrorCode.invalidEnvelope);
  });

  it("names a frame with no identity as an envelope failure", () => {
    const judged = judgeWebuiFrame({ protocolVersion: 1, kind: "request" });
    expect(judged.ok).toBe(false);
    if (!judged.ok) expect(judged.code).toBe(WebuiErrorCode.invalidEnvelope);
  });
});

describe("one identity rule decides every frame", () => {
  /**
   * The frame's identity is decided once.
   *
   * The fast acceptance took any string and the judgement refused the empty
   * one, so a request with `requestId: ""` was accepted by the first and never
   * reached the second. Both now read the same rule, and the dispatch case
   * below proves the consequence: the operation is not run.
   */
  it("refuses the empty request identity on every legal frame kind", () => {
    for (const kind of ["request", "response", "error", "event"] as const) {
      const candidate = { protocolVersion: 1, kind, requestId: "" };
      expect(isWebuiFrame(candidate), `${kind} accepted an empty identity`).toBe(false);
      const judged = judgeWebuiFrame(candidate);
      expect(judged.ok, `${kind} judged an empty identity as a frame`).toBe(false);
      if (!judged.ok) {
        expect(judged.code).toBe(WebuiErrorCode.invalidEnvelope);
        expect(judged.message).toBe("frame carries no request identity");
      }
    }
  });

  it("accepts a whitespace identity, which is a token rather than no token", () => {
    // The rule is "an identity is present", not "an identity looks tidy": the
    // service never interprets a request id, and a client that chose " " is
    // correlatable. Pinned so a later tightening is a deliberate decision.
    const candidate = {
      protocolVersion: 1,
      kind: "request",
      requestId: " ",
      operation: "listSessions",
      body: {},
    };
    expect(isWebuiFrame(candidate)).toBe(true);
    expect(judgeWebuiFrame(candidate).ok).toBe(true);
  });

  it("keeps the version mismatch ahead of the identity refusal", () => {
    // A frame from another protocol version cannot be judged against this
    // one's shape, so its (possibly absent) identity is not the finding.
    const judged = judgeWebuiFrame({ protocolVersion: 99, kind: "request", requestId: "" });
    expect(judged.ok).toBe(false);
    if (!judged.ok) expect(judged.code).toBe(WebuiErrorCode.protocolMismatch);
  });

  it("agrees with the judgement for every legal kind that carries an identity", () => {
    for (const kind of ["request", "response", "error", "event"] as const) {
      const candidate = { protocolVersion: 1, kind, requestId: `r-${kind}` };
      expect(isWebuiFrame(candidate), `${kind} was not accepted`).toBe(true);
      expect(judgeWebuiFrame(candidate).ok, `${kind} was not judged a frame`).toBe(true);
    }
  });

  it("does not dispatch a request the identity rule refuses", async () => {
    const calls: unknown[] = [];
    const registry = new Map<string, WebuiOperationRegistryEntry>([
      [
        "listSessions",
        {
          operation: {
            name: "listSessions",
            validate: (body: unknown) => ({ ok: true, body }),
          },
          handle: async () => {
            calls.push("handled");
            return { body: { sessions: [] } };
          },
        },
      ],
    ]);
    const target = socket();
    await dispatchWebuiFrame(
      target as unknown as WebSocket,
      { protocolVersion: 1, kind: "request", requestId: "", operation: "listSessions", body: {} },
      registry,
      true,
      () => undefined,
    );
    assert.deepEqual(calls, [], "an unidentified request must not reach its operation");
    const refusal = JSON.parse(target.sent[0] ?? "{}") as { kind?: string; code?: string };
    assert.equal(refusal.kind, "error");
    assert.equal(refusal.code, WebuiErrorCode.invalidEnvelope);
  });
});

describe("the client decodes what the service sent", () => {
  it("accepts a response frame", () => {
    const decoded = decodeWebuiServerFrame(
      encode({ protocolVersion: 1, kind: "response", requestId: "r1", body: { ok: true } }),
    );
    expect(decoded.ok).toBe(true);
  });

  it("separates JSON that is not JSON from a frame that is one", () => {
    const notJson = decodeWebuiServerFrame("{not json");
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.reason).toBe("invalid_json");

    const notAFrame = decodeWebuiServerFrame(encode({ hello: "world" }));
    expect(notAFrame.ok).toBe(false);
    if (!notAFrame.ok) expect(notAFrame.reason).toBe("invalid_envelope");
  });

  it("rejects an error frame that carries no code", () => {
    // A refusal whose code is missing cannot be branched on, so it is not a
    // refusal the client is able to act on.
    const decoded = decodeWebuiServerFrame(
      encode({ protocolVersion: 1, kind: "error", requestId: "r1", message: "no" }),
    );
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe("invalid_envelope");
  });

  it("keeps the code on a well-formed refusal, whatever it says", () => {
    const decoded = decodeWebuiServerFrame(
      encode({
        protocolVersion: 1,
        kind: "error",
        requestId: "r1",
        code: "capability_not_ready",
        message: "still starting",
      }),
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("unreachable");
    expect(decoded.frame.kind === "error" && decoded.frame.code).toBe("capability_not_ready");
  });
});

describe("a refusal is branchable without reading its raw shape", () => {
  it("names an absent capability differently from a failing one", () => {
    // The distinction that lets a surface hide a control it will never have
    // while still offering a retry for one that would work.
    const absent = new WebuiWireError(
      WebuiErrorCode.capabilityUnavailable,
      "runtime host does not expose the CLI service",
    );
    const failing = new WebuiWireError(
      WebuiErrorCode.harnessError,
      "the file could not be read",
    );
    expect(absent.code).not.toBe(failing.code);
    expect(absent.message).not.toBe(failing.message);
  });

  it("carries a code the client can compare against the named set", () => {
    const error = new WebuiWireError(WebuiErrorCode.shuttingDown, "stopping", "r1");
    expect(error.code === WebuiErrorCode.shuttingDown).toBe(true);
    expect(error.requestId).toBe("r1");
  });
});
