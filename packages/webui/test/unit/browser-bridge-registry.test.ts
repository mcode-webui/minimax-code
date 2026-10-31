// Where a command goes, and where it is refused.
//
// The registry's switch lifecycle — disable revokes, closes the live
// session, and rejects any subsequent proof; re-enable mints a fresh
// credential — is covered first. The dispatch half is the larger part: a
// command must reach the session that announced its exact
// `(browserId, targetId, generation)`, and anything else must be refused
// rather than delivered to whichever session answered most recently.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";

import {
  BrowserBridgePairing,
  BrowserBridgeRegistry,
  createInMemorySecureCredentialStore,
  type BrowserBridgeCommandOutcome,
} from "../../src/server/browser-bridge/index.js";
import type {
  WebuiBrowserBridgeInputCommand,
  WebuiBrowserBridgeTarget,
} from "../../src/shared/contracts/browser-bridge.js";
import type {
  WebuiBridgeBrowserSurface,
  WebuiBrowserInputCommand,
} from "../../src/shared/contracts/browser.js";

const KNOWN_EDGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";

/** A fake session — closeable, observable, with a pairing. */
class FakeSession extends EventEmitter {
  static instances: FakeSession[] = [];
  readonly pairing: BrowserBridgePairing;
  readonly sessionId: string;
  readonly socket: { terminateCalls: number; pinged: number };
  isAdmitted = true;
  closedReason: unknown = undefined;
  /** Every wire command this session was handed, in order. */
  readonly received: WebuiBrowserBridgeInputCommand[] = [];
  /** Lets a test hold a command open, for the serialization checks. */
  onSendInput: ((wire: WebuiBrowserBridgeInputCommand) => Promise<void> | void) | undefined;
  constructor(pairing: BrowserBridgePairing, sessionId: string) {
    super();
    this.pairing = pairing;
    this.sessionId = sessionId;
    this.socket = { terminateCalls: 0, pinged: 0 };
    FakeSession.instances.push(this);
  }
  async sendInput(command: WebuiBrowserBridgeInputCommand): Promise<BrowserBridgeCommandOutcome> {
    this.received.push(command);
    if (this.onSendInput) await this.onSendInput(command);
    return { kind: "accepted", commandId: "accepted" };
  }
  close(reason: unknown): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    this.emit("closed", reason);
  }
}

/** A factory that returns a FakeSession recording its construction. */
function makeFactory(): (pairing: BrowserBridgePairing) => FakeSession {
  return (pairing) => new FakeSession(pairing, `s-${FakeSession.instances.length}`);
}

