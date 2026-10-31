// The narrow owner contracts the Workspace facade hands out.
//
// The facade is one object because the panels render one composition. It is not
// one object because every reader wants every resource: the composer renders a
// file tree, the directory browser renders two resources at once, and the canvas
// reads a canvas. Handing each of them the whole facade meant a capability added
// to Archive was, in the type system, a member every consumer had gained — which
// is the coupling this file exists to break.
//
// What each contract names is what its reader *renders*. A reader that grows a
// new resource gets a new contract, not a wider one; a resource that grows a
// capability widens only itself.
//
// The composed panel surface stays, because the panel genuinely combines
// resources and has a real composite presentation to draw. What it composes is
// these contracts rather than a flat re-declaration of them.

import type { WebuiWorkspaceGitMutationRequest } from "../../../../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceDirLoad,
  WebuiWorkspaceFilesPort,
} from "./workspace-files-owner.js";
import type { WebuiWorkspaceArchiveOwner } from "./workspace-archive-owner.js";
import type { WebuiWorkspaceCanvasOwner } from "./workspace-canvas-owner.js";
import type { WebuiWorkspacePanelOwner } from "./workspace-panel-owner.js";
import type { WebuiWorkspaceReviewSummaryState } from "../../review/contracts/workspace-review.js";

export type { WebuiWorkspaceFilesPort };

/** The working tree: the tree itself, and the file slots opened from it. */
export interface WebuiWorkspaceFilesCommands {
  readonly canListFileTree: boolean;
  readonly canReadFile: boolean;
  readonly selectWorkspace: (workspaceDir: string | undefined) => void;
  readonly loadFileTree: (workspaceDir: string) => void;
  readonly loadDirectory: (workspaceDir: string, path: string) => Promise<WebuiWorkspaceDirLoad>;
  /**
   * Reads a file into the cache.
   *
   * The first argument is the **cache key** — what the tab is showing — not a
   * tab id. The cache is keyed that way because a tab's id is stable and its
   * content is not: a tab that changed from one file to another has to read
   * the new one rather than keep the old one's result.
   */
  readonly readFile: (cacheKey: string, workspaceDir: string, path: string) => void;
  /** Files an inline text under the same cache key a read would use. */
  readonly setInlineFile: (cacheKey: string, content: string, resolvedPath: string) => void;
  /** Release a closed tab's file slot and its read commit rights. */
  readonly discardFileTab: (tabId: string) => void;
  /** List one directory for the workspace picker (superseded browses dropped). */
  readonly browseWorkspaceDirs: (dir?: string) => void;
  readonly canBrowseWorkspaceDirs: boolean;
  /** A directory read that failed, for the owner to surface against that path. */
  readonly reportDirectoryError: (
    workspaceDir: string,
    path: string,
    error: string,
  ) => void;
}

/**
 * The environment around the files: the git working tree and the directory
 * browser. Separate from Files because a capability here — mutating git, say —
 * has nothing to do with opening a file, and a reader of one must not gain it.
 */
export interface WebuiWorkspaceEnvironmentCommands {
  readonly canReadEnvironment: boolean;
  readonly canMutateGit: boolean;
  readonly loadEnvironment: (workspaceDir: string) => void;
  readonly mutateGit: (
    request: WebuiWorkspaceGitMutationRequest,
  ) => Promise<Record<string, unknown>>;
}

/** The diff surface: a snapshot's summary, its file diffs, and a search. */
export interface WebuiWorkspaceReviewCommands {
  readonly canReview: boolean;
  readonly canSearchReviewDiffs: boolean;
  /** Bumped when what the review reads became untrue. */
  readonly invalidateReview: () => void;
  readonly loadReviewSummary: (
    tabId: string,
    workspaceDir: string,
  ) => Promise<WebuiWorkspaceReviewSummaryState["summary"]>;
  readonly loadReviewDiffs: (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly fileIds: readonly string[];
  }) => Promise<void>;
  readonly searchReviewDiffs: (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly query: string;
  }) => Promise<void>;
}

/** Reading and extracting an archive. */
export interface WebuiWorkspaceArchiveCommands {
  readonly canReadArchive: boolean;
  readonly canExtractArchive: boolean;
  /** Read one archive listing (superseded reads are dropped). */
  readonly readArchive: WebuiWorkspaceArchiveOwner["read"];
  /** Extract one archive; the outcome is the owner's, not a component's. */
  readonly extractArchive: WebuiWorkspaceArchiveOwner["extract"];
}

/** The session's canvas document and its operations. */
export interface WebuiWorkspaceCanvasCommands {
  readonly canReadCanvas: boolean;
  readonly canApplyCanvas: boolean;
  /** Read the session's canvas document (a session already left is dropped). */
  readonly readCanvas: WebuiWorkspaceCanvasOwner["read"];
  /** Run one canvas operation; resolves `true` when it landed. */
  readonly applyCanvas: WebuiWorkspaceCanvasOwner["apply"];
}

/**
 * The one contract that genuinely combines resources.
 *
 * The panel is the surface where the composition is the product: it shows files
 * beside a diff beside a canvas, and its presentation is the thing being tested.
 * It therefore gets every resource, and it gets them *as these contracts* — so a
 * capability added to one resource still appears here exactly once, and the
 * composition root stays the only place that knows the five are related.
 */
export interface WebuiWorkspacePanelSurface
  extends WebuiWorkspaceFilesCommands,
    WebuiWorkspaceEnvironmentCommands,
    WebuiWorkspaceReviewCommands,
    WebuiWorkspaceArchiveCommands,
    WebuiWorkspaceCanvasCommands {
  /**
   * The panel/tab owner. Its state is keyed by session and is not part of the
   * composed snapshot: a surface subscribes to the session it shows.
   */
  readonly panel: WebuiWorkspacePanelOwner;
}
