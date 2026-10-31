// The wire's two ends: what a frame is judged as, and what a refusal carries.
//
// Both checks used to be re-implemented per side and per file. The server called
// anything it could not parse a protocol mismatch, and the client checked nothing
// at all — so the two disagreed about what a given frame was. These cases pin the
// one shared judgement both ends now use.

import { describe, expect, it } from "vitest";

import { judgeWebuiFrame } from "../../src/server/envelope.js";
import {
  decodeWebuiServerFrame,
  WebuiErrorCode,
  WebuiWireError,
} from "../../src/shared/envelope.js";

const encode = (value: unknown): string => JSON.stringify(value);

describe("the service judges an inbound frame", () => {
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
