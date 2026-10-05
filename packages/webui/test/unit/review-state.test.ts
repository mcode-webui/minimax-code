import { describe, expect, it } from "vitest";

import {
  initialWebuiReviewState,
  isWebuiReviewFiltering,
  projectWebuiReviewLines,
  reduceWebuiReviewState,
  selectWebuiReviewVisibleFiles,
  webuiReviewLineTarget,
  type WebuiReviewFile,
} from "../../src/client/projection/review-state.js";

const files: readonly WebuiReviewFile[] = [
  { fileId: "f1", path: "src/one.ts", status: "modified", type: "text", additions: 3, deletions: 1 },
  { fileId: "f2", path: "src/two.ts", status: "added", type: "text", additions: 10, deletions: 0 },
  { fileId: "f3", path: "assets/logo.png", status: "modified", type: "binary", additions: 0, deletions: 0 },
];

const loaded = reduceWebuiReviewState(initialWebuiReviewState, {
  type: "summary-loaded",
  reviewSnapshotId: "snap-1",
  files,
  totals: { files: 3, additions: 13, deletions: 1 },
});

describe("review page load lifecycle", () => {
  it("carries the snapshot, file list and totals through", () => {
    expect(loaded.status).toBe("ready");
    expect(loaded.reviewSnapshotId).toBe("snap-1");
    expect(loaded.files).toHaveLength(3);
    expect(loaded.totals).toEqual({ files: 3, additions: 13, deletions: 1 });
  });

  /* "This workspace has no review snapshot" is a normal state, not a failure.
   * Reporting it as an error would show a red banner for a fresh workspace. */
  it("keeps an absent snapshot distinct from a failed load", () => {
    const unavailable = reduceWebuiReviewState(loaded, { type: "unavailable", reason: "没有待审查的变更" });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.error).toBeUndefined();

    const failed = reduceWebuiReviewState(loaded, { type: "load-failed", reason: "仓库读取失败" });
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("仓库读取失败");
  });

  /* Diffs are keyed by fileId, and fileIds belong to a snapshot. Showing the
   * previous snapshot's diffs under a new one would attribute another
   * snapshot's changes to this change set. */
  it("drops the previous snapshot's diffs when a reload starts", () => {
    const withDiff = reduceWebuiReviewState(loaded, {
      type: "diffs-loaded",
      diffs: { f1: "@@ -1 +1 @@\n-old\n+new" },
    });
    expect(withDiff.diffs.f1).toContain("+new");

    const reloading = reduceWebuiReviewState(withDiff, { type: "load-begun" });
    expect(reloading.diffs).toEqual({});
    expect(reloading.diffErrors).toEqual({});
    expect(reloading.status).toBe("loading");
  });

  it("settles only the files that were actually in flight", () => {
    const loading = reduceWebuiReviewState(loaded, { type: "diffs-begun", fileIds: ["f1", "f2"] });
    expect(loading.loadingFileIds).toEqual(["f1", "f2"]);

    const settled = reduceWebuiReviewState(loading, {
      type: "diffs-loaded",
      diffs: { f1: "diff f1" },
      errors: { f2: "补丁过大" },
    });
    expect(settled.loadingFileIds).toEqual([]);
    expect(settled.diffs.f1).toBe("diff f1");
    expect(settled.diffErrors.f2).toBe("补丁过大");
  });

  it("drops a stale in-flight marker once its diff lands", () => {
    const loading = reduceWebuiReviewState(loaded, { type: "diffs-begun", fileIds: ["f1", "f2"] });
    const first = reduceWebuiReviewState(loading, { type: "diffs-loaded", diffs: { f1: "a" } });
    expect(first.loadingFileIds).toEqual(["f2"]);

    const second = reduceWebuiReviewState(first, { type: "diffs-loaded", diffs: { f2: "b" } });
    expect(second.loadingFileIds).toEqual([]);
    expect(Object.keys(second.diffs).sort()).toEqual(["f1", "f2"]);
  });
});

