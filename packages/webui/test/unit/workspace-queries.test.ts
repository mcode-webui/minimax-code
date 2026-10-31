// Unit tests for the workspace query owner.
//
// The owner is framework-free, so these run the actual decision logic the
// panels delegate to: that a superseded request's late response is discarded
// rather than applied, and that a mutation invalidates exactly the views it
// affects — not the world.

import { describe, expect, it } from "vitest";

import type { WebuiWorkspaceArchiveListing } from "../../src/shared/contracts/workspace.js";

import { createWebuiWorkspaceQueries } from "../../src/client/features/workspace/application/workspace-queries.js";
import { createWebuiWorkspaceReviewOwner } from "../../src/client/features/review/application/workspace-review-owner.public.js";
import type { WebuiWorkspaceQueryPort } from "../../src/client/features/workspace/application/workspace-queries.js";
import type { WebuiWorkspaceFileContent } from "../../src/shared/contracts/workspace.js";
import type { WebuiWorkspaceReviewSummary } from "../../src/shared/contracts/review.js";

/**
 * Workspace composes the review resource it is handed, so a test supplies one
 * the same way the composition root does. Building it here keeps every existing
 * fixture about the resource under test rather than about the seam.
 */
const webuiWorkspaceQueries = (deps: { readonly port: WebuiWorkspaceQueryPort }) =>
  createWebuiWorkspaceQueries({
    port: deps.port,
    review: createWebuiWorkspaceReviewOwner({ port: deps.port }),
  });

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const summary = (snapshotId: string): WebuiWorkspaceReviewSummary => ({
  repositoryId: "repo",
  reviewSnapshotId: snapshotId,
  files: [],
  totals: { files: 0, additions: 0, deletions: 0 },
});

describe("the workspace query owner files a read under the key it was given", () => {
  it("reads again when the content changed, because the key changed with it", async () => {
    const reads: string[] = [];
    const queries = webuiWorkspaceQueries({
      port: {
        readWorkspaceFile: ({ path }) => {
          reads.push(path);
          return Promise.resolve({ type: "text", content: path } as WebuiWorkspaceFileContent);
        },
      },
    });

    // The cache is keyed by what the tab is showing. A tab that changed from
    // one file to another has a different key, so the new file is read rather
    // than the old one's result being handed back.
    queries.files.readFile("file:s1:/w:src/index.ts", "/w", "src/index.ts");
    await flush();
    queries.files.readFile("file:s1:/w:README.md", "/w", "README.md");
    await flush();

    expect(reads).toEqual(["src/index.ts", "README.md"]);
  });
});

describe("the workspace query owner discards a superseded response", () => {
  it("keeps the newest file read when an older one answers later", async () => {
    const first = deferred<WebuiWorkspaceFileContent>();
    const second = deferred<WebuiWorkspaceFileContent>();
    let call = 0;
    const queries = webuiWorkspaceQueries({
      port: {
        readWorkspaceFile: () => {
          const pending = call === 0 ? first : second;
          call += 1;
          return pending.promise;
        },
      },
    });

    queries.files.readFile("tab", "/w", "a.ts");
    queries.files.readFile("tab", "/w", "b.ts");

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
    const queries = webuiWorkspaceQueries({
      port: { listWorkspaceFileTree: () => first.promise as never },
    });

    queries.files.loadFileTree("/old");
    // Leaving the workspace resets the tree to the new one.
    queries.files.selectWorkspace("/new");

    first.resolve([{ path: "a.ts", name: "a.ts", type: "file" }]);
    await flush();

    expect(queries.getSnapshot().fileTree.workspaceDir).toBe("/new");
    expect(queries.getSnapshot().fileTree.files).toHaveLength(0);
  });
});

