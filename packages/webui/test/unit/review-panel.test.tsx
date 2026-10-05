import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WebuiReviewPanel } from "../../src/client/components/SettingsModal.js";
import {
  initialWebuiReviewState,
  reduceWebuiReviewState,
  selectWebuiReviewVisibleFiles,
  isWebuiReviewFiltering,
  type WebuiReviewFile,
} from "../../src/client/projection/review-state.js";

/* Why this file asserts on markup rather than on clicks:
 *
 * The webui suite runs `environment: "node"` — there is no jsdom, and
 * `renderToStaticMarkup` renders once without running effects. So the
 * decisions that a click would reveal (does expanding load a diff, does a line
 * carry a jump target, does a filter narrow the list) are all made upstream in
 * `review-state.ts` and reach the presentational half as plain values. This
 * file's job is to prove the panel renders those values faithfully and does
 * not invent or drop a jump target on the way to the DOM — the negative
 * injections recorded in the PR body target exactly that boundary.
 */

const files: readonly WebuiReviewFile[] = [
  { fileId: "f1", path: "src/one.ts", status: "modified", type: "text", additions: 2, deletions: 1 },
  { fileId: "f2", path: "assets/logo.png", status: "modified", type: "binary", additions: 0, deletions: 0 },
];

const ready = reduceWebuiReviewState(initialWebuiReviewState, {
  type: "summary-loaded",
  reviewSnapshotId: "snap-1",
  files,
  totals: { files: 2, additions: 2, deletions: 1 },
});

const panel = (state = ready, props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(WebuiReviewPanel, {
      state,
      visible: selectWebuiReviewVisibleFiles(state),
      filtering: isWebuiReviewFiltering(state),
      onOpenFileLine: () => undefined,
      ...props,
    } as never),
  );

describe("code review page states", () => {
  it("marks every state it can be in, so a test can tell them apart", () => {
    expect(panel(ready)).toContain('data-webui-review-state="ready"');
    expect(panel(reduceWebuiReviewState(initialWebuiReviewState, { type: "load-begun" }))).toContain(
      'data-webui-review-state="loading"',
    );
    expect(
      panel(reduceWebuiReviewState(initialWebuiReviewState, { type: "unavailable", reason: "" })),
    ).toContain('data-webui-review-state="unavailable"');
    expect(
      panel(reduceWebuiReviewState(initialWebuiReviewState, { type: "load-failed", reason: "boom" })),
    ).toContain('data-webui-review-state="error"');
  });

  /* A workspace with nothing to review is a normal state. Rendering it as a
   * failure would put a red banner on every clean repository. */
  it("does not present an absent change set as an error", () => {
    const unavailable = panel(
      reduceWebuiReviewState(initialWebuiReviewState, { type: "unavailable", reason: "" }),
      { empty: "当前工作区没有待审查的变更。" },
    );
    expect(unavailable).toContain('data-webui-review-state="unavailable"');
    expect(unavailable).not.toContain("webui-review-error");
    expect(unavailable).toContain("当前工作区没有待审查的变更。");
  });

  it("does show a failed load as an error, with the reason", () => {
    const failed = panel(reduceWebuiReviewState(initialWebuiReviewState, { type: "load-failed", reason: "仓库读取失败" }));
    expect(failed).toContain('data-webui-review-state="error"');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("仓库读取失败");
  });

  it("shows totals and one row per file when ready", () => {
    const markup = panel();
    expect(markup).toContain('data-testid="review-totals"');
    expect(markup).toContain("2 个文件");
    expect(markup).toContain("src/one.ts");
    expect(markup).toContain("assets/logo.png");
    expect(markup).toContain('data-webui-review-snapshot="snap-1"');
  });
});

