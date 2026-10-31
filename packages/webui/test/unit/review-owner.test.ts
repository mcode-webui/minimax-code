// The review/diff machine has one owner and two readers.
//
// Two surfaces render a diff — the transcript's card on an assistant message and
// the review page over a whole change set — and the machine, the failure copy and
// the mutation decisions used to be filed in the first of them. They live in
// `features/review/projection/review-state.ts` now, and this file asserts both
// halves: one machine, two readers, and no private copy in either.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

import {
  buildWebuiDiffMutationRequest,
  confirmWebuiDiffMutation,
  describeWebuiDiffFailure,
  initialWebuiDiffState,
  reduceWebuiDiffState,
  resolveWebuiDiffMutation,
} from "../../src/client/features/review/projection/review-state.js";

const CLIENT = new URL("../../src/client/", import.meta.url);
const read = (relative: string): string => readFileSync(new URL(relative, CLIENT), "utf8");
const flat = (text: string): string => text.replace(/\s+/gu, " ");

/** Every `.ts`/`.tsx` module under a directory, recursively. */
function modulesUnder(prefix: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(new URL(dir, CLIENT), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else if (/\.tsx?$/u.test(entry.name)) found.push(path);
    }
  };
  walk(prefix);
  return found;
}

describe("the diff machine has one owner", () => {
  it("is declared in the review module and nowhere else", () => {
    // Both homes are scanned: the transcript's projections moved to
    // `features/transcript/projection/`, and a scan of the old home alone would
    // find nothing and pass for the wrong reason.
    const declarers = [
      ...modulesUnder("shell/"),
      ...modulesUnder("ui/"),
      ...modulesUnder("projection/"),
      ...modulesUnder("features/"),
    ].filter(
      (file) => /export function reduceWebuiDiffState\(/u.test(read(file)),
    );
    expect(declarers).toEqual(["features/review/projection/review-state.ts"]);
  });

  it("leaves the transcript's card with no machine of its own", () => {
    const card = flat(read("features/transcript/ui/DiffCard.tsx"));
    // It CALLS the machine (every state update goes through it) and does not
    // declare one: no reducer, no initial-state literal, no switch, no copy table.
    expect(card).not.toContain("export function reduceWebuiDiffState(");
    expect(card).not.toContain("export const initialWebuiDiffState");
    expect(card).not.toContain("switch (action.type)");
    expect(card).not.toContain("WEBUI_DIFF_FAILURE_COPY");
    // It does not read the machine either: the query, the mutation and the
    // machine's decisions are the review owner's, and the card reads the
    // owner's answer through its binding. Reading the projection directly is what
    // the dependency gate refuses, so this assertion and that rule agree.
    expect(card).not.toContain("review-state.js");
    expect(card).toContain("useWebuiTurnReview(");
  });

  it("keeps the failure copy in exactly one module", () => {
    const holders = [
      ...modulesUnder("shell/"),
      ...modulesUnder("ui/"),
      ...modulesUnder("projection/"),
      ...modulesUnder("features/"),
    ].filter(
      (file) => read(file).includes("unsafe_path:"),
    );
    expect(holders).toEqual(["features/review/projection/review-state.ts"]);
  });
});

describe("the two readers share it", () => {
  it("is read by the turn-review owner and by the review page, and by nothing else", () => {
    // Scanned rather than listed: a hardcoded path would go stale on a
    // relocation while the pair ("one owner, two readers") still held. Scanning
    // the tree makes a third reader fail here and a relocation a no-op.
    // The transcript's card now lives in the feature home and reads the owner by a
    // sibling path, so the scan covers both homes and matches the imported module
    // rather than a path fragment: what is asserted is "one owner, two readers",
    // not where either of them sits.
    // The machine has one home and two readers: the owner, which answers for a
    // turn, and the review page, which renders the working tree. The surfaces do
    // not read it — the transcript's card reads the owner — so this list is the
    // pair the "one owner" promise is about, and a third reader fails here.
    const readers = [...modulesUnder("shell/"), ...modulesUnder("ui/"), ...modulesUnder("features/")]
      .filter((file) => /from "[^"]*\breview-state\.js"/u.test(read(file)))
      .sort();
    expect(readers).toEqual([
      "features/review/application/turn-review-owner.ts",
      "features/review/ui/ReviewSettingsPage.public.tsx",
    ]);
  });

  it("still decides the same things the card used to decide itself", () => {
    // The move is move-only: these are the decisions the component used to own,
    // asserted against the owner so a relocation that changes one fails here.
    const loaded = reduceWebuiDiffState(initialWebuiDiffState, {
      type: "loaded",
      view: { changeSetId: "c1", status: "active", canUndo: true, canReapply: false, fileChanges: [] },
    } as never);
    expect(buildWebuiDiffMutationRequest(loaded, { id: "s" } as never, "revert")).toEqual({
      id: "s",
      changeSetId: "c1",
    });
    // A failure is not an absent capability, and the copy is the table's.
    const failed = reduceWebuiDiffState(loaded, { type: "mutation-failed", error: "conflict" });
    expect(failed.unsupported).toBe(false);
    expect(describeWebuiDiffFailure("conflict")).toContain("文件又被修改过");
    expect(confirmWebuiDiffMutation(failed, true).busy).toBe(true);
    expect(confirmWebuiDiffMutation(failed, false)).toBe(failed);
    expect(resolveWebuiDiffMutation("reapply", undefined, new Error("boom")).type).toBe(
      "mutation-failed",
    );
  });
});
