// The session scope manager.
//
// The rules under test are the ones that decide whether navigating away can
// abandon work: selection releases only the selected-view lease, an accepted
// delivery or an outstanding settlement keeps its session interested, a
// secondary consumer releases its own lease, and nothing may be evicted while an
// eligible completion is still owed.

import { describe, expect, it } from "vitest";

import { createWebuiSessionScopeManager } from "../../src/client/conversation/session-scope.js";
import { createWebuiApplication } from "../../src/client/application/create-application.js";
import type { WebuiClientSessionResumer } from "../../src/client/features/turn/contracts/execution-port.js";

describe("session scope — selection is one lease among several", () => {
  it("V16 measures released interests separately from replay-unsafe deletion fences", () => {
    const scope = createWebuiSessionScopeManager();
    for (let i = 0; i < 100; i += 1) {
      const release = scope.acquire(`session-${i}`, "secondary", `tab-${i}`);
      release();
    }
    expect(scope.retention()).toEqual({ sessions: 0, leases: 0, deletionFences: 0 });
    for (let i = 0; i < 100; i += 1) {
      scope.purge(`session-${i}`);
      scope.acquire(`session-${i}`, "delivery", "late-attempt");
    }
    expect(scope.retention()).toEqual({ sessions: 0, leases: 0, deletionFences: 100 });
    scope.dispose();
    expect(scope.retention()).toEqual({ sessions: 0, leases: 0, deletionFences: 0 });
  });
  it("activates the selected session's scope", () => {
    const scope = createWebuiSessionScopeManager();
    scope.select("A");
    expect(scope.selected()).toBe("A");
    expect(scope.isInterested("A")).toBe(true);
    expect(scope.kinds("A")).toEqual(["selected-view"]);
  });

  it("releases only the selected-view lease when the selection moves", () => {
    const scope = createWebuiSessionScopeManager();
    scope.select("A");
    // The two leases a navigation must not touch: an accepted attempt and an
    // outstanding settlement.
    scope.acquire("A", "delivery", "attempt-1");
    scope.acquire("A", "settlement", "mutation-1");

    scope.select("B");

    expect(scope.selected()).toBe("B");
    expect([...scope.kinds("A")].sort()).toEqual(["delivery", "settlement"]);
    expect(scope.isInterested("A")).toBe(true);
    expect(scope.kinds("B")).toEqual(["selected-view"]);
  });

  it("releases a secondary consumer's own lease on explicit close", () => {
    const scope = createWebuiSessionScopeManager();
    scope.select("A");
    const close = scope.acquire("A", "secondary", "workspace-tab-1");
    scope.acquire("A", "delivery", "attempt-1");

    close();

    expect(scope.kinds("A")).toEqual(["selected-view", "delivery"]);
    expect(scope.isInterested("A")).toBe(true);
  });

  it("is idempotent for one holder and kind, and each release is scoped to its own lease", () => {
    const scope = createWebuiSessionScopeManager();
    const first = scope.acquire("A", "delivery", "attempt-1");
    const second = scope.acquire("A", "delivery", "attempt-1");
    expect(scope.kinds("A")).toEqual(["delivery"]);

    first();
    // The second acquisition is the same lease, so the first release took it.
    expect(scope.isInterested("A")).toBe(false);

    second();
    expect(scope.isInterested("A")).toBe(false);
  });

  it("refuses to let an owner be recreated while an eligible completion is owed", () => {
    const scope = createWebuiSessionScopeManager();
    scope.select("A");
    scope.acquire("A", "delivery", "attempt-1");
    expect(scope.mayEvict("A")).toBe(false);

    // Navigating away does not make it evictable: the attempt is still owed.
    scope.select("B");
    expect(scope.mayEvict("A")).toBe(false);

    scope.releaseHolder("attempt-1");
    expect(scope.mayEvict("A")).toBe(true);
  });

  it("revokes one session's leases on purge, and the selection with it", () => {
    const scope = createWebuiSessionScopeManager();
    scope.select("A");
    scope.acquire("A", "delivery", "attempt-1");
    scope.acquire("B", "delivery", "attempt-2");

    scope.purge("A");

    expect(scope.isInterested("A")).toBe(false);
    expect(scope.selected()).toBeUndefined();
    // Another session's interest is untouched.
    expect(scope.isInterested("B")).toBe(true);
  });

  it("revokes every browser lease on disposal and accepts nothing afterwards", () => {
    const scope = createWebuiSessionScopeManager();
    scope.select("A");
    scope.acquire("B", "settlement", "mutation-1");

    scope.dispose();

    expect(scope.isDisposed()).toBe(true);
    expect(scope.interested()).toEqual([]);
    expect(scope.isInterested("A")).toBe(false);
    expect(scope.isInterested("B")).toBe(false);
    scope.select("C");
    scope.acquire("C", "delivery", "attempt-3");
    expect(scope.isInterested("C")).toBe(false);
    expect(scope.selected()).toBeUndefined();
  });

  it("keeps interest order stable for the sessions that are interesting", () => {
    const scope = createWebuiSessionScopeManager();
    scope.select("A");
    scope.acquire("B", "delivery", "attempt-1");
    scope.acquire("C", "settlement", "mutation-1");
    expect(scope.interested()).toEqual(["A", "B", "C"]);
    scope.releaseHolder("attempt-1");
    expect(scope.interested()).toEqual(["A", "C"]);
  });
});

describe("the application's selection command drives the scope", () => {
  it("moves the selected-view lease while an accepted attempt keeps its session", () => {
    const application = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: (async () => undefined) as unknown as WebuiClientSessionResumer },
    });

    application.start({ initialSessionId: "A" });
    application.sessionScope.acquire("A", "delivery", "attempt-1");
    application.select("B");

    expect(application.sessionScope.selected()).toBe("B");
    // The attempt on A is still owed, so A stays interesting after the view left.
    expect(application.sessionScope.isInterested("A")).toBe(true);
    expect(application.sessionScope.mayEvict("A")).toBe(false);
    expect(application.store.getSelectedSessionId()).toBe("B");

    application.dispose();
    expect(application.sessionScope.isInterested("A")).toBe(false);
    expect(application.sessionScope.isInterested("B")).toBe(false);
  });
});
