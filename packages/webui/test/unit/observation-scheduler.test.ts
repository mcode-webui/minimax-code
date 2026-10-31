// The observation scheduler's invariants.
//
// These are the properties the plan states as acceptance rather than as
// implementation notes, so each case names the row it comes from:
//
//   * V28 — a search-text-only change issues **zero** probes. Not "no redundant
//     batch": the identity set is what the rail registers, so a new page object
//     with the same sessions is not new work at all.
//   * V31 — one scheduler owns the reads; the inspection class has its own budget
//     and cannot be starved by a saturated activity queue; hidden means stopped;
//     returning, or a known invalidation, refreshes once.
//   * V34 — the two classes are separate budgets, so B's refresh cannot consume
//     A's capacity, and login/OAuth (outside both) is not modelled here at all.
//
// Time is injected, so "after the freshness budget" is a fact a test can state
// rather than something it waits for.

import { describe, expect, it } from "vitest";

import { createWebuiObservationScheduler } from "../../src/client/application/observation-scheduler.js";

function harness(startAt = 0) {
  let clock = startAt;
  const timers: { at: number; run: () => void }[] = [];
  const scheduler = createWebuiObservationScheduler({
    now: () => clock,
    // Deterministic timers: the test decides when the freshness tick fires.
    setTimer: (run, delayMs) => {
      const entry = { at: clock + delayMs, run };
      timers.push(entry);
      return () => {
        const index = timers.indexOf(entry);
        if (index >= 0) timers.splice(index, 1);
      };
    },
  });
  const advance = (ms: number): void => {
    clock += ms;
    for (const entry of [...timers]) {
      if (entry.at > clock) continue;
      timers.splice(timers.indexOf(entry), 1);
      entry.run();
    }
  };
  return { scheduler, advance, now: () => clock };
}

