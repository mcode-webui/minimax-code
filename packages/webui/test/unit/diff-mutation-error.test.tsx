import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  WebuiDiffCard,
  buildWebuiDiffMutationRequest,
  describeWebuiDiffFailure,
  initialWebuiDiffState,
  reduceWebuiDiffState,
  resolveWebuiDiffMutation,
} from "../../src/client/components/DiffCard.js";
import type { WebuiTurnDiffView } from "../../src/shared/contracts/session.js";

/* Why these tests are about the shape of a FAILED mutation, not about markup:
 *
 * `renderToStaticMarkup` does not run effects and cannot fire a click, so
 * every assertion here is deliberately aimed at a pure function or at a
 * state object the component accepts through `initialState`. The event path
 * itself (`mutate` in DiffCard.tsx) is therefore not covered by this file —
 * it is covered indirectly, because the whole decision of what a transport
 * result means is delegated to `resolveWebuiDiffMutation` and the rendering
 * of a failure is delegated to `reduceWebuiDiffState` + the JSX below. If
 * someone re-inlines that decision into the component, these tests keep
 * passing while the component rots; the browser suite is what actually
 * drives the click. That split is deliberate, and it is why the negative
 * injections recorded in the PR body target these two seams.
 */

const files = [
  { file: "one.ts", additions: 2, deletions: 1 },
  { file: "two.ts", additions: 3, deletions: 0 },
];

const activeView: WebuiTurnDiffView = {
  status: "active",
  changeSetId: "changes-1",
  sourceMessageId: "assistant-1",
  canUndo: true,
  canReapply: false,
  fileChanges: files,
};

const revertedView: WebuiTurnDiffView = {
  ...activeView,
  status: "reverted",
  canUndo: false,
  canReapply: true,
};

const loaded = (view: WebuiTurnDiffView = activeView) =>
  reduceWebuiDiffState(initialWebuiDiffState, { type: "loaded", view });

describe("a failed revert/reapply is reported, not relabelled as a missing capability", () => {
  /* The defect this file exists for: `mutation-failed` used to reduce to
   * `unsupported: true`, which renders "当前运行时未提供 session diff 能力。"
   * The runtime DID answer — it declined the operation. The card then also
   * became permanently dead, because `buildWebuiDiffMutationRequest` refuses
   * every request once `unsupported` is set and nothing ever resets it. */
  it("does not claim the runtime lacks the capability when the operation merely failed", () => {
    const failed = reduceWebuiDiffState(loaded(), {
      type: "mutation-failed",
      error: "plan-not-safe: 目标路径在工作区之外",
    });

    expect(failed.unsupported).toBe(false);
    expect(failed.mutationError).toBe("plan-not-safe: 目标路径在工作区之外");
  });

  it("keeps the card actionable so the user can retry after a failure", () => {
    const failed = reduceWebuiDiffState(loaded(), { type: "mutation-failed" });

    expect(failed.busy).toBe(false);
    expect(buildWebuiDiffMutationRequest(failed, { id: "s" }, "revert")).toEqual({
      id: "s",
      changeSetId: "changes-1",
    });
  });

  it("renders the failure on the live card instead of the capability-missing card", () => {
    const markup = renderToStaticMarkup(
      createElement(WebuiDiffCard, {
        initialView: activeView,
        initialState: {
          ...initialWebuiDiffState,
          mutationError: "plan-not-safe: 目标路径在工作区之外",
        },
      }),
    );

    expect(markup).toContain('data-testid="turn-diff-mutation-error"');
    expect(markup).toContain("plan-not-safe: 目标路径在工作区之外");
    // The card itself must survive: a failure is not a reason to hide the
    // file list or the retry control.
    expect(markup).toContain('data-testid="turn-diff-card"');
    expect(markup).toContain('data-testid="turn-diff-undo"');
    expect(markup).toContain("one.ts");
    // And it must not claim the capability is missing.
    expect(markup).not.toContain("当前运行时未提供 session diff 能力");
  });

  it("offers a dismiss control so the reason is not stuck on screen forever", () => {
    const markup = renderToStaticMarkup(
      createElement(WebuiDiffCard, {
        initialView: activeView,
        initialState: { ...initialWebuiDiffState, mutationError: "boom" },
      }),
    );
    expect(markup).toContain('data-testid="turn-diff-mutation-error-dismiss"');

    const dismissed = reduceWebuiDiffState(
      { ...initialWebuiDiffState, mutationError: "boom" },
      { type: "dismiss-mutation-error" },
    );
    expect(dismissed.mutationError).toBeUndefined();
    expect(dismissed.unsupported).toBe(false);
  });

  it("clears a stale reason when a new attempt starts or succeeds", () => {
    const failed = { ...initialWebuiDiffState, view: activeView, mutationError: "old failure" };

    expect(
      reduceWebuiDiffState(failed, { type: "begin-mutation" }).mutationError,
    ).toBeUndefined();
    expect(
      reduceWebuiDiffState(failed, { type: "mutation-succeeded", view: activeView })
        .mutationError,
    ).toBeUndefined();
    expect(
      reduceWebuiDiffState(failed, { type: "loaded", view: activeView }).mutationError,
    ).toBeUndefined();
  });

  /* A genuinely unavailable capability keeps its old meaning. Without this,
   * the fix would be "never say unsupported again", which is a different bug.
   *
   * It has to start from a state that actually carries a failure reason: the
   * first draft of this assertion reduced `unsupported` from a freshly loaded
   * card, whose `mutationError` was already `undefined`, so it passed whether
   * or not the transition cleared anything. */
  it("still reports a genuinely unavailable capability as unsupported, and drops any stale failure", () => {
    const failed = reduceWebuiDiffState(loaded(), { type: "mutation-failed", error: "boom" });
    expect(failed.mutationError).toBe("boom");

    const unsupported = reduceWebuiDiffState(failed, { type: "unsupported" });
    expect(unsupported.unsupported).toBe(true);
    expect(unsupported.mutationError).toBeUndefined();
    expect(buildWebuiDiffMutationRequest(unsupported, { id: "s" }, "revert")).toBeUndefined();
  });
});

