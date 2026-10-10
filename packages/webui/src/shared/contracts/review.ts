// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiWorkspaceReviewFile` | One changed file in a review summary. | Runtime `getWorkspaceReviewSummary` (`runtime/harness/workspace.ts`; CliService). | unverified — nested in `WebuiWorkspaceReviewSummary.files`; no direct importer. |
// | `WebuiWorkspaceReviewSummary` | A working-tree review snapshot (files plus totals). | Runtime `getWorkspaceReviewSummary`. | `client/contracts/workspace-port.ts`; `client/components/WorkspacePanels.tsx`; `server/operation/workspace.ts`. |
// | `WebuiWorkspaceReviewFileDiff` | One file's diff/error inside a review-diffs result. | Runtime `listWorkspaceReviewFileDiffs` (`runtime/harness/workspace.ts`). | `client/components/SettingsModal.tsx`. |
// | `WebuiWorkspaceReviewDiffs` | A batch of per-file review diffs for one snapshot. | Runtime `listWorkspaceReviewFileDiffs`. | `client/contracts/workspace-port.ts`; `client/components/WorkspacePanels.tsx`. |
// | `WebuiWorkspaceReviewFileContent` | One file's old/new content for review. | Runtime `getWorkspaceReviewFileContent` (`runtime/harness/workspace.ts`). | `client/contracts/workspace-port.ts`. |
// | `WebuiWorkspaceReviewSearchResult` | Paginated in-diff search results for a review snapshot. | Runtime `searchWorkspaceReviewDiffs` (`runtime/harness/workspace.ts`). | `client/contracts/workspace-port.ts`; `client/components/WorkspacePanels.tsx`. |
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