describe("BrowserBridgeRegistry — switch lifecycle", () => {
  let registry: BrowserBridgeRegistry;

  beforeEach(() => {
    registry = new BrowserBridgeRegistry({
      pairings: new Map([
        ["edge", new BrowserBridgePairing({
          surface: "edge",
          credentialStore: createInMemorySecureCredentialStore(),
          allowedExtensionIds: new Set([KNOWN_EDGE_ID]),
        })],
        ["chrome", new BrowserBridgePairing({
          surface: "chrome",
          credentialStore: createInMemorySecureCredentialStore(),
          allowedExtensionIds: new Set([KNOWN_EDGE_ID]),
        })],
      ]),
      createSession: makeFactory() as unknown as (p: BrowserBridgePairing) => never,
    });
  });

  afterEach(() => {
    void registry.shutdown();
    FakeSession.instances = [];
  });

  it("starts with both surfaces disabled", () => {
    expect(registry.snapshot().surfaces.edge.enabled).toBe(false);
    expect(registry.snapshot().surfaces.chrome.enabled).toBe(false);
  });

  it("enableSurface mints a credential, disableSurface revokes it", async () => {
    await registry.enableSurface("edge");
    const enabled = registry.snapshot().surfaces.edge;
    expect(enabled.enabled).toBe(true);
    expect(enabled.keyId).toBeDefined();
    expect(enabled.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    await registry.disableSurface("edge");
    expect(registry.snapshot().surfaces.edge.enabled).toBe(false);
    expect(registry.snapshot().surfaces.edge.keyId).toBeUndefined();
  });

  it("enableSurface mints a DIFFERENT credential each time", async () => {
    await registry.enableSurface("edge");
    const first = registry.snapshot().surfaces.edge.keyId;
    await registry.disableSurface("edge");
    await registry.enableSurface("edge");
    const second = registry.snapshot().surfaces.edge.keyId;
    expect(first).not.toBe(second);
  });

  it("disableSurface closes every live session for that browser", async () => {
    const edge = registry.pairings.get("edge")!;
    await edge.enable();
    const session = new FakeSession(edge, "sess-A");
    await registry.registerSession("edge", "browserA", session as unknown as never);
    expect(FakeSession.instances.at(-1)).toBe(session);
    await registry.disableSurface("edge");
    expect(session.closedReason).toBeDefined();
  });

  it("a later presentation of the old credential is refused after disable", async () => {
    const edge = registry.pairings.get("edge")!;
    await edge.enable();
    const oldKeyId = edge.keyId;
    const oldChallenge = await edge.issueChallenge();
    const oldSigned = await edge.signProof(oldChallenge.nonce);
    edge.forgetChallenge(oldChallenge.nonce);
    await registry.disableSurface("edge");
    // The pairing is now off. A new pairing is enabled (later in the test)
    // AFTER the disable, but the OLD credential must still fail.
    // First check: directly through the pairing, the credential is gone.
    expect(edge.enabled).toBe(false);
    // Second check: a presentation of the old credential must fail.
    const valid = await edge.verifyProof({
      kind: "proof",
      keyId: oldKeyId!,
      nonce: oldChallenge.nonce,
      signature: oldSigned,
    });
    expect(valid).toEqual({ kind: "refused", reason: "switched_off" });
  });

  it("does not affect the other surface", async () => {
    await registry.enableSurface("edge");
    await registry.enableSurface("chrome");
    const chromeKeyBefore = registry.snapshot().surfaces.chrome.keyId;
    await registry.disableSurface("edge");
    expect(registry.snapshot().surfaces.edge.enabled).toBe(false);
    expect(registry.snapshot().surfaces.chrome.enabled).toBe(true);
    expect(registry.snapshot().surfaces.chrome.keyId).toBe(chromeKeyBefore);
  });

  it("enabling a surface revokes the prior credential and closes the prior session", async () => {
    const edge = registry.pairings.get("edge")!;
    await edge.enable();
    const session = new FakeSession(edge, "sess-B");
    await registry.registerSession("edge", "browserA", session as unknown as never);
    await registry.enableSurface("edge");
    expect(session.closedReason).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Target routing                                                              */
/* -------------------------------------------------------------------------- */

/** The parts of a pairing the registry actually reads. */
function makePairing(surface: WebuiBridgeBrowserSurface): BrowserBridgePairing {
  const credential = { keyId: "k", fingerprint: "f", savedAt: 0 };
  return {
    surface,
    status: () => ({ enabled: true, credential }),
    enable: async () => credential,
    disable: async () => undefined,
  } as unknown as BrowserBridgePairing;
}

function makeRoutingRegistry(
  surfaces: readonly WebuiBridgeBrowserSurface[] = ["edge", "chrome"],
): BrowserBridgeRegistry {
  return new BrowserBridgeRegistry({
    pairings: new Map(surfaces.map((surface) => [surface, makePairing(surface)])),
  });
}

function announced(
  browserId: string,
  targetId: string,
  generation: number,
): WebuiBrowserBridgeTarget {
  return { browserId, targetId, title: "t", url: "https://example.test/", generation };
}

function textCommand(
  surface: WebuiBridgeBrowserSurface,
  browserId: string,
  targetId: string,
  generation: number,
  text = "x",
): WebuiBrowserInputCommand {
  return { kind: "text", target: { surface, browserId, targetId, generation }, text };
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

describe("BrowserBridgeRegistry — target ownership", () => {
  it("delivers a command only to the session that announced that target", async () => {
    const registry = makeRoutingRegistry(["edge"]);
    const first = await admit(registry, "edge", "browserA", "sess-1");
    const second = await admit(registry, "edge", "browserB", "sess-2");
    // Two Edge windows are live and both admitted. `second` was admitted
    // last, which is exactly the case where "most recent" would answer.
    registry.announceTargets(first as never, [announced("browserA", "tab1", 1)]);
    registry.announceTargets(second as never, [announced("browserB", "tab2", 1)]);

    const outcome = await registry.dispatch(textCommand("edge", "browserA", "tab1", 1));
    expect(outcome.kind).toBe("accepted");
    expect(first.received).toHaveLength(1);
    expect(first.received[0]).toMatchObject({ kind: "text", targetId: "tab1" });
    expect(second.received).toHaveLength(0);

    await registry.dispatch(textCommand("edge", "browserB", "tab2", 1, "y"));
    expect(second.received).toHaveLength(1);
    expect(first.received).toHaveLength(1);
  });

  it("routes each tab of the same browser to the session that announced it", async () => {
    const registry = makeRoutingRegistry(["chrome"]);
    const first = await admit(registry, "chrome", "browserC", "sess-c1");
    const second = await admit(registry, "chrome", "browserC", "sess-c2");
    registry.announceTargets(first as never, [announced("browserC", "tab1", 1)]);
    registry.announceTargets(second as never, [announced("browserC", "tab2", 4)]);

    await registry.dispatch(textCommand("chrome", "browserC", "tab2", 4, "second"));
    expect(second.received).toHaveLength(1);
    expect(first.received).toHaveLength(0);
  });

  it("refuses a target no session announced instead of guessing a session", async () => {
    const registry = makeRoutingRegistry(["edge"]);
    const live = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(live as never, [announced("browserA", "tab1", 1)]);

    const outcome = await registry.dispatch(textCommand("edge", "browserA", "ghost", 1));
    expect(outcome.kind).toBe("rejected");
    expect(outcome.kind === "rejected" ? outcome.reason : "").toContain("ghost");
    // The live session must not have been handed a command for a tab it
    // never claimed.
    expect(live.received).toHaveLength(0);
  });

  it("refuses a command whose generation does not match the announcement", async () => {
    const registry = makeRoutingRegistry(["edge"]);
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab1", 7)]);

    const outcome = await registry.dispatch(textCommand("edge", "browserA", "tab1", 6));
    expect(outcome.kind).toBe("rejected");
    expect(outcome.kind === "rejected" ? outcome.reason : "").toContain("moved on");
    expect(session.received).toHaveLength(0);

    // The matching generation still goes through.
    const accepted = await registry.dispatch(textCommand("edge", "browserA", "tab1", 7));
    expect(accepted.kind).toBe("accepted");
    expect(session.received).toHaveLength(1);
  });

  it("lets a higher generation supersede the earlier claim on a tab", async () => {
    const registry = makeRoutingRegistry(["edge"]);
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab1", 1)]);
    // The tab navigated: same tab id, new page, new generation.
    registry.announceTargets(session as never, [announced("browserA", "tab1", 2)]);

    const stale = await registry.dispatch(textCommand("edge", "browserA", "tab1", 1));
    expect(stale.kind).toBe("rejected");
    const current = await registry.dispatch(textCommand("edge", "browserA", "tab1", 2));
    expect(current.kind).toBe("accepted");
  });

  it("ignores a late announcement from a generation the extension moved past", async () => {
    const registry = makeRoutingRegistry(["edge"]);
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab1", 5)]);
    // A duplicated, out-of-order frame must not roll the table back to a
    // page that no longer exists.
    registry.announceTargets(session as never, [announced("browserA", "tab1", 2)]);

    const stale = await registry.dispatch(textCommand("edge", "browserA", "tab1", 2));
    expect(stale.kind).toBe("rejected");
    const current = await registry.dispatch(textCommand("edge", "browserA", "tab1", 5));
    expect(current.kind).toBe("accepted");
    expect(session.received).toHaveLength(1);
  });

  it("stops routing to a target once the announcing session has gone away", async () => {
    const registry = makeRoutingRegistry(["edge"]);
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab1", 1)]);
    expect((await registry.dispatch(textCommand("edge", "browserA", "tab1", 1))).kind).toBe(
      "accepted",
    );

    session.close({ kind: "remote" });

    const afterClose = await registry.dispatch(textCommand("edge", "browserA", "tab1", 1));
    expect(afterClose.kind).toBe("rejected");
  });

  it("learns ownership from the session's own targets frame", async () => {
    const registry = makeRoutingRegistry(["edge"]);
    const session = await admit(registry, "edge", "browserA", "sess-1");
    // The shape `BrowserBridgeSession` emits; the registry subscribes to it
    // so wiring code does not have to relay announcements.
    session.emit("targets", "browserA", [announced("browserA", "tab9", 3)]);

    const outcome = await registry.dispatch(textCommand("edge", "browserA", "tab9", 3));
    expect(outcome.kind).toBe("accepted");
    expect(session.received).toHaveLength(1);
  });

  it("refuses a command whose surface disagrees with the owning session", async () => {
    const registry = makeRoutingRegistry(["edge", "chrome"]);
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab1", 1)]);

    const outcome = await registry.dispatch(textCommand("chrome", "browserA", "tab1", 1));
    expect(outcome.kind).toBe("rejected");
    expect(outcome.kind === "rejected" ? outcome.reason : "").toContain("edge");
    expect(session.received).toHaveLength(0);
  });

  it("refuses a command that names no bridge surface", async () => {
    const registry = makeRoutingRegistry(["edge"]);
    const session = await admit(registry, "edge", "browserA", "sess-1");
    registry.announceTargets(session as never, [announced("browserA", "tab1", 1)]);

    const outcome = await registry.dispatch({
      kind: "text",
      target: { surface: "isolated-chromium", browserId: "browserA", targetId: "tab1", generation: 1 },
      text: "x",
    } as WebuiBrowserInputCommand);
    expect(outcome.kind).toBe("rejected");
    expect(session.received).toHaveLength(0);
  });
});

describe("BrowserBridgeRegistry — command dispatch", () => {
  it("serializes operations against the SAME tab but allows independent tabs", async () => {
    // Track per-target concurrency. A serialized queue must NEVER see
    // overlap on the same target; independent tabs may overlap freely.
    const inFlightPerTarget = new Map<string, number>();
    const maxInFlightPerTarget = new Map<string, number>();
    const orderPerTarget = new Map<string, string[]>();

    function note(target: string, slot: string) {
      const order = orderPerTarget.get(target) ?? [];
      order.push(slot);
      orderPerTarget.set(target, order);
    }
    function enter(target: string): void {
      const current = inFlightPerTarget.get(target) ?? 0;
      const next = current + 1;
      inFlightPerTarget.set(target, next);
      const max = maxInFlightPerTarget.get(target) ?? 0;
      if (next > max) maxInFlightPerTarget.set(target, next);
    }
    function leave(target: string): void {
      const current = inFlightPerTarget.get(target) ?? 0;
      inFlightPerTarget.set(target, current - 1);
    }

    const session = new EventEmitter() as unknown as {
      isAdmitted: boolean;
      pairing: BrowserBridgePairing;
      sendInput: (input: unknown) => Promise<{ readonly kind: string }>;
      close: (reason: unknown) => void;
      sessionId: string;
    };
    session.pairing = { surface: "edge" } as BrowserBridgePairing;
    session.isAdmitted = true;
    session.sessionId = "sess-serial";
    session.sendInput = async (input: unknown) => {
      const wire = input as { readonly targetId: string; readonly text?: string };
      const targetId = wire.targetId;
      note(targetId, `start:${wire.text ?? ""}`);
      enter(targetId);
      try {
        // Simulate the round-trip to the bridge.
        await new Promise((r) => setImmediate(r));
        note(targetId, `end:${wire.text ?? ""}`);
        return { kind: "accepted" };
      } finally {
        leave(targetId);
      }
    };
    session.close = () => undefined;

    const registry = new BrowserBridgeRegistry({
      pairings: new Map([
        ["edge", { pairing: session.pairing, admitsExtensionId: () => true, issueChallenge: () => Promise.reject(new Error("nope")), verifyProof: () => Promise.resolve(false), signProof: () => Promise.resolve(""), enable: () => Promise.resolve({ keyId: "k", fingerprint: "f", savedAt: 0 }), disable: () => Promise.resolve(), status: () => ({ enabled: true, credential: { keyId: "k", fingerprint: "f", savedAt: 0 } }), forgetChallenge: () => undefined, outstandingNonceCount: () => 0 } as unknown as BrowserBridgePairing],
      ]),
    });
    await registry.registerSession("edge", "browserA", session as never);
    // Serialization is per announced target, so both tabs have to be known
    // before any command is routed.
    registry.announceTargets(session as never, [
      announced("browserA", "tab1", 1),
      announced("browserA", "tab2", 1),
    ]);

    const sameTab1 = textCommand("edge", "browserA", "tab1", 1, "1");
    const sameTab2 = textCommand("edge", "browserA", "tab1", 1, "2");
    const otherTab = textCommand("edge", "browserA", "tab2", 1, "3");

    const p1 = registry.dispatch(sameTab1);
    const p2 = registry.dispatch(sameTab2);
    const p3 = registry.dispatch(otherTab);
    await Promise.all([p1, p2, p3]);

    // The same target never has more than one in-flight call. The
    // independent tab can overlap with the same-tab serial queue; the
    // per-target invariant is the property the ADR requires.
    expect(maxInFlightPerTarget.get("tab1") ?? 0).toBe(1);
    // Independent tab may have overlapped; we only assert it ran.
    expect((orderPerTarget.get("tab2") ?? []).length).toBeGreaterThanOrEqual(2);
    // The same-tab commands ran in submission order: `1` before `2`.
    const tab1 = orderPerTarget.get("tab1") ?? [];
    const start1 = tab1.indexOf("start:1");
    const end1 = tab1.indexOf("end:1");
    const start2 = tab1.indexOf("start:2");
    expect(start1).toBeLessThan(end1);
    expect(end1).toBeLessThan(start2);
  });

  it("returns an explicit refusal when no live session matches the target", async () => {
    const registry = makeRoutingRegistry(["edge"]);
    const outcome = await registry.dispatch(textCommand("edge", "ghost", "ghost", 1));
    expect(outcome.kind).toBe("rejected");
  });
});

// Reserved imports keep tree-shaking honest for typings that are only used
// through duck-typing in this file.
void (null as unknown as WebSocket);