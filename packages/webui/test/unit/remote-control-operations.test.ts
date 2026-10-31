/**
 * The 远程控制 wire operations.
 *
 * The validators check the shape a browser may send and nothing else: a flag, an identity, and the
 * three fields a signed one-shot ticket carries. The claim under test is that a malformed body is
 * refused with one stated reason, and that a well-formed body passes through unchanged — the
 * ticket's *value* is never inspected, never rewritten and never echoed back.
 */
import { describe, expect, it } from "vitest";

import {
  applyRemoteControlCredentialsOperation,
  connectRemoteControlOperation,
  disconnectRemoteControlOperation,
  getRemoteControlPendingUnbindOperation,
  getRemoteControlStatusOperation,
  publishRemoteControlComposerModeOperation,
  reportRemoteControlBindingLostOperation,
  resolveRemoteControlUnbindOperation,
  watchRemoteControlStatusOperation,
} from "../../src/server/operation/remote-control.js";

describe("the remote-control operation descriptors", () => {
  it("names the nine operations the 远程控制 surface uses", () => {
    expect([
      getRemoteControlStatusOperation.name,
      watchRemoteControlStatusOperation.name,
      connectRemoteControlOperation.name,
      disconnectRemoteControlOperation.name,
      applyRemoteControlCredentialsOperation.name,
      reportRemoteControlBindingLostOperation.name,
      getRemoteControlPendingUnbindOperation.name,
      resolveRemoteControlUnbindOperation.name,
      publishRemoteControlComposerModeOperation.name,
    ]).toEqual([
      "getRemoteControlStatus",
      "watchRemoteControlStatus",
      "connectRemoteControl",
      "disconnectRemoteControl",
      "applyRemoteControlCredentials",
      "reportRemoteControlBindingLost",
      "getRemoteControlPendingUnbind",
      "resolveRemoteControlUnbind",
      "publishRemoteControlComposerMode",
    ]);
  });

  it("takes no body for the read-only members", () => {
    for (const operation of [
      getRemoteControlStatusOperation,
      watchRemoteControlStatusOperation,
      reportRemoteControlBindingLostOperation,
      getRemoteControlPendingUnbindOperation,
    ]) {
      expect(operation.validate(undefined)).toEqual({ ok: true, body: undefined });
      expect(operation.validate({})).toEqual({ ok: true, body: undefined });
      const refusal = operation.validate({ unexpected: true });
      expect(refusal.ok).toBe(false);
    }
  });

  it("passes the pairing flag through unchanged", () => {
    expect(connectRemoteControlOperation.validate({ requestCode: true })).toEqual({
      ok: true,
      body: { requestCode: true },
    });
    expect(connectRemoteControlOperation.validate({}).ok).toBe(true);
    expect(connectRemoteControlOperation.validate({ requestCode: "yes" }).ok).toBe(false);
  });

  it("passes the unbind flag through unchanged", () => {
    expect(disconnectRemoteControlOperation.validate({ unbind: true })).toEqual({
      ok: true,
      body: { unbind: true },
    });
    expect(disconnectRemoteControlOperation.validate({ unbind: 1 }).ok).toBe(false);
  });

  it("checks the signed ticket's shape without touching its value", () => {
    const body = { bindingId: 7, ticket: "one-shot", endpoint: "wss://gateway.example.invalid" };
    expect(applyRemoteControlCredentialsOperation.validate(body)).toEqual({ ok: true, body });
    // The optional fields are elided rather than emitted as undefined.
    expect(
      applyRemoteControlCredentialsOperation.validate({ ...body, producerGeneration: 3 }),
    ).toEqual({ ok: true, body: { ...body, producerGeneration: 3 } });
    expect(applyRemoteControlCredentialsOperation.validate({ ...body, ticket: "" }).ok).toBe(false);
    expect(applyRemoteControlCredentialsOperation.validate({ ...body, endpoint: 7 }).ok).toBe(false);
    expect(applyRemoteControlCredentialsOperation.validate({ ...body, bindingId: "7" }).ok).toBe(
      false,
    );
  });

  it("requires the unbind confirmation to name a request", () => {
    expect(
      resolveRemoteControlUnbindOperation.validate({ requestId: "r-1", confirmed: true }),
    ).toEqual({ ok: true, body: { requestId: "r-1", confirmed: true } });
    expect(resolveRemoteControlUnbindOperation.validate({ requestId: "", confirmed: true }).ok).toBe(
      false,
    );
    expect(resolveRemoteControlUnbindOperation.validate({ requestId: "r-1" }).ok).toBe(false);
  });

  it("accepts only the composer modes the runtime knows", () => {
    for (const mode of ["default", "goal", "plan"]) {
      expect(
        publishRemoteControlComposerModeOperation.validate({ sessionId: "s-1", mode }),
      ).toEqual({ ok: true, body: { sessionId: "s-1", mode } });
    }
    expect(
      publishRemoteControlComposerModeOperation.validate({ sessionId: "s-1", mode: "yolo" }).ok,
    ).toBe(false);
    expect(
      publishRemoteControlComposerModeOperation.validate({ sessionId: "", mode: "plan" }).ok,
    ).toBe(false);
  });
});
