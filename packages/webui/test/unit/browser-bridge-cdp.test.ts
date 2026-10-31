// The bridge's DevTools command routing.
//
// A DevTools command must not be able to reach a tab that an input command
// could not, and two DevTools commands against one tab must not interleave.
// These tests pin both: the routing, the ownership check and the
// serialization are the input path's, and the DevTools path uses them.

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BrowserBridgePairing,
  BrowserBridgeRegistry,
  createInMemorySecureCredentialStore,
  type BrowserBridgeCommandOutcome,
} from "../../src/server/browser-bridge/index.js";
import type { WebuiBrowserBridgeTarget } from "../../src/shared/contracts/browser-bridge.js";
import type { WebuiBridgeBrowserSurface } from "../../src/shared/contracts/browser.js";

const KNOWN_EDGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";

/** A fake session that records the DevTools commands it was handed. */
class FakeSession extends EventEmitter {
  readonly pairing: BrowserBridgePairing;
  readonly sessionId: string;
  readonly cdpReceived: {
    readonly targetId: string;
    readonly generation: number;
    readonly method: string;
    readonly params: Record<string, unknown>;
  }[] = [];
  /** Lets a test hold a command open, for the serialization checks. */
  onSendCdp:
    | ((command: {
        readonly targetId: string;
        readonly generation: number;
        readonly method: string;
        readonly params: Record<string, unknown>;
      }) => Promise<void> | void)
    | undefined;

  constructor(pairing: BrowserBridgePairing, sessionId: string) {
    super();
    this.pairing = pairing;
    this.sessionId = sessionId;
  }

  async sendCdp(command: {
    readonly targetId: string;
    readonly generation: number;
    readonly method: string;
    readonly params: Record<string, unknown>;
  }): Promise<BrowserBridgeCommandOutcome> {
    this.cdpReceived.push(command);
    if (this.onSendCdp) await this.onSendCdp(command);
    return { kind: "accepted", commandId: "cdp-1", result: { echoed: command.method } };
  }

  close(reason: unknown): void {
    this.emit("closed", reason);
  }
}

function makePairing(surface: WebuiBridgeBrowserSurface): BrowserBridgePairing {
  return new BrowserBridgePairing({
    surface,
    credentialStore: createInMemorySecureCredentialStore(),
    allowedExtensionIds: new Set([KNOWN_EDGE_ID]),
  });
}

function makeRegistry(
  surfaces: readonly WebuiBridgeBrowserSurface[] = ["edge", "chrome"],
): BrowserBridgeRegistry {
  return new BrowserBridgeRegistry({
    pairings: new Map(surfaces.map((surface) => [surface, makePairing(surface)])),
    createSession: ((pairing: BrowserBridgePairing) =>
      new FakeSession(pairing, "sess-1") as unknown as never) as never,
  });
}

function announced(
  browserId: string,
  targetId: string,
  generation: number,
): WebuiBrowserBridgeTarget {
  return { browserId, targetId, title: "t", url: "https://example.test/", generation };
}

async function admit(
  registry: BrowserBridgeRegistry,
  surface: WebuiBridgeBrowserSurface,
  browserId: string,
  sessionId: string,
): Promise<FakeSession> {
  const session = new FakeSession(registry.pairings.get(surface)!, sessionId);
  await registry.registerSession(surface, browserId, session as unknown as never);
  return session;
}

describe("the bridge's DevTools command routing", () => {
  let registry: BrowserBridgeRegistry;

  beforeEach(() => {
    registry = makeRegistry(["edge"]);
  });

  it("delivers a DevTools command to the session that announced the target", async () => {
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab9", 3)]);

    const outcome = await registry.dispatchCdp({
      target: { surface: "edge", browserId: "browserA", targetId: "tab9", generation: 3 },
      method: "Runtime.evaluate",
      params: { expression: "1" },
    });

    expect(outcome.kind).toBe("accepted");
    expect(session.cdpReceived).toHaveLength(1);
    expect(session.cdpReceived[0]?.method).toBe("Runtime.evaluate");
    expect(session.cdpReceived[0]?.targetId).toBe("tab9");
  });

  it("refuses a DevTools command for a target no session announced", async () => {
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab9", 3)]);

    const outcome = await registry.dispatchCdp({
      target: { surface: "edge", browserId: "browserA", targetId: "tab-other", generation: 1 },
      method: "Runtime.evaluate",
      params: {},
    });

    expect(outcome.kind).toBe("rejected");
    expect(session.cdpReceived).toHaveLength(0);
  });

  it("refuses a DevTools command whose generation the announcement moved past", async () => {
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab9", 3)]);

    const outcome = await registry.dispatchCdp({
      target: { surface: "edge", browserId: "browserA", targetId: "tab9", generation: 2 },
      method: "Runtime.evaluate",
      params: {},
    });

    expect(outcome.kind).toBe("rejected");
    expect(session.cdpReceived).toHaveLength(0);
  });

  it("refuses a DevTools command that names a surface the owner does not serve", async () => {
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab9", 1)]);

    const outcome = await registry.dispatchCdp({
      target: { surface: "chrome", browserId: "browserA", targetId: "tab9", generation: 1 },
      method: "Runtime.evaluate",
      params: {},
    });

    expect(outcome.kind).toBe("rejected");
    expect(session.cdpReceived).toHaveLength(0);
  });

  it("serializes DevTools commands against the same tab", async () => {
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab9", 1)]);

    const order: string[] = [];
    let release: (() => void) | undefined;
    session.onSendCdp = async (command) => {
      order.push(`start:${command.method}`);
      if (command.method === "first") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      order.push(`end:${command.method}`);
    };

    const first = registry.dispatchCdp({
      target: { surface: "edge", browserId: "browserA", targetId: "tab9", generation: 1 },
      method: "first",
      params: {},
    });
    // The second command must not start until the first has finished.
    const second = registry.dispatchCdp({
      target: { surface: "edge", browserId: "browserA", targetId: "tab9", generation: 1 },
      method: "second",
      params: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["start:first"]);
    release?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("lets DevTools commands against different tabs proceed in parallel", async () => {
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [
      announced("browserA", "tab1", 1),
      announced("browserA", "tab2", 1),
    ]);

    const order: string[] = [];
    session.onSendCdp = async (command) => {
      order.push(`start:${command.targetId}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${command.targetId}`);
    };

    await Promise.all([
      registry.dispatchCdp({
        target: { surface: "edge", browserId: "browserA", targetId: "tab1", generation: 1 },
        method: "Runtime.evaluate",
        params: {},
      }),
      registry.dispatchCdp({
        target: { surface: "edge", browserId: "browserA", targetId: "tab2", generation: 1 },
        method: "Runtime.evaluate",
        params: {},
      }),
    ]);

    // Two tabs interleaved; the same tab would not have.
    expect(order).toEqual(["start:tab1", "start:tab2", "end:tab1", "end:tab2"]);
  });
});
