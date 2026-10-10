// Unit tests for the workspace query owner (ticket #51).
//
// The owner is framework-free, so these run the actual decision logic the
// panels delegate to: that a superseded request's late response is discarded
// rather than applied, and that a mutation invalidates exactly the views it
// affects — not the world.

import { describe, expect, it } from "vitest";

import { createWebuiWorkspaceQueries } from "../../src/client/application/workspace-queries.js";
import type { WebuiWorkspaceFileContent } from "../../src/shared/contracts/workspace.js";
import type { WebuiWorkspaceReviewSummary } from "../../src/shared/contracts/review.js";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const summary = (snapshotId: string): WebuiWorkspaceReviewSummary => ({
  repositoryId: "repo",
  reviewSnapshotId: snapshotId,
  files: [],
  totals: { files: 0, additions: 0, deletions: 0 },
});

describe("the workspace query owner discards a superseded response", () => {
  it("keeps the newest file read when an older one answers later", async () => {
    const first = deferred<WebuiWorkspaceFileContent>();
    const second = deferred<WebuiWorkspaceFileContent>();
    let call = 0;
    const queries = createWebuiWorkspaceQueries({
      port: {
        readWorkspaceFile: () => {
          const pending = call === 0 ? first : second;
          call += 1;
          return pending.promise;
        },
      },
    });

    queries.readFile("tab", "/w", "a.ts");
    queries.readFile("tab", "/w", "b.ts");

    // The second request answers first and lands; the first answers after the
    // selection moved and must be dropped, not applied over b.ts.
    second.resolve({ type: "text", content: "B", resolvedPath: "b.ts" });
    await flush();
    first.resolve({ type: "text", content: "A", resolvedPath: "a.ts" });
    await flush();

    expect(queries.getSnapshot().files.get("tab")?.content?.content).toBe("B");
  });

  it("drops a tree answer for a workspace the owner has left", async () => {
    const first = deferred<readonly { path: string; name: string; type: "file" }[]>();
    const queries = createWebuiWorkspaceQueries({
      port: { listWorkspaceFileTree: () => first.promise as never },
    });

    queries.loadFileTree("/old");
    // Leaving the workspace resets the tree to the new one.
    queries.selectWorkspace("/new");

    first.resolve([{ path: "a.ts", name: "a.ts", type: "file" }]);
    await flush();

    expect(queries.getSnapshot().fileTree.workspaceDir).toBe("/new");
    expect(queries.getSnapshot().fileTree.files).toHaveLength(0);
  });
});

describe("the workspace query owner invalidates exactly what a mutation affects", () => {
  it("bumps the environment and review revisions for the mutated workspace", async () => {
    const queries = createWebuiWorkspaceQueries({
      port: {
        mutateWorkspaceGit: async () => ({}),
        getWorkspaceEnvironment: async () => ({
          isGitRepo: true, changedFiles: 0, insertions: 0, deletions: 0, lineStatsStatus: "ready",
        }),
        getWorkspaceReviewSummary: async () => summary("snap-1"),
      },
    });

    queries.loadEnvironment("/w");
    await queries.loadReviewSummary("tab", "/w");
    await flush();

    const before = queries.getSnapshot();
    await queries.mutateGit({ workspaceDir: "/w", action: "commit" });
    const after = queries.getSnapshot();

    expect(after.environmentRevision).toBe(before.environmentRevision + 1);
    expect(after.reviewRevision).toBe(before.reviewRevision + 1);
  });

  it("leaves another workspace's review alone when a git signal names one", async () => {
    const queries = createWebuiWorkspaceQueries({
      port: { getWorkspaceReviewSummary: async () => summary("snap-1") },
    });

    await queries.loadReviewSummary("tab", "/w");
    const before = queries.getSnapshot().reviewRevision;

    queries.invalidateWorkspaceGit({ workspace: "/other" });
    expect(queries.getSnapshot().reviewRevision).toBe(before);

    queries.invalidateWorkspaceGit({ workspace: "/w" });
    expect(queries.getSnapshot().reviewRevision).toBe(before + 1);
  });
});
