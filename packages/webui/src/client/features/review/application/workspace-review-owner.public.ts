// The workspace-review owner, published as a public module.
//
// The workspace business composes its five resources — file tree, file contents,
// environment, review, archive, canvas — through `workspace-queries.ts`, and
// the review half of that composition is this factory. Peer consumers cannot
// reach into the review business to build the owner themselves: the factory,
// its return type, and the invalidation surface are owned here, so the
// workspace composer reads the review owner's public contract through the
// publication marker instead of importing the review business's private
// module.
//
// This module is `.public` because the workspace business needs to construct
// the review owner for its composer without reaching past the review business.
// The `.public` suffix is a publication marker; the rule list and the retry
// window are unchanged, and the internal helpers stay inside the factory.
//
// Two rules the extraction had to keep, both visible in the code below:
//
// - a result whose `reviewSnapshotId` is not the one that was asked for is NOT
//   applied: the workspace moved on, and the views are told to refresh instead;
// - that refresh is attempted once per (tab, snapshot), so a stale loop cannot
//   spin.

import {
  chunkWebuiWorkspaceReviewFileIds,
} from "../contracts/workspace-review.js";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewSummary,
} from "../../../../shared/contracts/review.js";
import {
  initialWebuiWorkspaceReviewState,
  type WebuiWorkspaceReviewDiffFile,
  type WebuiWorkspaceReviewPort,
  type WebuiWorkspaceReviewState,
} from "../contracts/workspace-review.js";


function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export interface WebuiWorkspaceReviewOwner {
  readonly read: () => WebuiWorkspaceReviewState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly canReview: boolean;
  readonly canSearchDiffs: boolean;
  readonly loadSummary: (
    tabId: string,
    workspaceDir: string,
  ) => Promise<WebuiWorkspaceReviewSummary | undefined>;
  readonly loadDiffs: (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly fileIds: readonly string[];
  }) => Promise<void>;
  readonly search: (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly query: string;
  }) => Promise<void>;
  /** Bumps the revision the review views reload on. */
  readonly invalidate: () => void;
  /** The same, for the workspace a git-changed signal names. */
  readonly invalidateForWorkspace: (signal: {
    readonly workspace?: string;
    readonly aliases?: readonly string[];
  }) => void;
}

/**
 * The review resource plus its life, which is the composition root's.
 *
 * `dispose` is deliberately not on `WebuiWorkspaceReviewOwner`: Workspace composes
 * the review resource and a settings page renders it, and neither is what built
 * it. The root installed it and the root fences it.
 */
export interface WebuiWorkspaceReviewResource extends WebuiWorkspaceReviewOwner {
  readonly dispose: () => void;
}

