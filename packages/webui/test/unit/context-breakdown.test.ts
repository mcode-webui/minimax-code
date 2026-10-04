// The context-window panel's breakdown rows (roadmap H, 模型与用量).
//
// The rule under test is the one that is easiest to get wrong and hardest to
// notice: a category the engine did not report must print a dash, never
// `0.0%`. Drawing zero asserts that the engine looked at that category and
// found it empty, which is a claim this process does not get to make on the
// engine's behalf. So the suite drives the PRODUCT functions in
// `projection/context-breakdown.ts`, and every assertion below is about a state
// the previous inline implementation got wrong.
import { describe, expect, it } from "vitest";

import {
  breakdownShareLabel,
  breakdownSwatchStyle,
  CONTEXT_BREAKDOWN_CATEGORIES,
  contextBreakdownRows,
  drawableBreakdownRows,
  formatPercent,
  UNREPORTED_SHADE,
} from "../../src/client/projection/context-breakdown.js";

const ALL_KINDS = CONTEXT_BREAKDOWN_CATEGORIES.map((category) => category.kind);

function components(...entries: readonly (readonly [string, number])[]) {
  return entries.map(([kind, tokens]) => ({ kind, tokens }));
}

describe("context breakdown — the six rows always exist", () => {
  it("lists all six categories in the reference's order", () => {
    const rows = contextBreakdownRows([], 1000);
    expect(rows.map((row) => row.kind)).toEqual(ALL_KINDS);
  });

  it("reports EVERY category as unreported when the engine sent nothing", () => {
    // The headline case. A panel that renders zero rows here is indistinguishable
    // from a panel that has nothing to say; a panel that renders six zeros is
    // making a claim it cannot support.
    const rows = contextBreakdownRows(null, 1000);
    expect(rows.every((row) => row.tokens === null)).toBe(true);
    expect(rows.every((row) => row.percent === null)).toBe(true);
    expect(rows.map(breakdownShareLabel)).toEqual([
      "—",
      "—",
      "—",
      "—",
      "—",
      "—",
    ]);
  });

  it("marks a partially reported breakdown per row, not wholesale", () => {
    const rows = contextBreakdownRows(components(["MESSAGES", 700]), 1000);
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    expect(byKind.get("MESSAGES")?.percent).toBeCloseTo(70);
    expect(byKind.get("TOOLS")?.percent).toBeNull();
  });
});

describe("context breakdown — zero and unreported stay different", () => {
  it("keeps a reported zero at 0, not null", () => {
    // The engine said "this category holds no tokens". That is a fact.
    const rows = contextBreakdownRows(components(["TOOLS", 0]), 1000);
    const tools = rows.find((row) => row.kind === "TOOLS");
    expect(tools?.tokens).toBe(0);
    expect(tools?.percent).toBe(0);
    expect(breakdownShareLabel(tools!)).toBe("0%");
  });

  it("keeps a missing category at null, not 0", () => {
    const rows = contextBreakdownRows(components(["TOOLS", 500]), 1000);
    const memory = rows.find((row) => row.kind === "MEMORY");
    expect(memory?.tokens).toBeNull();
    expect(memory?.percent).toBeNull();
    expect(breakdownShareLabel(memory!)).toBe("—");
  });

  it("dims an unreported row's swatch so the two states read apart", () => {
    const rows = contextBreakdownRows(components(["TOOLS", 500]), 1000);
    const tools = rows.find((row) => row.kind === "TOOLS")!;
    const memory = rows.find((row) => row.kind === "MEMORY")!;
    expect(breakdownSwatchStyle(tools).opacity).toBe(tools.shade);
    expect(breakdownSwatchStyle(memory).opacity).toBe(UNREPORTED_SHADE);
  });
});