describe("review search filter", () => {
  it("shows every file before a search has run for the current query", () => {
    const searching = reduceWebuiReviewState(loaded, { type: "query-changed", query: "one" });
    expect(isWebuiReviewFiltering(searching)).toBe(true);
    expect(selectWebuiReviewVisibleFiles(searching)).toHaveLength(3);
  });

  it("narrows to the matched files once the search settles", () => {
    let state = reduceWebuiReviewState(loaded, { type: "query-changed", query: "one" });
    state = reduceWebuiReviewState(state, { type: "search-begun" });
    expect(state.searchPending).toBe(true);
    state = reduceWebuiReviewState(state, { type: "search-settled", fileIds: ["f1"] });
    expect(selectWebuiReviewVisibleFiles(state).map((file) => file.fileId)).toEqual(["f1"]);
  });

  /* A search that matched nothing is an empty list. It must not silently fall
   * back to the unfiltered list, which is what an empty match set used to do. */
  it("shows an empty list when the query matched nothing", () => {
    let state = reduceWebuiReviewState(loaded, { type: "query-changed", query: "nothing-matches" });
    state = reduceWebuiReviewState(state, { type: "search-settled", fileIds: [] });
    expect(selectWebuiReviewVisibleFiles(state)).toEqual([]);
  });

  /* Editing the query must invalidate the previous matches, or the list keeps
   * filtering by a query that is no longer in the box. */
  it("drops previous matches when the query is edited", () => {
    let state = reduceWebuiReviewState(loaded, { type: "query-changed", query: "one" });
    state = reduceWebuiReviewState(state, { type: "search-settled", fileIds: ["f1"] });
    state = reduceWebuiReviewState(state, { type: "query-changed", query: "two" });
    expect(state.matchedFileIds).toEqual([]);
    expect(selectWebuiReviewVisibleFiles(state)).toHaveLength(3);
  });

  it("restores the full list when filters are cleared", () => {
    let state = reduceWebuiReviewState(loaded, { type: "query-changed", query: "one" });
    state = reduceWebuiReviewState(state, { type: "search-settled", fileIds: ["f1"] });
    state = reduceWebuiReviewState(state, { type: "clear-filters" });
    expect(state.query).toBe("");
    expect(isWebuiReviewFiltering(state)).toBe(false);
    expect(selectWebuiReviewVisibleFiles(state)).toHaveLength(3);
  });

  it("treats a whitespace-only query as no filter at all", () => {
    const state = reduceWebuiReviewState(loaded, { type: "query-changed", query: "   " });
    expect(isWebuiReviewFiltering(state)).toBe(false);
    expect(selectWebuiReviewVisibleFiles(state)).toHaveLength(3);
  });
});