export function createWebuiWorkspaceReviewOwner(deps: {
  readonly port: WebuiWorkspaceReviewPort;
}): WebuiWorkspaceReviewResource {
  let state: WebuiWorkspaceReviewState = initialWebuiWorkspaceReviewState;
  const listeners = new Set<() => void>();
  let disposed = false;
  const versions = new Map<string, number>();
  /** Snapshot ids a stale review already retried for a tab, so a stale loop
   *  cannot spin: one retry per (tab, snapshot). */
  const retriedSnapshots = new Set<string>();

  const notify = (): void => {
    // A fenced owner has no view left to tell, and a late answer must not
    // republish the state a teardown was ending.
    if (disposed) return;
    for (const listener of [...listeners]) listener();
  };
  const set = (update: (current: WebuiWorkspaceReviewState) => WebuiWorkspaceReviewState): void => {
    state = update(state);
    notify();
  };
  const bump = (key: string): number => {
    const next = (versions.get(key) ?? 0) + 1;
    versions.set(key, next);
    return next;
  };
  const isCurrent = (key: string, version: number): boolean =>
    versions.get(key) === version;

  const invalidate = (): void => {
    set((current) => ({ ...current, reviewRevision: current.reviewRevision + 1 }));
  };

  const refreshStaleReview = (tabId: string, snapshotId: string): void => {
    const retryKey = `${tabId}:${snapshotId}`;
    if (retriedSnapshots.has(retryKey)) return;
    retriedSnapshots.add(retryKey);
    invalidate();
  };

  const loadSummary = async (
    tabId: string,
    workspaceDir: string,
  ): Promise<WebuiWorkspaceReviewSummary | undefined> => {
    const key = `reviewSummary:${tabId}`;
    const version = bump(key);
    const getSummary = deps.port.getWorkspaceReviewSummary;
    if (!getSummary) {
      set((current) => ({
        ...current,
        reviewSummary: {
          tabId,
          workspaceDir,
          loading: false,
          error: "工作区变更审查能力暂不可用。",
        },
      }));
      return undefined;
    }
    set((current) => ({
      ...current,
      reviewSummary: {
        tabId,
        workspaceDir,
        summary: current.reviewSummary.tabId === tabId ? current.reviewSummary.summary : undefined,
        loading: true,
        stale: current.reviewSummary.tabId === tabId && Boolean(current.reviewSummary.summary),
      },
    }));
    try {
      const summary = await getSummary({ workspaceDir });
      if (!isCurrent(key, version)) return undefined;
      set((current) => ({
        ...current,
        reviewSummary: { tabId, workspaceDir, summary, loading: false },
      }));
      return summary;
    } catch (reason) {
      if (!isCurrent(key, version)) return undefined;
      set((current) => ({
        ...current,
        reviewSummary: {
          tabId,
          workspaceDir,
          summary: current.reviewSummary.tabId === tabId ? current.reviewSummary.summary : undefined,
          loading: false,
          stale: current.reviewSummary.tabId === tabId && Boolean(current.reviewSummary.summary),
          error: message(reason),
        },
      }));
      return undefined;
    }
  };

  const loadDiffs = async (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly fileIds: readonly string[];
  }): Promise<void> => {
    const { tabId, workspaceDir, snapshotId, fileIds } = request;
    const key = `reviewDiffs:${tabId}`;
    const version = bump(key);
    const listDiffs = deps.port.listWorkspaceReviewFileDiffs;
    if (!listDiffs) {
      set((current) => ({
        ...current,
        reviewDiffs: {
          tabId,
          workspaceDir,
          snapshotId,
          loading: false,
          diffs: {},
          error: "工作区文件差异能力暂不可用。",
        },
      }));
      return;
    }
    set((current) => ({
      ...current,
      reviewDiffs: { tabId, workspaceDir, snapshotId, loading: true, diffs: {} },
    }));
    const diffs: Record<string, WebuiWorkspaceReviewDiffFile> = {};
    try {
      for (const batch of chunkWebuiWorkspaceReviewFileIds(fileIds)) {
        const result: WebuiWorkspaceReviewDiffs = await listDiffs({
          workspaceDir,
          reviewSnapshotId: snapshotId,
          fileIds: batch,
        });
        if (!isCurrent(key, version)) return;
        if (result.reviewSnapshotId !== snapshotId) {
          set((current) => ({
            ...current,
            reviewDiffs: {
              tabId,
              workspaceDir,
              snapshotId,
              loading: false,
              diffs,
              error: "工作区变更已更新，正在刷新审查…",
            },
          }));
          refreshStaleReview(tabId, snapshotId);
          return;
        }
        for (const fileDiff of result.diffs) {
          diffs[fileDiff.fileId] = {
            ...(fileDiff.diff?.type === "text"
              ? { diff: fileDiff.diff.diff ?? fileDiff.diff.content }
              : fileDiff.diff?.type === "binary"
                ? { binary: true }
                : {}),
            ...(fileDiff.error ?? fileDiff.errorCode
              ? { error: fileDiff.error ?? fileDiff.errorCode }
              : {}),
          };
        }
        set((current) => ({
          ...current,
          reviewDiffs: { tabId, workspaceDir, snapshotId, loading: true, diffs: { ...diffs } },
        }));
      }
      if (!isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        reviewDiffs: { tabId, workspaceDir, snapshotId, loading: false, diffs: { ...diffs } },
      }));
    } catch (reason) {
      if (!isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        reviewDiffs: {
          tabId,
          workspaceDir,
          snapshotId,
          loading: false,
          diffs: { ...diffs },
          error: message(reason),
        },
      }));
      refreshStaleReview(tabId, snapshotId);
    }
  };

  const search = async (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly query: string;
  }): Promise<void> => {
    const { tabId, workspaceDir, snapshotId, query } = request;
    const searchDiffs = deps.port.searchWorkspaceReviewDiffs;
    if (!searchDiffs) return;
    const key = `reviewSearch:${tabId}`;
    const version = bump(key);
    set((current) => ({
      ...current,
      reviewSearch: { tabId, workspaceDir, snapshotId, loading: true },
    }));
    try {
      const result = await searchDiffs({
        workspaceDir,
        reviewSnapshotId: snapshotId,
        query,
        includeUntrackedFiles: true,
      });
      if (!isCurrent(key, version)) return;
      if (result.reviewSnapshotId !== snapshotId) {
        set((current) => ({
          ...current,
          reviewSearch: {
            tabId,
            workspaceDir,
            snapshotId,
            loading: false,
            error: "工作区变更已更新，正在刷新审查…",
          },
        }));
        refreshStaleReview(tabId, snapshotId);
        return;
      }
      set((current) => ({
        ...current,
        reviewSearch: { tabId, workspaceDir, snapshotId, loading: false, result },
      }));
    } catch (reason) {
      if (!isCurrent(key, version)) return;
      set((current) => ({
        ...current,
        reviewSearch: {
          tabId,
          workspaceDir,
          snapshotId,
          loading: false,
          error: message(reason),
        },
      }));
      refreshStaleReview(tabId, snapshotId);
    }
  };

  const invalidateForWorkspace = (signal: {
    readonly workspace?: string;
    readonly aliases?: readonly string[];
  }): void => {
    const workspaceDir = state.reviewSummary.workspaceDir;
    if (
      workspaceDir !== undefined &&
      (signal.workspace === workspaceDir || Boolean(signal.aliases?.includes(workspaceDir)))
    ) {
      invalidate();
    }
  };

  return {
    read: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      versions.clear();
      retriedSnapshots.clear();
    },
    canReview: deps.port.getWorkspaceReviewSummary !== undefined,
    canSearchDiffs: deps.port.searchWorkspaceReviewDiffs !== undefined,
    loadSummary,
    loadDiffs,
    search,
    invalidate,
    invalidateForWorkspace,
  };
}