/** Let every queued microtask and timer callback settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
};

describe("V28 · identity, not object identity, decides what a probe costs", () => {
  it("issues nothing when the same identities are registered again", async () => {
    const { scheduler } = harness();
    let runs = 0;
    const interest = () => [
      { identity: "turn:a", run: async () => { runs += 1; } },
      { identity: "turn:b", run: async () => { runs += 1; } },
    ];

    scheduler.setActivityInterest(interest());
    // Registered again — as a search keystroke does, with the same sessions:
    // new request closures, identical identities.
    scheduler.setActivityInterest(interest());
    scheduler.setActivityInterest(interest());
    await flush();

    expect(runs).toBe(2);
    expect(scheduler.stats().activityIssued).toBe(2);
  });

  it("issues one probe for an identity that becomes interesting", async () => {
    const { scheduler } = harness();
    const seen: string[] = [];
    scheduler.setActivityInterest([{ identity: "turn:a", run: async () => { seen.push("a"); } }]);
    await Promise.resolve();
    scheduler.setActivityInterest([
      { identity: "turn:a", run: async () => { seen.push("a"); } },
      { identity: "turn:b", run: async () => { seen.push("b"); } },
    ]);
    await flush();

    expect(seen).toEqual(["a", "b"]);
  });

  it("drops queued work for an identity that stopped being interesting", async () => {
    const { scheduler } = harness();
    let runs = 0;
    // The activity budget is 1 here, so the second identity waits in the queue.
    const bounded = createWebuiObservationScheduler({ activityBudget: 1 });
    const gate = deferred();
    bounded.setActivityInterest([
      { identity: "turn:a", run: async () => { runs += 1; await gate.promise; } },
      { identity: "turn:b", run: async () => { runs += 1; } },
    ]);
    // B leaves the rail before A finishes: its queued probe is dropped, not run.
    bounded.setActivityInterest([
      { identity: "turn:a", run: async () => { runs += 1; await gate.promise; } },
    ]);
    gate.resolve();
    await flush();

    expect(runs).toBe(1);
    expect(scheduler.stats().activityIssued).toBe(0);
  });
});

describe("V31 · one scheduler, independent budgets, suspended when hidden", () => {
  it("repairs activity reconnects without duplicating inspection after foreground restoration", async () => {
    const { scheduler, advance } = harness();
    let inspection = 0;
    let activity = 0;
    scheduler.setInspectionInterest([{ identity: "inspection:A", run: async () => { inspection += 1; } }]);
    scheduler.setActivityInterest([{ identity: "turn:A", run: async () => { activity += 1; } }]);
    await flush();
    scheduler.setSuspended(true); advance(10000);
    scheduler.setSuspended(false); await flush();
    scheduler.invalidateActivity(); await flush();
    expect(inspection).toBe(2);
    expect(activity).toBe(3);
    scheduler.dispose();
  });
  it("keeps activity in flight at its own budget", async () => {
    const gated = createWebuiObservationScheduler({ activityBudget: 2 });
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;
    gated.setActivityInterest(
      gates.map((gate, index) => ({
        identity: `turn:${index}`,
        run: async () => {
          started += 1;
          await gate.promise;
        },
      })),
    );
    await flush();

    // Two in flight, the third still queued: the budget is what makes a slow rail
    // read a bounded amount of work rather than one probe per session at once.
    expect(started).toBe(2);
    expect(gated.stats().activityInFlight).toBe(2);
    expect(gated.stats().activityQueued).toBe(1);

    gates[0]!.resolve();
    await flush();
    expect(started).toBe(3);
    expect(gated.stats().activityInFlight).toBe(2);
  });

  it("gives inspection its own capacity, so a saturated rail cannot starve it", async () => {
    const scheduler = createWebuiObservationScheduler({ activityBudget: 8, inspectionBudget: 2 });
    const gates = Array.from({ length: 8 }, () => deferred());
    const order: string[] = [];
    scheduler.setActivityInterest(
      gates.map((gate, index) => ({
        identity: `turn:${index}`,
        run: async () => {
          order.push(`activity:${index}`);
          await gate.promise;
        },
      })),
    );
    scheduler.setInspectionInterest([
      { identity: "inspection:selected", run: async () => { order.push("inspection"); } },
    ]);
    await flush();

    // The inspection read ran even though every activity slot is occupied, and it
    // ran in its own class rather than at the end of the rail's backlog.
    expect(order).toContain("inspection");
    expect(scheduler.stats().activityInFlight).toBe(8);
    expect(scheduler.stats().inspectionIssued).toBe(1);
  });

  it("re-reads an inspection identity only after its freshness budget", async () => {
    const { scheduler, advance } = harness();
    let reads = 0;
    const interest = () => [
      { identity: "inspection:s1", run: async () => { reads += 1; } },
    ];
    scheduler.setInspectionInterest(interest());
    await Promise.resolve();
    expect(reads).toBe(1);

    // Re-registering the same identity is not a reason to read again.
    scheduler.setInspectionInterest(interest());
    await flush();
    expect(reads).toBe(1);

    advance(2_000);
    await flush();
    expect(reads).toBe(2);
  });

  it("stops when suspended and re-establishes freshness on return", async () => {
    const { scheduler, advance } = harness();
    let reads = 0;
    scheduler.setInspectionInterest([{ identity: "inspection:s1", run: async () => { reads += 1; } }]);
    await flush();
    expect(reads).toBe(1);

    scheduler.setSuspended(true);
    advance(10_000);
    await flush();
    // Hidden page: the freshness tick is not scheduled at all.
    expect(reads).toBe(1);

    scheduler.setSuspended(false);
    await flush();
    expect(reads).toBe(2);
  });

  it("refreshes once on a known invalidation", async () => {
    const { scheduler } = harness();
    let reads = 0;
    scheduler.setActivityInterest([{ identity: "turn:a", run: async () => { reads += 1; } }]);
    await flush();
    scheduler.invalidate("turn:a");
    await flush();
    expect(reads).toBe(2);
    expect(scheduler.stats().activityIssued).toBe(2);
  });

  it("does not spin when the clock is a wall clock", async () => {
    // The failure this covers: a freshness deadline computed from `0` is in the past
    // on a real clock, so the tick armed immediately and re-armed itself — a busy loop
    // that also re-read the resource while its own read was still running. A test whose
    // clock starts at 0 cannot produce that shape.
    const { scheduler, advance } = harness(Date.now());
    const gate = deferred();
    let reads = 0;
    scheduler.setInspectionInterest([
      {
        identity: "inspection:s1",
        run: async () => {
          reads += 1;
          await gate.promise;
        },
      },
    ]);
    await flush();

    // One read, issued once, and nothing armed to fire immediately behind it.
    expect(reads).toBe(1);
    expect(scheduler.stats().inspectionIssued).toBe(1);

    // The budget elapses while that read is still running: the identity becomes stale,
    // which queues one follow-up — not a second concurrent read of the same resource.
    advance(5_000);
    await flush();
    expect(reads).toBe(1);
    expect(scheduler.stats().inspectionIssued).toBe(1);

    gate.resolve();
    await flush();
    // The follow-up ran exactly once, and the identity is fresh again.
    expect(reads).toBe(2);
    expect(scheduler.stats().inspectionInFlight).toBe(0);
    expect(scheduler.stats().inspectionQueued).toBe(0);

    advance(1_000);
    await flush();
    expect(reads).toBe(2);

    advance(1_500);
    await flush();
    expect(reads).toBe(3);
  });

  it("tells a runner that its result is no longer wanted", async () => {
    const { scheduler } = harness();
    let currentWhenRun: boolean | undefined;
    scheduler.setActivityInterest([
      {
        identity: "turn:a",
        run: async (signal) => {
          currentWhenRun = signal.isCurrent();
        },
      },
    ]);
    await flush();
    expect(currentWhenRun).toBe(true);
  });
});
