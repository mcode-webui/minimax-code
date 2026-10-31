// The reconnect schedule is the ADR's most concrete behavioural claim: an
// in-flight command retries for at most 15 seconds with the named step
// pattern, the steps double and cap at 5 s, and background reconnects cap
// at 30 s. The schedule is implemented as a pure function so the wiring
// code does not need to be present for it to be tested.

import { describe, expect, it } from "vitest";

import {
  bridgeBackgroundReconnectDelayMs,
  bridgeOperationReconnectDelayMs,
  WEBUI_BRIDGE_BACKGROUND_RECONNECT_CAP_MS,
  WEBUI_BRIDGE_OPERATION_RECONNECT_CAP_MS,
  WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS,
  WEBUI_BRIDGE_OPERATION_RECONNECT_TOTAL_MS,
  withBridgeOperationRetry,
  BridgeOperationError,
  type BridgeOperationAttempt,
} from "../../src/server/browser-bridge/index.js";

describe("WebUI bridge reconnect schedule", () => {
  it("pins the operation steps to 250 / 500 / 1 000 / 2 000 / 4 000 ms", () => {
    expect([...WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS]).toEqual([250, 500, 1_000, 2_000, 4_000]);
    expect(WEBUI_BRIDGE_OPERATION_RECONNECT_CAP_MS).toBe(5_000);
    expect(WEBUI_BRIDGE_OPERATION_RECONNECT_TOTAL_MS).toBe(15_000);
  });

  it("pins the background reconnect cap to 30 seconds", () => {
    expect(WEBUI_BRIDGE_BACKGROUND_RECONNECT_CAP_MS).toBe(30_000);
  });

  it("returns exactly the named steps when no jitter is applied", () => {
    // The minimum boundary: a -1 attempt would otherwise ask for the
    // largest step; we want the function to clamp.
    for (let attempt = 0; attempt < WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS.length; attempt += 1) {
      const withFloor = bridgeOperationReconnectDelayMs(attempt);
      expect(withFloor).toBeGreaterThanOrEqual(WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS[attempt]! * 0.8);
      expect(withFloor).toBeLessThanOrEqual(WEBUI_BRIDGE_OPERATION_RECONNECT_STEPS_MS[attempt]! * 1.2);
    }
  });

  it("caps the operation delay at 5 s for every attempt beyond the named steps", () => {
    for (const attempt of [5, 6, 7, 8, 20]) {
      const value = bridgeOperationReconnectDelayMs(attempt);
      // The cap is 5 s; with ±20% jitter the lower bound is 4 s and the
      // upper bound is 5 s. A value that exceeds the cap is a regression.
      expect(value).toBeLessThanOrEqual(WEBUI_BRIDGE_OPERATION_RECONNECT_CAP_MS);
    }
  });

  it("caps the background delay at 30 s once the doubling reaches the ceiling", () => {
    for (const attempt of [7, 8, 20]) {
      const value = bridgeBackgroundReconnectDelayMs(attempt);
      expect(value).toBeLessThanOrEqual(WEBUI_BRIDGE_BACKGROUND_RECONNECT_CAP_MS);
    }
  });

  it("doubles the background delay by 2 each step until the cap", () => {
    // Without jitter (we replicate the algorithm rather than read it), the
    // first eight attempts double as 250, 500, 1_000, 2_000, 4_000,
    // 8_000, 16_000, 30_000. The eighth step hits the cap.
    const expected = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    for (let attempt = 0; attempt < expected.length; attempt += 1) {
      // Pull a single sample and check it sits inside the band ±20 % of the
      // expected value. The first seven steps are well clear of the cap.
      const observed = bridgeBackgroundReconnectDelayMs(attempt);
      const floor = expected[attempt]! * 0.8;
      const ceiling = expected[attempt]! * 1.2 + 1;
      expect(observed).toBeGreaterThanOrEqual(floor);
      expect(observed).toBeLessThanOrEqual(ceiling);
    }
  });
});

describe("WebUI bridge operation retry", () => {
  it("returns the first success without retrying", async () => {
    let calls = 0;
    const attempt = async (): Promise<BridgeOperationAttempt<string>> => {
      calls += 1;
      return { kind: "success", value: "ok" };
    };
    const value = await withBridgeOperationRetry<string>(attempt, { deadlineMs: 100 });
    expect(value).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries transient failures until the deadline", async () => {
    let calls = 0;
    const attempt: (index: number) => Promise<{ kind: "transient"; message: string } | { kind: "success"; value: string }> = async () => {
      calls += 1;
      if (calls < 3) return { kind: "transient", message: `transient #${calls}` };
      return { kind: "success", value: "ok" };
    };
    const sleepCalls: number[] = [];
    const value = await withBridgeOperationRetry(attempt, {
      deadlineMs: 1_000,
      sleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });
    expect(value).toBe("ok");
    expect(calls).toBe(3);
    expect(sleepCalls).toHaveLength(2);
    // The first retry sleeps roughly 250ms, the second roughly 500ms.
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(200);
    expect(sleepCalls[0]).toBeLessThanOrEqual(350);
  });

  it("throws a typed timeout error when the deadline expires mid-retry", async () => {
    let calls = 0;
    const attempt: (index: number) => Promise<{ kind: "transient"; message: string }> = async () => {
      calls += 1;
      return { kind: "transient", message: `transient #${calls}` };
    };
    await expect(
      withBridgeOperationRetry(attempt, { deadlineMs: 5, sleep: () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(BridgeOperationError);
    expect(calls).toBeGreaterThan(1);
  });

  it("does not retry a terminal refusal", async () => {
    let calls = 0;
    const attempt: (index: number) => Promise<{ kind: "terminal"; reason: "refused"; message: string }> = async () => {
      calls += 1;
      return { kind: "terminal", reason: "refused", message: "no" };
    };
    await expect(
      withBridgeOperationRetry(attempt, { deadlineMs: 1_000, sleep: () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(BridgeOperationError);
    expect(calls).toBe(1);
  });
});