describe("resolveWebuiDiffMutation reads the transport result the way the wire means it", () => {
  it("treats a revert that returns a populated view as success", () => {
    expect(
      resolveWebuiDiffMutation("revert", { success: true, turnDiff: revertedView }),
    ).toEqual({ type: "mutation-succeeded", view: revertedView });
  });

  /* `revertTurnDiff` reports refusal as `{ success: false, error }` and no
   * `turnDiff` at all. The `error` string is the only explanation the user
   * can get, so it has to survive into the rendered state. */
  it("surfaces the error string the server sent when a revert is refused", () => {
    expect(
      resolveWebuiDiffMutation("revert", {
        success: false,
        error: "plan-not-safe: 目标路径在工作区之外",
      }),
    ).toEqual({
      type: "mutation-failed",
      error: "plan-not-safe: 目标路径在工作区之外",
    });
  });

  /* `reapplyTurnDiff` answers with the view itself, so its `error` is read
   * from the top level. Reading it only off the revert branch dropped the
   * explanation for every failed reapply — the one case where a user who just
   * clicked "重新应用" most needs to be told why nothing happened. */
  it("surfaces the error string a refused reapply sent", () => {
    expect(
      resolveWebuiDiffMutation("reapply", {
        success: false,
        error: "change set 已不在当前工作区",
        ...revertedView,
      }),
    ).toEqual({
      type: "mutation-failed",
      error: "change set 已不在当前工作区",
    });
  });

  /* An explicit `success: false` is a refusal even if a view rode along. */
  it("does not let a view override an explicit refusal", () => {
    expect(
      resolveWebuiDiffMutation("revert", { success: false, error: "nope", turnDiff: revertedView }),
    ).toEqual({ type: "mutation-failed", error: "nope" });
  });

  /* `success` is OPTIONAL on `WebuiRevertTurnDiffResult`, so a runtime that
   * reports only `error` and omits `success` is a contract-legal payload —
   * and it takes a different path than the explicit-`false` refusal above,
   * which returns early. Without this case the whole reason-carrying fallback
   * is untested: the negative-injection run showed two mutations of that
   * fallback surviving while every other seam died. */
  it("surfaces a reason from a revert that omits success entirely", () => {
    expect(
      resolveWebuiDiffMutation("revert", {
        error: "plan-not-safe: 目标路径在工作区之外",
      }),
    ).toEqual({
      type: "mutation-failed",
      error: "plan-not-safe: 目标路径在工作区之外",
    });
  });

  /* The card renders `null` when `fileChanges` is empty, so a view that
   * applied nothing must be read as a failure — otherwise the card silently
   * disappears with no message at all. */
  it("does not read an empty view as a success", () => {
    expect(resolveWebuiDiffMutation("reapply", { success: true })).toEqual({
      type: "mutation-failed",
      error: undefined,
    });
    expect(resolveWebuiDiffMutation("reapply", { success: true, fileChanges: [] })).toEqual({
      type: "mutation-failed",
      error: undefined,
    });
    expect(resolveWebuiDiffMutation("revert", { success: true, turnDiff: { changeSetId: "c" } })).toEqual({
      type: "mutation-failed",
      error: undefined,
    });
  });

  it("still accepts a reapply that really did return files", () => {
    const applied = { success: true, ...activeView };
    expect(resolveWebuiDiffMutation("reapply", applied)).toEqual({
      type: "mutation-succeeded",
      view: applied,
    });
  });

  it("falls back to a reason that does not blame the capability", () => {
    // Whitespace-only is not a reason; the state must carry no string at all
    // so the banner can still render its static title without a blank line.
    expect(resolveWebuiDiffMutation("revert", { success: false, error: "   " })).toEqual({
      type: "mutation-failed",
      error: undefined,
    });
    expect(resolveWebuiDiffMutation("revert", { success: false })).toEqual({
      type: "mutation-failed",
      error: undefined,
    });
  });

  /* `reapplyTurnDiff` requires `success`, so reaching the reason-carrying
   * fallback with a non-empty `error` means the payload contradicts itself:
   * it claims to have worked and names a reason it did not. For any
   * contract-legal input this case is unreachable, which is exactly why it
   * needs pinning — without it the resolver can silently start preferring the
   * `success` flag and drop the reason, and no legal payload would catch it.
   * This is a socket boundary; a runtime that says both is better answered
   * with the reason than with silence. */
  it("prefers a stated reason over a success flag when a reapply payload contradicts itself", () => {
    expect(
      resolveWebuiDiffMutation("reapply", {
        success: true,
        error: "change set 已不在当前工作区",
        ...activeView,
        fileChanges: [],
      }),
    ).toEqual({ type: "mutation-failed", error: "change set 已不在当前工作区" });
  });

  it("carries a thrown transport error into the failure", () => {
    expect(
      resolveWebuiDiffMutation("revert", undefined, new Error("WebUI request timed out after 30000ms (revertTurnDiff)")),
    ).toEqual({
      type: "mutation-failed",
      error: "WebUI request timed out after 30000ms (revertTurnDiff)",
    });
  });

  /* A non-Error throw is not a crash, it is a failure with no explanation.
   * It must still be reported as a failure rather than crashing the card. */
  it("treats a non-Error throw as a failure without a reason", () => {
    expect(resolveWebuiDiffMutation("reapply", undefined, "socket closed")).toEqual({
      type: "mutation-failed",
      error: undefined,
    });
    expect(resolveWebuiDiffMutation("reapply", undefined, new Error("   "))).toEqual({
      type: "mutation-failed",
      error: undefined,
    });
  });
});

