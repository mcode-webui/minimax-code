// The shared value readers and formatters (U17 / U19).
//
// `contracts/value-readers.ts` is the leaf the whole projection layer reads through —
// `recordValue` alone is called from four modules — and it had no test file at
// all. Two of its behaviours were the ones that drifted when copies existed:
// "an all-blank string counts as absent", and the credit rounding the module
// comment records. Both are pinned here.
import { describe, expect, it } from "vitest";

import {
  booleanValue,
  formatWebuiCredits,
  formatWebuiError,
  numberAmongKeys,
  numberValue,
  recordValue,
  stringAmongKeys,
  stringValue,
} from "../../src/client/contracts/value-readers.js";

describe("the coercion readers", () => {
  it("takes an object as a record and rejects everything else", () => {
    expect(recordValue({ a: 1 })).toEqual({ a: 1 });
    // An array is an object, and treating it as a record would make
    // `record[i]` look like a field name.
    expect(recordValue([1, 2])).toBeUndefined();
    expect(recordValue(null)).toBeUndefined();
    expect(recordValue("x")).toBeUndefined();
  });

  it("treats an all-blank string as absent", () => {
    expect(stringValue("x")).toBe("x");
    expect(stringValue("   ")).toBeUndefined();
    expect(stringValue(1)).toBeUndefined();
  });

  it("takes a number and a boolean as themselves", () => {
    expect(numberValue(0)).toBe(0);
    expect(numberValue("0")).toBeUndefined();
    expect(booleanValue(false)).toBe(false);
    expect(booleanValue("false")).toBeUndefined();
  });
});

describe("the key-list readers", () => {
  it("takes the first key that holds a non-empty string", () => {
    expect(stringAmongKeys({ msg_id: "m1" }, ["msgId", "msg_id"])).toBe("m1");
    // The blank one does not win just by coming first.
    expect(stringAmongKeys({ a: "  ", b: "b" }, ["a", "b"])).toBe("b");
    expect(stringAmongKeys(undefined, ["a"])).toBeUndefined();
  });

  it("takes the first key that holds a finite number", () => {
    expect(numberAmongKeys({ b: 2 }, ["a", "b"])).toBe(2);
    expect(numberAmongKeys({ a: Number.NaN, b: 2 }, ["a", "b"])).toBe(2);
    expect(numberAmongKeys({ a: Number.POSITIVE_INFINITY }, ["a"])).toBeUndefined();
  });
});

describe("the formatters", () => {
  it("reads an error's message and stringifies anything else", () => {
    expect(formatWebuiError(new Error("boom"))).toBe("boom");
    expect(formatWebuiError("plain")).toBe("plain");
    expect(formatWebuiError(undefined)).toBe("undefined");
  });

  it("rounds a credit balance the way the desktop does", () => {
    // The formatter renders `7,726` for `7726.2119999999995`. That example does NOT
    // tell rounding from truncation — both give 7726 — so the discriminating
    // cases are below: `.6` rounds up where truncation would drop it. A second
    // copy in the settings panel truncated, which read one credit lower.
    expect(formatWebuiCredits("7726.2119999999995")).toBe("7,726");
    expect(formatWebuiCredits("1.6")).toBe("2");
    expect(formatWebuiCredits("-1.6")).toBe("-2");
    expect(formatWebuiCredits("1526")).toBe("1,526");
    expect(formatWebuiCredits("1,526")).toBe("1,526");
  });

  it("keeps an unreadable balance rather than inventing a number", () => {
    expect(formatWebuiCredits(undefined)).toBe("—");
    expect(formatWebuiCredits("")).toBe("");
    expect(formatWebuiCredits("n/a")).toBe("n/a");
  });
});