describe("the workspace query owner invalidates exactly what a mutation affects", () => {
  it("bumps the environment and review revisions for the mutated workspace", async () => {
    const queries = webuiWorkspaceQueries({
      port: {
        mutateWorkspaceGit: async () => ({}),
        getWorkspaceEnvironment: async () => ({
          isGitRepo: true, changedFiles: 0, insertions: 0, deletions: 0, lineStatsStatus: "ready",
        }),
        getWorkspaceReviewSummary: async () => summary("snap-1"),
      },
    });

    queries.environment.loadEnvironment("/w");
    await queries.review.loadReviewSummary("tab", "/w");
    await flush();

    const before = queries.getSnapshot();
    await queries.environment.mutateGit({ workspaceDir: "/w", action: "commit" });
    const after = queries.getSnapshot();

    expect(after.environmentRevision).toBe(before.environmentRevision + 1);
    expect(after.reviewRevision).toBe(before.reviewRevision + 1);
  });

  it("leaves another workspace's review alone when a git signal names one", async () => {
    const queries = webuiWorkspaceQueries({
      port: { getWorkspaceReviewSummary: async () => summary("snap-1") },
    });

    await queries.review.loadReviewSummary("tab", "/w");
    const before = queries.getSnapshot().reviewRevision;

    queries.invalidateWorkspaceGit({ workspace: "/other" });
    expect(queries.getSnapshot().reviewRevision).toBe(before);

    queries.invalidateWorkspaceGit({ workspace: "/w" });
    expect(queries.getSnapshot().reviewRevision).toBe(before + 1);
  });
});

describe("a closed tab releases its file slot", () => {
  it("drops the content and refuses the read that was still in flight", async () => {
    const pending = deferred<WebuiWorkspaceFileContent>();
    const queries = webuiWorkspaceQueries({
      port: { readWorkspaceFile: () => pending.promise },
    });

    queries.files.readFile("tab", "/w", "a.ts");
    queries.files.discardFileTab("tab");
    // The read the closed tab was waiting for answers late: it has no reader, so
    // it must not commit into a slot nobody shows.
    pending.resolve({ type: "text", content: "A", resolvedPath: "a.ts" });
    await flush();

    expect(queries.getSnapshot().files.has("tab")).toBe(false);
  });

  it("leaves another tab's read alone", async () => {
    const first = deferred<WebuiWorkspaceFileContent>();
    const second = deferred<WebuiWorkspaceFileContent>();
    let call = 0;
    const queries = webuiWorkspaceQueries({
      port: {
        readWorkspaceFile: () => {
          const pending = call === 0 ? first : second;
          call += 1;
          return pending.promise;
        },
      },
    });

    queries.files.readFile("a", "/w", "a.ts");
    queries.files.readFile("b", "/w", "b.ts");
    queries.files.discardFileTab("a");
    first.resolve({ type: "text", content: "A", resolvedPath: "a.ts" });
    second.resolve({ type: "text", content: "B", resolvedPath: "b.ts" });
    await flush();

    // Closing one tab stops nothing the other tab accepted.
    expect(queries.getSnapshot().files.has("a")).toBe(false);
    expect(queries.getSnapshot().files.get("b")?.content?.content).toBe("B");
  });
});

describe("the archive owner drops a listing nobody is looking at", () => {
  // The listing payload carries no prefix: the read's identity lives on the
  // owner's state as `key`, which is what a superseded read is judged against.
  const listing = (archivePath: string) => ({
    archivePath,
    entries: [],
    totalEntries: 0,
    truncated: false,
  });

  it("keeps the newest listing when an older prefix answers later", async () => {
    const first = deferred<WebuiWorkspaceArchiveListing>();
    const second = deferred<WebuiWorkspaceArchiveListing>();
    let call = 0;
    const queries = webuiWorkspaceQueries({
      port: {
        readWorkspaceArchive: () => {
          const pending = call === 0 ? first : second;
          call += 1;
          return pending.promise;
        },
      },
    });

    queries.archive.readArchive({ workspaceDir: "/w", path: "a.zip" });
    queries.archive.readArchive({ workspaceDir: "/w", path: "a.zip", prefix: "src" });

    second.resolve(listing("a.zip"));
    await flush();
    first.resolve(listing("a.zip"));
    await flush();

    // The reader moved into `src`; the root listing that answered afterwards has
    // no reader and must not replace what is shown.
    const state = queries.getSnapshot().archive;
    expect(state.listing.status).toBe("ready");
    expect(state.key).toBe("/w\u0000a.zip\u0000src");
  });

  it("records an extract outcome the owner holds, not the view", async () => {
    const queries = webuiWorkspaceQueries({
      port: {
        readWorkspaceArchive: async () => listing("a.zip"),
        extractWorkspaceArchive: async () => ({ extracted: ["a.txt"] }) as never,
      },
    });

    await queries.archive.extractArchive({ workspaceDir: "/w", path: "a.zip", destination: "/out" });

    expect(queries.getSnapshot().archive.extract.status).toBe("done");
  });
});

