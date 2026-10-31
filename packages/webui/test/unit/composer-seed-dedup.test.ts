// Seed deduplication in the composer. The decision used to be
// an effect body: an early return, a store write, a limit check and an
// attachment literal, in that order, with the invariant that matters — the token
// is consumed before anything can bail — stated only in a comment. It is a read
// now, and the order is visible at the call site.

import { describe, expect, it } from "vitest";

import { readWebuiSeedApplication } from "../../src/client/features/composer/projection/seed-application.js";

const seed = {
  token: "t1",
  fileName: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 10,
  content: "hello",
} as const;

describe("seed application", () => {
  it("does nothing without a seed", () => {
    expect(
      readWebuiSeedApplication({ seed: undefined, consumedToken: undefined, attachments: [] }),
    ).toEqual({ kind: "none" });
  });

  it("stages a seed that fits, keyed by its token", () => {
    const decision = readWebuiSeedApplication({ seed, consumedToken: undefined, attachments: [] });
    expect(decision.kind).toBe("staged");
    if (decision.kind !== "staged") throw new Error("expected staged");
    expect(decision.token).toBe("t1");
    expect(decision.attachment.id).toBe("seed-t1");
    expect(decision.attachment.fileName).toBe("notes.txt");
    expect(decision.attachment.kind).toBe("file");
    expect(decision.attachment.dataUrl.startsWith("data:text/plain")).toBe(true);
  });

  it("skips a token the staging already decided", () => {
    expect(
      readWebuiSeedApplication({ seed, consumedToken: "t1", attachments: [] }),
    ).toEqual({ kind: "none" });
  });

  it("still stages a *different* token", () => {
    const decision = readWebuiSeedApplication({ seed, consumedToken: "t0", attachments: [] });
    expect(decision.kind).toBe("staged");
  });

  it("refuses a seed that breaks the count limit, carrying the token to consume", () => {
    const many = Array.from({ length: 20 }, () => ({ sizeBytes: 1 }));
    const decision = readWebuiSeedApplication({ seed, consumedToken: undefined, attachments: many });
    expect(decision.kind).toBe("refused");
    if (decision.kind !== "refused") throw new Error("expected refused");
    expect(decision.token).toBe("t1");
    expect(decision.error.length).toBeGreaterThan(0);
  });

  it("keeps a refused seed refused: the consumed token ends the story", () => {
    const many = Array.from({ length: 20 }, () => ({ sizeBytes: 1 }));
    const first = readWebuiSeedApplication({ seed, consumedToken: undefined, attachments: many });
    if (first.kind !== "refused") throw new Error("expected refused");
    // The caller records `first.token`; the next pass is a no-op even though the
    // limit still holds.
    const second = readWebuiSeedApplication({ seed, consumedToken: first.token, attachments: many });
    expect(second).toEqual({ kind: "none" });
  });
});