describe("unified diff projection and the line target it yields", () => {
  const diff = [
    "diff --git a/src/one.ts b/src/one.ts",
    "index 123..456 100644",
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -10,4 +10,5 @@ export function thing() {",
    " const before = 1;",
    "-const removed = 2;",
    "+const added = 3;",
    "+const alsoAdded = 4;",
    " const after = 5;",
  ].join("\n");

  it("numbers both sides from the hunk header", () => {
    const lines = projectWebuiReviewLines(diff);
    const context = lines.find((line) => line.text === "const before = 1;");
    // Header says -10,4 +10,5, so the first context line is 10 on both sides.
    expect(context?.newLine).toBe(10);
    expect(context?.oldLine).toBe(10);
  });

  it("numbers a deletion on the old side only and an addition on the new side only", () => {
    const lines = projectWebuiReviewLines(diff);
    const deletion = lines.find((line) => line.text === "const removed = 2;");
    expect(deletion?.kind).toBe("deletion");
    expect(deletion?.oldLine).toBe(11);
    expect(deletion?.newLine).toBeUndefined();

    const addition = lines.find((line) => line.text === "const added = 3;");
    expect(addition?.kind).toBe("addition");
    expect(addition?.newLine).toBe(11);
    expect(addition?.oldLine).toBeUndefined();
  });

  it("advances the new side past a deletion and both sides past a context line", () => {
    const lines = projectWebuiReviewLines(diff);
    const second = lines.find((line) => line.text === "const alsoAdded = 4;");
    expect(second?.newLine).toBe(12);
    const after = lines.find((line) => line.text === "const after = 5;");
    expect(after?.newLine).toBe(13);
    expect(after?.oldLine).toBe(12);
  });

  /* This is the whole point of the row: a deleted line does not exist in the
   * file the editor will open, so it must not yield a jump target. */
  it("gives a deletion no editor target and gives additions and context one", () => {
    const lines = projectWebuiReviewLines(diff);
    const deletion = lines.find((line) => line.text === "const removed = 2;");
    const addition = lines.find((line) => line.text === "const added = 3;");
    const context = lines.find((line) => line.text === "const before = 1;");
    const header = lines.find((line) => line.kind === "hunk");
    expect(webuiReviewLineTarget(deletion!)).toBeUndefined();
    expect(webuiReviewLineTarget(addition!)).toBe(11);
    expect(webuiReviewLineTarget(context!)).toBe(10);
    expect(webuiReviewLineTarget(header!)).toBeUndefined();
  });

  it("does not let a no-newline marker consume a line number", () => {
    const withMarker = ["@@ -1,2 +1,2 @@", " keep", "-drop", "\\ No newline at end of file", "+added"].join("\n");
    const lines = projectWebuiReviewLines(withMarker);
    const added = lines.find((line) => line.text === "added");
    expect(added?.newLine).toBe(2);
    const marker = lines.find((line) => line.text.startsWith("\\ No newline"));
    expect(marker?.kind).toBe("meta");
  });

  it("treats content before the first hunk header as metadata, not as lines", () => {
    const lines = projectWebuiReviewLines(diff);
    const meta = lines.filter((line) => line.kind === "meta");
    expect(meta.map((line) => line.text)).toEqual([
      "diff --git a/src/one.ts b/src/one.ts",
      "index 123..456 100644",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
    ]);
    expect(meta.every((line) => webuiReviewLineTarget(line) === undefined)).toBe(true);
  });

  it("survives a hunk header without line numbers", () => {
    const lines = projectWebuiReviewLines("@@ -0,0 +1,2 @@\n+one\n+two");
    expect(lines.map((line) => line.newLine)).toEqual([undefined, 1, 2]);
  });

  it("handles CRLF diffs without leaking carriage returns into the line text", () => {
    const lines = projectWebuiReviewLines("@@ -1,1 +1,2 @@\r\n keep\r\n+added\r\n");
    const added = lines.find((line) => line.text === "added");
    expect(added).toBeDefined();
    expect(lines.every((line) => !line.text.includes("\r"))).toBe(true);
  });

  it("handles an empty diff", () => {
    expect(projectWebuiReviewLines("")).toEqual([{ kind: "meta", text: "" }]);
  });

  /* `webuiReviewLineTarget` reads this invariant instead of re-checking kinds:
   * a guard there was untestable, because the projection already guaranteed
   * the result. Asserting the invariant here is what makes the jump behaviour
   * depend on a tested contract rather than on an untestable line. */
  it("gives a new-side line number only to lines that exist in the new file", () => {
    const everyDiff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-gone",
      "\\ No newline at end of file",
      "+here",
    ].join("\n");
    for (const line of projectWebuiReviewLines(everyDiff)) {
      if (line.kind === "addition" || line.kind === "context") {
        expect(line.newLine, `${line.kind} should carry a new-side number`).toBeTypeOf("number");
        expect(webuiReviewLineTarget(line)).toBe(line.newLine);
      } else {
        expect(line.newLine, `${line.kind} must not carry a new-side number`).toBeUndefined();
        expect(webuiReviewLineTarget(line)).toBeUndefined();
      }
    }
  });
});