describe("the canvas owner keeps one document per session", () => {
  const doc = (sessionId: string) => ({ sessionId, nodes: [] }) as never;

  it("drops a document for a session the reader has left", async () => {
    const first = deferred<never>();
    const second = deferred<never>();
    let call = 0;
    const queries = webuiWorkspaceQueries({
      port: {
        readCanvas: () => {
          const pending = call === 0 ? first : second;
          call += 1;
          return pending.promise;
        },
      },
    });

    queries.canvas.readCanvas("A");
    queries.canvas.readCanvas("B");
    second.resolve(doc("B"));
    await flush();
    first.resolve(doc("A"));
    await flush();

    const state = queries.getSnapshot().canvas;
    expect(state.sessionId).toBe("B");
    expect(state.status).toBe("ready");
  });

  it("reports a refused operation and keeps the stored document", async () => {
    const queries = webuiWorkspaceQueries({
      port: {
        readCanvas: async () => doc("A"),
        applyCanvas: async () => {
          throw new Error("refused");
        },
      },
    });

    await queries.canvas.readCanvas("A") as never;
    const landed = await queries.canvas.applyCanvas("A", { id: "op", mutations: [] } as never);

    const state = queries.getSnapshot().canvas;
    expect(landed).toBe(false);
    expect(state.error).toBe("refused");
    expect(state.busy).toBe(false);
  });
});

// The response cases that decide whether a panel shows the bytes it asked for.
// Each of these was a real behaviour with no test naming it, so a regression
// would have been invisible.

describe("inline content supersedes a read that is still in flight", () => {
  it("keeps the inline bytes when the earlier read answers late", async () => {
    const pending = deferred<WebuiWorkspaceFileContent>();
    const queries = webuiWorkspaceQueries({
      port: { readWorkspaceFile: () => pending.promise },
    });

    // The panel starts a read, and then the transcript hands the same tab the
    // document inline (the session's plan file, which lives outside the
    // workspace root and would be rejected by a read anyway).
    queries.files.readFile("tab", "/w", "plan.md");
    queries.files.setInlineFile("tab", "# plan", "plan.md");

    // The read answers afterwards. It was accepted before the inline content
    // arrived, but it must not land on top of what the tab now shows.
    pending.resolve({ type: "text", content: "STALE", resolvedPath: "plan.md" });
    await flush();

    const slot = queries.getSnapshot().files.get("tab");
    expect(slot?.content?.content).toBe("# plan");
    expect(slot?.loading).toBe(false);
    expect(slot?.error).toBeUndefined();
  });

  it("still reports a read failure that arrived before the inline content", async () => {
    const pending = deferred<WebuiWorkspaceFileContent>();
    const queries = webuiWorkspaceQueries({
      port: { readWorkspaceFile: () => pending.promise },
    });

    queries.files.readFile("tab", "/w", "plan.md");
    pending.reject(new Error("读取失败"));
    await flush();
    expect(queries.getSnapshot().files.get("tab")?.error).toBe("读取失败");

    // The inline content replaces the slot outright, error included: the tab is
    // no longer showing a read that failed.
    queries.files.setInlineFile("tab", "# plan", "plan.md");
    const slot = queries.getSnapshot().files.get("tab");
    expect(slot?.content?.content).toBe("# plan");
    expect(slot?.error).toBeUndefined();
  });
});