/* The runtime's reasons are machine tokens. `applyLocalTurnDiffSnapshotMutation`
 * reports `unsafe_path` when `safeCapturedPath` cannot resolve a captured
 * entry — which `normalizeCapturePath` does for *filtered in-workspace* paths
 * (`.git/`, `node_modules/`), not for paths escaping the workspace, those are
 * accepted. The check runs inside the write loop, so the run can be
 * half-applied. `conflict` fires when a file changed after the turn. Both reach
 * the client verbatim through `assertMutationSucceeded`, which throws with
 * `body.error` as the message. Without a translation the user reads the token. */
describe("runtime reason codes become something a person can act on", () => {
  it("translates every reason the mutation path can produce", () => {
    expect(describeWebuiDiffFailure("unsafe_path")).toBe("这轮改动里有文件的路径无法安全定位，操作已中断，之前处理过的文件可能已改动。");
    expect(describeWebuiDiffFailure("conflict")).toBe("这轮改动之后文件又被修改过，撤销前请先确认当前内容。");
    expect(describeWebuiDiffFailure("not_undoable")).toBe("这轮文件改动没有留下可撤销的快照。");
    expect(describeWebuiDiffFailure("Turn diff not found")).toBe("找不到这轮文件改动。");
    expect(describeWebuiDiffFailure("Only the latest turn diff can be changed")).toBe("只能撤销最近一轮的文件改动。");
    expect(describeWebuiDiffFailure("Turn diff is not undoable")).toBe("这轮文件改动没有可撤销的补丁。");
  });

  it("no longer shows a raw token as the user-facing reason", () => {
    const action = resolveWebuiDiffMutation("revert", { success: false, error: "unsafe_path" });
    expect(action).toEqual({ type: "mutation-failed", error: "这轮改动里有文件的路径无法安全定位，操作已中断，之前处理过的文件可能已改动。" });
    expect(action.type === "mutation-failed" && action.error).not.toBe("unsafe_path");
  });

  /* `git apply` failures arrive as free-form stderr. Passing them through keeps
   * a real message; replacing them with a guess would be worse than useless. */
  it("passes an unknown reason through unchanged", () => {
    expect(describeWebuiDiffFailure("error: patch failed: src/one.ts:3")).toBe("error: patch failed: src/one.ts:3");
    expect(describeWebuiDiffFailure("  unsafe_path  ")).toBe("这轮改动里有文件的路径无法安全定位，操作已中断，之前处理过的文件可能已改动。");
  });

  it("still reports no reason when there is none", () => {
    expect(describeWebuiDiffFailure(undefined)).toBeUndefined();
    expect(describeWebuiDiffFailure("")).toBeUndefined();
    expect(describeWebuiDiffFailure("   ")).toBeUndefined();
  });

  it("translates a thrown unsafe_path the same way as a reported one", () => {
    expect(resolveWebuiDiffMutation("revert", undefined, new Error("unsafe_path"))).toEqual({
      type: "mutation-failed",
      error: "这轮改动里有文件的路径无法安全定位，操作已中断，之前处理过的文件可能已改动。",
    });
  });
});
