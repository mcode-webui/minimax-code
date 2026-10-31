// The standalone presentation lease (ADR 0020).
//
// The record is the service's own answer to "which presentation is live", and it
// is what `detached` and `presentationRevision` in the catalogue are read from.
// These cases pin the three properties the ticket names: a lease exists while a
// document holds it, the revision moves on every acquisition, and a release only
// clears the lease it owns.
//
// Pure state, no sockets: the socket-lifetime half is
// `miniapp-operations.test.ts`, which drives the stream that holds the lease.

import { describe, expect, it } from "vitest";

import { createMiniAppPresentationLeases } from "../../src/server/miniapp/presentation-lease.js";

const PLUGIN = "fixture.miniapp";

describe("the presentation lease", () => {
  it("reports a plugin as detached only while a lease is live", () => {
    const leases = createMiniAppPresentationLeases();
    expect(leases.detached(PLUGIN)).toBe(false);
    expect(leases.revision(PLUGIN)).toBe(0);

    const lease = leases.acquire({ pluginId: PLUGIN, sessionId: "session-1" });
    expect(leases.detached(PLUGIN)).toBe(true);
    expect(lease.presentationRevision).toBe(1);

    leases.release(lease);
    expect(leases.detached(PLUGIN)).toBe(false);
    // The revision is monotonic, so a release does not rewind it: that is what
    // lets a poll see that a presentation came and went between two reads.
    expect(leases.revision(PLUGIN)).toBe(1);
  });

  it("moves the revision on every acquisition, and keeps it after a release", () => {
    const leases = createMiniAppPresentationLeases();
    const first = leases.acquire({ pluginId: PLUGIN, sessionId: "session-1" });
    leases.release(first);
    const second = leases.acquire({ pluginId: PLUGIN, sessionId: "session-2" });

    expect([first.presentationRevision, second.presentationRevision]).toEqual([1, 2]);
    expect(leases.revision(PLUGIN)).toBe(2);
    expect(leases.detached(PLUGIN)).toBe(true);
  });

  it("replaces a live lease, and a replaced lease's release clears nothing", () => {
    const leases = createMiniAppPresentationLeases();
    const first = leases.acquire({ pluginId: PLUGIN, sessionId: "session-1" });
    const second = leases.acquire({ pluginId: PLUGIN, sessionId: "session-2" });

    // The older document closing must not make the newer one's presentation
    // disappear: this is a tab reload, or a switch racing a close.
    leases.release(first);
    expect(leases.detached(PLUGIN)).toBe(true);
    expect(leases.live()).toEqual([second]);

    leases.release(second);
    expect(leases.detached(PLUGIN)).toBe(false);
    // Releasing twice is a no-op rather than an error: the stream may finish by
    // both routes the dispatcher offers.
    leases.release(second);
    expect(leases.detached(PLUGIN)).toBe(false);
  });

  it("keeps one plugin's presentation to itself", () => {
    const leases = createMiniAppPresentationLeases();
    const other = "other.miniapp";
    const lease = leases.acquire({ pluginId: PLUGIN, sessionId: "session-1" });
    leases.acquire({ pluginId: other, sessionId: "session-2" });

    leases.release(lease);
    expect(leases.detached(PLUGIN)).toBe(false);
    expect(leases.detached(other)).toBe(true);
    expect(leases.revision(other)).toBe(1);
    expect(leases.revision(PLUGIN)).toBe(1);
  });
});