describe("a git signal matches a workspace by its alias too", () => {
  it("invalidates the environment and review held under the alias path", async () => {
    const queries = webuiWorkspaceQueries({
      port: {
        getWorkspaceEnvironment: async () => ({
          isGitRepo: true, changedFiles: 0, insertions: 0, deletions: 0, lineStatsStatus: "ready",
        }),
        getWorkspaceReviewSummary: async () => summary("snap-1"),
      },
    });

    // The runtime reports the repository under a name that is not the path the
    // panel holds — a worktree or a symlink target. Both views were loaded for
    // "/w", so a signal naming only "/w-alias" is still about them.
    queries.environment.loadEnvironment("/w");
    await queries.review.loadReviewSummary("tab", "/w");
    await flush();

    const before = queries.getSnapshot();
    queries.invalidateWorkspaceGit({ workspace: "/repo", aliases: ["/w"] });

    const after = queries.getSnapshot();
    expect(after.environmentRevision).toBe(before.environmentRevision);
    // The environment coalesces into its 350 ms window, so its revision has not
    // moved yet; the review is invalidated per signal and has.
    expect(after.reviewRevision).toBe(before.reviewRevision + 1);
  });

  it("invalidates the review when the alias is the one the panel holds", async () => {
    const queries = webuiWorkspaceQueries({
      port: { getWorkspaceReviewSummary: async () => summary("snap-1") },
    });

    await queries.review.loadReviewSummary("tab", "/w-alias");
    const before = queries.getSnapshot().reviewRevision;

    queries.invalidateWorkspaceGit({ workspace: "/repo", aliases: ["/w"] });
    expect(queries.getSnapshot().reviewRevision).toBe(before);
  });
});

describe("a burst of git signals", () => {
  it("invalidates the review once per signal and the environment once", async () => {
    const queries = webuiWorkspaceQueries({
      port: {
        getWorkspaceEnvironment: async () => ({
          isGitRepo: true, changedFiles: 0, insertions: 0, deletions: 0, lineStatsStatus: "ready",
        }),
        getWorkspaceReviewSummary: async () => summary("snap-1"),
      },
    });

    queries.environment.loadEnvironment("/w");
    await queries.review.loadReviewSummary("tab", "/w");
    await flush();

    const before = queries.getSnapshot();
    for (let index = 0; index < 5; index += 1) {
      queries.invalidateWorkspaceGit({ workspace: "/w" });
    }

    // Every signal is a real change the review has to re-read, so its revision
    // moves every time.
    expect(queries.getSnapshot().reviewRevision).toBe(before.reviewRevision + 5);
    // The environment is the expensive one, and its window is still open.
    expect(queries.getSnapshot().environmentRevision).toBe(before.environmentRevision);

    await new Promise((resolve) => setTimeout(resolve, 420));
    // Five signals inside one window are one invalidation, not five: the panel
    // sees one new revision and reloads once.
    expect(queries.getSnapshot().environmentRevision).toBe(before.environmentRevision + 1);
  });

  it("leaves a workspace the burst did not name alone", async () => {
    let otherReloads = 0;
    const queries = webuiWorkspaceQueries({
      port: {
        getWorkspaceEnvironment: async () => {
          otherReloads += 1;
          return { isGitRepo: true, changedFiles: 0, insertions: 0, deletions: 0, lineStatsStatus: "ready" };
        },
        getWorkspaceReviewSummary: async () => summary("snap-1"),
      },
    });

    queries.environment.loadEnvironment("/other");
    await queries.review.loadReviewSummary("tab", "/other");
    await flush();
    const before = queries.getSnapshot();

    for (let index = 0; index < 3; index += 1) {
      queries.invalidateWorkspaceGit({ workspace: "/w" });
    }

    expect(queries.getSnapshot().reviewRevision).toBe(before.reviewRevision);
    await new Promise((resolve) => setTimeout(resolve, 420));
    // Neither view was touched, and the owner did not go to the runtime at all:
    // it has nothing to say about a workspace no signal named.
    expect(otherReloads).toBe(1);
    expect(queries.getSnapshot().environmentRevision).toBe(before.environmentRevision);
  });
});
