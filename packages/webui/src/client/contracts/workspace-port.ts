// Workspace capability port.
//
// Workspace files/dirs/archive, git mutation, working-tree review and the
// session canvas. Split from the monolithic `WebuiTransport` in the former
// `client/contracts.ts`; `transport.ts` composes it. Every method stays
// optional — `undefined` means "the operation is not wired".

import type {
  CanvasOperation,
  WebuiCanvasDocument,
} from "../../shared/contracts/canvas.js";
import type {
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceArchiveListing,
  WebuiWorkspaceDirectoryListing,
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceGitMutationRequest,
} from "../../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewFileContent,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../shared/contracts/review.js";

export interface WorkspacePort {
  readonly listWorkspaceFileTree?: (request: {
    readonly workspaceDir: string;
    readonly path?: string;
  }) => Promise<readonly WebuiWorkspaceFile[]>;
  /** One level of the local directory tree. Absent `dir` starts the walk
   * at the server user's home directory. */
  readonly browseWorkspaceDirs?: (request: {
    readonly dir?: string;
  }) => Promise<WebuiWorkspaceDirectoryListing>;
  readonly readWorkspaceFile?: (request: {
    readonly workspaceDir: string;
    readonly path: string;
  }) => Promise<WebuiWorkspaceFileContent>;
  readonly getWorkspaceEnvironment?: (request: {
    readonly workspaceDir: string;
  }) => Promise<WebuiWorkspaceEnvironment>;
  readonly mutateWorkspaceGit?: (
    request: WebuiWorkspaceGitMutationRequest,
  ) => Promise<Record<string, unknown>>;
  readonly getWorkspaceReviewSummary?: (request: { readonly workspaceDir: string }) => Promise<WebuiWorkspaceReviewSummary>;
  readonly listWorkspaceReviewFileDiffs?: (request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileIds: readonly string[] }) => Promise<WebuiWorkspaceReviewDiffs>;
  readonly getWorkspaceReviewFileContent?: (request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }) => Promise<WebuiWorkspaceReviewFileContent>;
  readonly searchWorkspaceReviewDiffs?: (request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly query: string; readonly includeUntrackedFiles: boolean; readonly pageIndex?: number; readonly pageSize?: number }) => Promise<WebuiWorkspaceReviewSearchResult>;
  readonly readCanvas?: (request: {
    readonly sessionId: string;
  }) => Promise<WebuiCanvasDocument>;
  readonly applyCanvas?: (request: {
    readonly sessionId: string;
    readonly operation: CanvasOperation;
  }) => Promise<{ readonly operationId: string; readonly document: WebuiCanvasDocument }>;
  /**
   * The streamable URL of one workspace file, credential included.
   *
   * Provided by the transport rather than assembled by a component: media and
   * HTML previews need a URL the browser fetches directly, and only the
   * transport knows the per-start token. Building it in a component would put
   * the credential in two places and let one of them drift.
   */
  readonly workspaceFileUrl?: (request: {
    readonly workspaceDir: string;
    readonly path: string;
  }) => string;
  readonly readWorkspaceArchive?: (request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly prefix?: string;
  }) => Promise<WebuiWorkspaceArchiveListing>;
  readonly extractWorkspaceArchive?: (request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly destination: string;
    readonly prefix?: string;
  }) => Promise<WebuiWorkspaceArchiveExtractResult>;
}
