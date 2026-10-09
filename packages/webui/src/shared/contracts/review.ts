export interface WebuiWorkspaceReviewFile {
  readonly fileId: string; readonly path: string; readonly originalPath?: string;
  readonly status: string; readonly type?: "text" | "binary";
  readonly additions: number; readonly deletions: number;
}
export interface WebuiWorkspaceReviewSummary {
  readonly repositoryId: string; readonly reviewSnapshotId: string;
  readonly files: readonly WebuiWorkspaceReviewFile[];
  readonly totals: { readonly files: number; readonly additions: number; readonly deletions: number };
}
export interface WebuiWorkspaceReviewFileDiff {
  readonly fileId: string; readonly errorCode?: string; readonly error?: string;
  readonly diff?: { readonly type: "text" | "binary"; readonly content: string; readonly diff?: string; readonly previewState?: string };
}
export interface WebuiWorkspaceReviewDiffs {
  readonly reviewSnapshotId: string; readonly diffs: readonly WebuiWorkspaceReviewFileDiff[];
}
export interface WebuiWorkspaceReviewFileContent {
  readonly fileId: string; readonly path: string; readonly side: "old" | "new";
  readonly type: "text" | "binary"; readonly content?: string; readonly error?: string; readonly errorCode?: string;
}
export interface WebuiWorkspaceReviewSearchResult {
  readonly reviewSnapshotId: string;
  readonly matchedFiles: readonly { readonly fileId: string; readonly path: string; readonly matchCount: number }[];
  readonly totalMatches: number; readonly totalMatchedFiles: number; readonly pageIndex: number; readonly pageSize: number;
  readonly matchesBeforePage: number; readonly hasPreviousPage: boolean; readonly hasNextPage: boolean;
}
