// The workspace-review family's published state, port and reads.
//
// Distinct from the turn family on purpose: a turn changeset and a working-tree
// snapshot are different identities, and one schema must not be substituted for
// the other. The two families share invalidation coordination, not a model.

import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../../../shared/contracts/review.js";

/** The review-summary query for one tab's workspace. `stale` is set while a
 *  refresh runs over a summary this tab already holds. */
export interface WebuiWorkspaceReviewSummaryState {
  readonly tabId?: string;
  readonly workspaceDir?: string;
  readonly summary?: WebuiWorkspaceReviewSummary;
  readonly loading: boolean;
  readonly error?: string;
  readonly stale?: boolean;
}

/** One file's diff outcome inside the review-diffs query. */
export interface WebuiWorkspaceReviewDiffFile {
  readonly diff?: string;
  readonly error?: string;
  readonly binary?: boolean;
}

/** The review-diffs query for one snapshot of one workspace. */
export interface WebuiWorkspaceReviewDiffState {
  readonly tabId?: string;
  readonly workspaceDir?: string;
  readonly snapshotId?: string;
  readonly loading: boolean;
  readonly diffs: Readonly<Record<string, WebuiWorkspaceReviewDiffFile>>;
  readonly error?: string;
}

/** The review-search query for one snapshot of one workspace. */
export interface WebuiWorkspaceReviewSearchState {
  readonly tabId?: string;
  readonly workspaceDir?: string;
  readonly snapshotId?: string;
  readonly loading: boolean;
  readonly result?: WebuiWorkspaceReviewSearchResult;
  readonly error?: string;
}

/** The family's slice of whatever composes it. */
export interface WebuiWorkspaceReviewState {
  /**
   * Bumps when the review views for the active workspace are invalidated — a
   * commit, a git-changed signal or a stale-snapshot retry. Effects that reload
   * a review query key on it, so invalidation is an explicit, single signal
   * rather than a reload beside the effect's own.
   */
  readonly reviewRevision: number;
  readonly reviewSummary: WebuiWorkspaceReviewSummaryState;
  readonly reviewDiffs: WebuiWorkspaceReviewDiffState;
  readonly reviewSearch: WebuiWorkspaceReviewSearchState;
}

export const initialWebuiWorkspaceReviewSummaryState: WebuiWorkspaceReviewSummaryState =
  { loading: false };

export const initialWebuiWorkspaceReviewDiffState: WebuiWorkspaceReviewDiffState = {
  loading: false,
  diffs: {},
};

export const initialWebuiWorkspaceReviewSearchState: WebuiWorkspaceReviewSearchState =
  { loading: false };

export const initialWebuiWorkspaceReviewState: WebuiWorkspaceReviewState = {
  reviewRevision: 0,
  reviewSummary: initialWebuiWorkspaceReviewSummaryState,
  reviewDiffs: initialWebuiWorkspaceReviewDiffState,
  reviewSearch: initialWebuiWorkspaceReviewSearchState,
};

/** The capabilities this family needs, injected by whoever assembles it. */
export interface WebuiWorkspaceReviewPort {
  readonly getWorkspaceReviewSummary?: (request: {
    readonly workspaceDir: string;
  }) => Promise<WebuiWorkspaceReviewSummary>;
  readonly listWorkspaceReviewFileDiffs?: (request: {
    readonly workspaceDir: string;
    readonly reviewSnapshotId: string;
    readonly fileIds: readonly string[];
  }) => Promise<WebuiWorkspaceReviewDiffs>;
  readonly searchWorkspaceReviewDiffs?: (request: {
    readonly workspaceDir: string;
    readonly reviewSnapshotId: string;
    readonly query: string;
    readonly includeUntrackedFiles: boolean;
  }) => Promise<WebuiWorkspaceReviewSearchResult>;
}

/**
 * The diff-batch size and its chunking helper. They are declarations the surfaces
 * and the owner both use, so they live with the contract rather than inside the
 * owner's implementation: a peer surface reads the contract, not the owner.
 */
export const WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE = 5;

export function chunkWebuiWorkspaceReviewFileIds(
  fileIds: readonly string[],
): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < fileIds.length; index += WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE) {
    batches.push(fileIds.slice(index, index + WEBUI_WORKSPACE_REVIEW_DIFF_BATCH_SIZE));
  }
  return batches;
}