describe("a review line is a real jump target, and only where one exists", () => {
  const diff = [
    "diff --git a/src/one.ts b/src/one.ts",
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -10,2 +10,2 @@",
    " const keep = 1;",
    "-const gone = 2;",
    "+const here = 3;",
  ].join("\n");

  const expanded = reduceWebuiReviewState(
    reduceWebuiReviewState(ready, { type: "diffs-loaded", diffs: { f1: diff } }),
    { type: "toggle-file", fileId: "f1" },
  );

  it("renders the diff only for an expanded file", () => {
    const collapsed = panel();
    expect(collapsed).not.toContain('data-testid="review-lines"');

    const opened = panel(expanded);
    expect(opened).toContain('data-testid="review-lines"');
    expect(opened).toContain("const here = 3;");
  });

  it("gives the surviving line a jump control carrying its new-side number", () => {
    const markup = panel(expanded);
    expect(markup).toContain('data-webui-review-jump-line="10"');
    expect(markup).toContain('data-webui-review-jump-line="11"');
  });

  /* The whole point of the row: a deleted line does not exist in the file the
   * editor will open, so it must not be offered as a destination. */
  it("does not offer a jump on a deleted line", () => {
    const markup = panel(expanded);
    const deletionLine = markup.split('data-webui-review-line-kind="deletion"')[1]?.split("</li>")[0] ?? "";
    expect(deletionLine).toContain("const gone = 2;");
    expect(deletionLine).not.toContain("review-line-jump");
  });

  it("does not offer a jump on the hunk header", () => {
    const markup = panel(expanded);
    const hunk = markup.split('data-webui-review-line-kind="hunk"')[1]?.split("</li>")[0] ?? "";
    expect(hunk).toContain("@@");
    expect(hunk).not.toContain("review-line-jump");
  });

  /* Without a jump handler there is nothing for a click to do, so the control
   * must not be rendered at all rather than rendered dead. */
  it("renders no jump control when there is nothing to call", () => {
    const markup = panel(expanded, { onOpenFileLine: undefined });
    expect(markup).toContain('data-testid="review-lines"');
    expect(markup).not.toContain("review-line-jump");
  });
});

describe("per-file diff outcomes are told apart", () => {
  it("shows a file failure instead of an empty diff", () => {
    const state = reduceWebuiReviewState(
      reduceWebuiReviewState(ready, { type: "diffs-loaded", diffs: {}, errors: { f1: "补丁过大" } }),
      { type: "toggle-file", fileId: "f1" },
    );
    const markup = panel(state);
    expect(markup).toContain('data-testid="review-file-error"');
    expect(markup).toContain("补丁过大");
    expect(markup).not.toContain('data-testid="review-lines"');
  });

  it("says it is loading rather than showing an empty diff body", () => {
    const state = reduceWebuiReviewState(
      reduceWebuiReviewState(ready, { type: "diffs-begun", fileIds: ["f1"] }),
      { type: "toggle-file", fileId: "f1" },
    );
    const markup = panel(state);
    expect(markup).toContain("正在读取这个文件的补丁…");
    expect(markup).not.toContain('data-testid="review-lines"');
  });
});

describe("the search box reflects filter state", () => {
  it("offers a clear control only while filtering", () => {
    expect(panel()).not.toContain('data-testid="review-search-clear"');

    const filtering = reduceWebuiReviewState(ready, { type: "query-changed", query: "one" });
    expect(panel(filtering)).toContain('data-testid="review-search-clear"');
  });

  it("keeps the query visible in the box", () => {
    const filtering = reduceWebuiReviewState(ready, { type: "query-changed", query: "one" });
    expect(panel(filtering)).toContain('value="one"');
  });
});

/* Why these two are source assertions and not render assertions:
 *
 * `SettingsModal` opens on the `desktop` tab and only moves to another one
 * from a click handler, so no `renderToStaticMarkup` call can ever reach the
 * `coding` or `worktree` branch — the panels are asserted directly above and
 * the wiring between the tab and the panel is not. Negative injection proved
 * the gap is real: replacing `{active === "coding" ? <SettingsReviewPage`
 * with `{false ? ...` left the whole suite green, and the same held for the
 * worktree tab.
 *
 * The webui suite has no jsdom, so the alternative is not a better test but a
 * different suite. The repo already accepts this shape for wiring that cannot
 * be clicked here (`rail-pin-affordance.test.ts` reads its source file the
 * same way). The window is kept narrow on purpose: each assertion quotes the
 * exact branch expression, so deleting the panel call or re-routing the tab
 * turns it red, while unrelated edits to the file do not.
 */
describe("tab-to-page wiring", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/client/components/SettingsModal.tsx", import.meta.url)),
    "utf8",
  );

  it("routes the coding tab to the review page", () => {
    expect(source).toContain('{active === "coding" ? <SettingsReviewPage');
  });

  it("routes the worktree tab to the worktree page", () => {
    expect(source).toContain('{active === "worktree" ? <SettingsWorktreePage');
  });

  /* Both tabs now have content, so neither may fall through to the empty-pane
   * placeholder. Leaving one in that fallback is the exact shape of the bug
   * this page set out to remove: a clickable tab with nothing behind it. */
  it("keeps both built tabs out of the empty-pane fallback", () => {
    const fallback = source.split('webui-settings-empty-panel')[0]?.split('{active === "archived"')?.at(-1) ?? "";
    expect(fallback).toContain('active !== "coding"');
    expect(fallback).toContain('active !== "worktree"');
  });
});
