// The workspace-review owner: the summary, the per-snapshot file diffs and the
// search, with two rules — a snapshot mismatch is not applied, and the retry it
// earns happens once per (tab, snapshot).

import { describe, expect, it, vi } from "vitest";

import { createWebuiWorkspaceReviewOwner } from "../../src/client/features/review/application/workspace-review-owner.public.js";
import {
  chunkWebuiWorkspaceReviewFileIds,
} from "../../src/client/features/review/contracts/workspace-review.js";

describe("the workspace-review owner", () => {
  it("refuses a diff batch whose snapshot is not the one it asked for", async () => {
    const invalidations: number[] = [];
    const owner = createWebuiWorkspaceReviewOwner({
      port: {
        // The workspace moved on between the summary and the diffs: the runtime
        // answers with a NEWER snapshot id.
        listWorkspaceReviewFileDiffs: async () => ({
          reviewSnapshotId: "newer",
          diffs: [],
        }),
      },
    });
    owner.subscribe(() => invalidations.push(owner.read().reviewRevision));
    await owner.loadDiffs({
      tabId: "tab-1",
      workspaceDir: "/w",
      snapshotId: "asked-for",
      fileIds: ["a.ts"],
    });
    const state = owner.read();
    expect(state.reviewDiffs.snapshotId).toBe("asked-for");
    expect(state.reviewDiffs.diffs).toEqual({});
    expect(state.reviewDiffs.error).toContain("正在刷新审查");
    // The refresh is a revision bump the views reload on, not a silent retry.
    expect(state.reviewRevision).toBe(1);
  });

  it("retries a stale snapshot once per tab and snapshot", async () => {
    const listDiffs = vi.fn(async () => ({ reviewSnapshotId: "newer", diffs: [] }));
    const owner = createWebuiWorkspaceReviewOwner({
      port: { listWorkspaceReviewFileDiffs: listDiffs },
    });
    const request = {
      tabId: "tab-1",
      workspaceDir: "/w",
      snapshotId: "asked-for",
      fileIds: ["a.ts"],
    };
    await owner.loadDiffs(request);
    await owner.loadDiffs(request);
    await owner.loadDiffs(request);
    // Three attempts, one invalidation: a stale loop cannot spin.
    expect(listDiffs).toHaveBeenCalledTimes(3);
    expect(owner.read().reviewRevision).toBe(1);
  });

  it("does not let a superseded query land", async () => {
    const pending: Array<(value: { reviewSnapshotId: string; diffs: never[] }) => void> = [];
    const owner = createWebuiWorkspaceReviewOwner({
      port: {
        listWorkspaceReviewFileDiffs: () =>
          new Promise((resolve) => pending.push(resolve as never)),
      },
    });
    const request = {
      tabId: "tab-1",
      workspaceDir: "/w",
      snapshotId: "s1",
      fileIds: ["a.ts"],
    };
    const first = owner.loadDiffs(request);
    const second = owner.loadDiffs({ ...request, snapshotId: "s2" });
    expect(pending).toHaveLength(2);
    pending[1]!({ reviewSnapshotId: "s2", diffs: [] });
    await second;
    pending[0]!({ reviewSnapshotId: "s1", diffs: [] });
    await first;
    expect(owner.read().reviewDiffs.snapshotId).toBe("s2");
  });

  it("reports an absent capability as an error state rather than silence", async () => {
    const owner = createWebuiWorkspaceReviewOwner({ port: {} });
    expect(owner.canReview).toBe(false);
    await expect(owner.loadSummary("tab-1", "/w")).resolves.toBeUndefined();
    expect(owner.read().reviewSummary.error).toContain("暂不可用");
  });

  it("invalidates for the workspace a git-changed signal names, and only that one", () => {
    const owner = createWebuiWorkspaceReviewOwner({ port: {} });
    expect(owner.read().reviewRevision).toBe(0);
    // Nothing was read for a workspace yet: a signal cannot match one.
    owner.invalidateForWorkspace({ workspace: "/w" });
    expect(owner.read().reviewRevision).toBe(0);
  });

  it("keeps the diff batch size the panel was built around", () => {
    expect(chunkWebuiWorkspaceReviewFileIds(["a", "b", "c", "d", "e", "f", "g"])).toEqual([
      ["a", "b", "c", "d", "e"],
      ["f", "g"],
    ]);
  });
});
