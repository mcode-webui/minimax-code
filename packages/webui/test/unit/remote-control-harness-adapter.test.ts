/**
 * The remote-control cell of the harness port.
 *
 * Three claims, all about the boundary rather than about the phone link:
 *
 *   * the bridge's own status converts into the wire DTO the browser is allowed to know — the
 *     phase, the pairing code, its expiry and the bridge's own `last_error`, and nothing else;
 *   * a host without the runtime's CLI service answers every member with one
 *     `capability_unavailable` refusal instead of crashing on an absent method;
 *   * the phase reported is the bridge's, never an invented one: a host that has not paired
 *     anything reads `idle`, not `connected`.
 *
 * The real adapter and the real bridge run here; only the host leaves are scripted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRemoteControlAdapter } from "../../src/runtime/harness/remote-control.js";
import type { WebuiRuntimeHostHandle } from "../../src/runtime/harness/host-contract.js";

const dataDirs: string[] = [];

function dataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "webui-remote-control-"));
  dataDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dataDirs.length > 0) {
    const dir = dataDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A host that has the runtime but nothing to say. */
function hostWith(cliService: unknown, dir = dataDir()): WebuiRuntimeHostHandle {
  return {
    apiHost: { close: async () => {} },
    cliService: cliService as never,
    dataDir: dir,
  } as unknown as WebuiRuntimeHostHandle;
}

/** A CLI service with no events to publish. */
function cliServiceStub(overrides: Record<string, unknown> = {}) {
  return {
    watchEvents: async function* watchEvents() {
      // An idle runtime: the stream never yields and never ends on its own.
      await new Promise<void>(() => {});
    },
    ...overrides,
  };
}

describe("the remote-control adapter", () => {
  it("reports the bridge's own phase rather than an invented one", async () => {
    const port = createRemoteControlAdapter(hostWith(cliServiceStub()));

    const status = await port.getRemoteControlStatus();

    // Nothing has been paired, so the phase is the bridge's `idle`.
    expect(status.phase).toBe("idle");
    // The machine's identity is part of the status: it is what the pairing page shows.
    expect(status.deviceId).toMatch(/^[0-9a-f-]{8,}$/u);
    expect(status.deviceName).toBeTruthy();
    // The bridge's internal epochs never cross this line.
    expect(Object.keys(status)).not.toContain("request_epoch");
    expect(Object.keys(status)).not.toContain("producer_generation");
  });

  it("answers every member with one refusal when the host has no CLI service", async () => {
    const port = createRemoteControlAdapter({
      apiHost: { close: async () => {} },
      dataDir: dataDir(),
    } as unknown as WebuiRuntimeHostHandle);

    const refusal = async (call: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
      const error = (await call().catch((reason: unknown) => reason)) as {
        code?: string;
        message?: string;
      };
      return { ...(error.code === undefined ? {} : { code: error.code }), message: error.message ?? "" };
    };

    const refusals = await Promise.all([
      refusal(() => port.getRemoteControlStatus()),
      refusal(() => port.watchRemoteControlStatus()),
      refusal(() => port.connectRemoteControl({})),
      refusal(() => port.disconnectRemoteControl({})),
      refusal(() =>
        port.applyRemoteControlCredentials({
          bindingId: 1,
          ticket: "t",
          endpoint: "wss://example.invalid",
        }),
      ),
      refusal(() => port.reportRemoteControlBindingLost()),
      refusal(() => port.getRemoteControlPendingUnbind()),
      refusal(() => port.resolveRemoteControlUnbind({ requestId: "r", confirmed: true })),
      refusal(() => port.publishRemoteControlComposerMode({ sessionId: "s", mode: "plan" })),
    ]);

    for (const answer of refusals) {
      expect(answer.code).toBe("capability_unavailable");
      expect(answer.message).toContain("runtime host does not expose the CLI service");
    }
  });

  it("never writes a ticket or a token into the persisted state", async () => {
    const dir = dataDir();
    const port = createRemoteControlAdapter(hostWith(cliServiceStub(), dir));

    await port.getRemoteControlStatus();

    const { readFileSync } = await import("node:fs");
    const state = readFileSync(path.join(dir, "remote-control", "state.json"), "utf8");
    expect(state).not.toContain("ticket");
    expect(state).not.toContain("jwt");
    expect(state).not.toContain("token");
  });
});