describe("context breakdown — the order is fixed, not sorted by size", () => {
  it("does not re-order rows as the conversation fills up", () => {
    // The previous implementation sorted descending by tokens, so the list
    // re-ordered itself under the reader. The order is the reference's and
    // does not move.
    const early = contextBreakdownRows(components(["TOOLS", 10]), 100);
    const late = contextBreakdownRows(
      components(["MESSAGES", 9000], ["TOOLS", 10]),
      9010,
    );
    expect(early.map((row) => row.kind)).toEqual(late.map((row) => row.kind));
  });

  it("gives a category the same colour whatever its neighbours do", () => {
    // The old palette was indexed by sort position, so a category changed
    // colour as other categories grew past it.
    const before = contextBreakdownRows(components(["MEMORY", 10]), 100);
    const after = contextBreakdownRows(
      components(["MESSAGES", 9000], ["MEMORY", 10]),
      9010,
    );
    const pick = (rows: ReturnType<typeof contextBreakdownRows>) =>
      rows.find((row) => row.kind === "MEMORY")!;
    expect(breakdownSwatchStyle(pick(before))).toEqual(
      breakdownSwatchStyle(pick(after)),
    );
  });
});

describe("context breakdown — the bar only draws what it can measure", () => {
  it("excludes unreported rows from the bar's segments", () => {
    // A width is a measurement; a row with no tokens has none to contribute.
    const rows = contextBreakdownRows(components(["MESSAGES", 300]), 1000);
    expect(drawableBreakdownRows(rows).map((row) => row.kind)).toEqual([
      "MESSAGES",
    ]);
  });

  it("draws nothing when the engine reported nothing", () => {
    expect(drawableBreakdownRows(contextBreakdownRows(null, 1000))).toEqual([]);
  });
});

describe("context breakdown — reading a hostile payload", () => {
  it("ignores a repeated kind's extra entries by summing them", () => {
    // The wire is an array, so two entries of one kind are a legitimate split.
    // Taking the last would silently drop tokens off the total.
    const rows = contextBreakdownRows(components(["TOOLS", 100], ["TOOLS", 50]), 300);
    expect(rows.find((row) => row.kind === "TOOLS")?.tokens).toBe(150);
  });

  it("drops a non-finite or negative count rather than drawing it", () => {
    const rows = contextBreakdownRows(
      [
        { kind: "TOOLS", tokens: Number.NaN },
        { kind: "SKILLS", tokens: Number.POSITIVE_INFINITY },
        { kind: "MEMORY", tokens: -50 },
      ],
      300,
    );
    expect(rows.find((row) => row.kind === "TOOLS")?.tokens).toBeNull();
    expect(rows.find((row) => row.kind === "SKILLS")?.tokens).toBeNull();
    // A negative count is clamped to zero rather than discarded: the engine
    // DID report the category, and it reported it as holding nothing.
    expect(rows.find((row) => row.kind === "MEMORY")?.tokens).toBe(0);
  });

  it("leaves every share null when the total is zero", () => {
    // Every share would be a division by zero, so the row reports a count it
    // has and declines to report a proportion.
    const rows = contextBreakdownRows(components(["MESSAGES", 0]), 0);
    expect(rows.find((row) => row.kind === "MESSAGES")?.tokens).toBe(0);
    expect(rows.find((row) => row.kind === "MESSAGES")?.percent).toBeNull();
  });

  it("does not draw a kind the panel has no row for", () => {
    // Folding it into OTHER would put a figure on that row that no longer adds
    // up to the numbers printed above it.
    const rows = contextBreakdownRows(components(["MESSAGES", 100], ["TELEPATHY", 900]), 1000);
    expect(rows.map((row) => row.kind)).toEqual(ALL_KINDS);
    expect(rows.reduce((total, row) => total + (row.tokens ?? 0), 0)).toBe(100);
  });

  it("survives a payload that is not an array of objects at all", () => {
    expect(contextBreakdownRows("nope", 1000).map((row) => row.tokens)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(contextBreakdownRows([null, 7, [], "x"], 1000)[0]?.tokens).toBeNull();
  });
});

describe("context breakdown — percent formatting bands", () => {
  it("prints 0% for no usage and never for a used-but-tiny window", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(-1)).toBe("0%");
    // A session that has started but is under a tenth of a percent must not
    // read as "nothing has happened yet".
    expect(formatPercent(0.4)).toBe("<1%");
  });

  it("keeps one decimal below ten and drops it above", () => {
    expect(formatPercent(3.4567)).toBe("3.5%");
    expect(formatPercent(9.99)).toBe("10.0%");
    expect(formatPercent(47.2)).toBe("47%");
  });

  it("rounds at the band boundary rather than falling through", () => {
    expect(formatPercent(1)).toBe("1.0%");
    expect(formatPercent(10)).toBe("10%");
  });
});
