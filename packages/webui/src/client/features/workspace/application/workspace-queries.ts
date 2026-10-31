// The workspace composer.
//
// This module owns no resource of its own: the file tree and contents, the git
// environment and the review each have their own owner. The panels read ONE
// snapshot, so this composes the sub-slices on read and forwards every command —
// composing the submodule APIs rather than reimplementing their policy.
//
// It keeps exactly two things: the git-changed fan-out (one signal, the owners it
// names) and the composed snapshot's identity, which `useSyncExternalStore`
// compares.

import type {
  WebuiWorkspaceFile,
  WebuiWorkspaceGitMutationRequest,
} from "../../../../shared/contracts/workspace.js";
import {
  createWebuiWorkspaceFilesOwner,
  initialWebuiWorkspaceFilesState,
  type WebuiWorkspaceDirLoad,
  type WebuiWorkspaceFilesPort,
  type WebuiWorkspaceFilesState,
  type WebuiWorkspaceFileTreeState,
} from "./workspace-files-owner.js";
import {
  createWebuiWorkspaceEnvironmentOwner,
  initialWebuiWorkspaceEnvironmentState,
  type WebuiWorkspaceEnvironmentOwner,
  type WebuiWorkspaceEnvironmentPort,
} from "./workspace-environment-owner.js";
import type { WebuiWorkspaceReviewOwner } from "../../review/application/workspace-review-owner.public.js";
import {
  createWebuiWorkspacePanelOwner,
  type WebuiWorkspacePanelOwner,
} from "./workspace-panel-owner.js";
import {
  createWebuiWorkspaceCanvasOwner,
  initialWebuiWorkspaceCanvasState,
  type WebuiWorkspaceCanvasOwner,
  type WebuiWorkspaceCanvasPort,
  type WebuiWorkspaceCanvasState,
} from "./workspace-canvas-owner.js";
import {
  createWebuiWorkspaceArchiveOwner,
  initialWebuiWorkspaceArchiveState,
  type WebuiWorkspaceArchiveOwner,
  type WebuiWorkspaceArchivePort,
  type WebuiWorkspaceArchiveState,
} from "./workspace-archive-owner.js";
import {
  initialWebuiWorkspaceReviewState,
  type WebuiWorkspaceReviewPort,
  type WebuiWorkspaceReviewSummaryState,
} from "../../review/contracts/workspace-review.js";

export type {
  WebuiWorkspaceArchiveCommands,
  WebuiWorkspaceCanvasCommands,
  WebuiWorkspaceEnvironmentCommands,
  WebuiWorkspaceFilesCommands,
  WebuiWorkspacePanelSurface,
  WebuiWorkspaceReviewCommands,
} from "./workspace-owner-contracts.js";
export { initialWebuiWorkspaceFileTreeState } from "./workspace-files-owner.js";
export type {
  WebuiWorkspaceFileContentState,
  WebuiWorkspaceFileTreeState,
  WebuiWorkspaceDirLoad,
} from "./workspace-files-owner.js";
export type { WebuiWorkspaceEnvironmentState } from "./workspace-environment-owner.js";
export type { WebuiWorkspaceReviewPort };

/** Every capability the workspace surfaces read, in one port. */
export interface WebuiWorkspaceQueryPort
  extends WebuiWorkspaceFilesPort,
    WebuiWorkspaceEnvironmentPort,
    WebuiWorkspaceArchivePort,
    WebuiWorkspaceCanvasPort,
    WebuiWorkspaceReviewPort {}

export interface WebuiWorkspaceQueriesState {
  readonly reviewRevision: number;
  readonly fileTree: WebuiWorkspaceFileTreeState;
  readonly environmentRevision: number;
  readonly environment: import("./workspace-environment-owner.js").WebuiWorkspaceEnvironmentState;
  readonly files: ReadonlyMap<string, import("./workspace-files-owner.js").WebuiWorkspaceFileContentState>;
  /** The directory picker's listing (the files owner's slice). */
  readonly directoryBrowse: import("./workspace-files-owner.js").WebuiDirectoryBrowseState;
  /** The archive owner's slice: one listing and one extract outcome. */
  readonly archive: WebuiWorkspaceArchiveState;
  /** The canvas owner's slice: the session's document and the last outcome. */
  readonly canvas: WebuiWorkspaceCanvasState;
  readonly reviewSummary: WebuiWorkspaceReviewSummaryState;
  readonly reviewDiffs: import("../../review/contracts/workspace-review.js").WebuiWorkspaceReviewDiffState;
  readonly reviewSearch: import("../../review/contracts/workspace-review.js").WebuiWorkspaceReviewSearchState;
}

/**
 * The composition root, and the only object that knows all five resources exist.
 *
 * It is private on purpose. Readers take one of the narrow contracts — `files`,
 * `environment`, `review`, `archive`, `canvas` — and the panel takes the composed
 * surface. What stays here is exactly what crosses resources: the composed
 * snapshot the panels subscribe to, the git-changed fan-out, and disposal.
 */
import type {
  WebuiWorkspaceArchiveCommands,
  WebuiWorkspaceCanvasCommands,
  WebuiWorkspaceEnvironmentCommands,
  WebuiWorkspaceFilesCommands,
  WebuiWorkspacePanelSurface,
  WebuiWorkspaceReviewCommands,
} from "./workspace-owner-contracts.js";

export interface WebuiWorkspaceQueries {
  readonly getSnapshot: () => WebuiWorkspaceQueriesState;
  readonly subscribe: (listener: () => void) => () => void;
  /** The file tree and the file slots opened from it. */
  readonly files: WebuiWorkspaceFilesCommands;
  /** The git working tree. */
  readonly environment: WebuiWorkspaceEnvironmentCommands;
  readonly review: WebuiWorkspaceReviewCommands;
  readonly archive: WebuiWorkspaceArchiveCommands;
  readonly canvas: WebuiWorkspaceCanvasCommands;
  /** The panel/tab owner, for a surface whose presentation *is* the composition. */
  readonly panel: WebuiWorkspacePanelOwner;
  /**
   * Release every workspace resource scoped to one session.
   *
   * Cross-resource by nature — the session is not a workspace concept, so no
   * single resource contract owns this — which is why it lives on the root beside
   * the git fan-out. A deleted session's canvas document is released with it; a
   * resource keyed by workspace or tab rather than by session keeps its state,
   * because nothing about it became false.
   */
  readonly releaseSession: (sessionId: string) => void;
  /**
   * One workspace-git signal, the owners it names. This is the one place a fact
   * about one resource reaches another, which is why it belongs to the root and
   * not to any of the five.
   */
  readonly invalidateWorkspaceGit: (signal: {
    readonly workspace?: string;
    readonly aliases?: readonly string[];
  }) => void;
  /** Tear down every owner, in the order the root built them. */
  readonly dispose: () => void;
}

/** The panel's contract: every resource, because the panel composes them. */
export type WebuiWorkspaceComposedPanel = WebuiWorkspacePanelSurface;

/** What a reader gets for the resource it renders. */
export type WebuiWorkspaceReader<T extends keyof WebuiWorkspaceQueries> =
  T extends "files" | "environment" | "review" | "archive" | "canvas" ? WebuiWorkspaceQueries[T] : never;

export const initialWebuiWorkspaceQueriesState: WebuiWorkspaceQueriesState = {
  ...initialWebuiWorkspaceFilesState,
  ...initialWebuiWorkspaceReviewState,
  environment: initialWebuiWorkspaceEnvironmentState,
  environmentRevision: 0,
  archive: initialWebuiWorkspaceArchiveState,
  canvas: initialWebuiWorkspaceCanvasState,
};

export function createWebuiWorkspaceQueries(deps: {
  readonly port: WebuiWorkspaceQueryPort;
  /**
   * The review resource, composed at the lifetime seam.
   *
   * Workspace keeps the git/review coordination, but it does not **build** the
   * review owner: the composition root constructs it and hands over the semantic
   * interface, so this module composes an existing resource instead of importing
   * a peer's factory and becoming a second construction site for it.
   */
  readonly review: WebuiWorkspaceReviewOwner;
}): WebuiWorkspaceQueries {
  const { port } = deps;
  const files = createWebuiWorkspaceFilesOwner({ port });
  const review = deps.review;
  const archive = createWebuiWorkspaceArchiveOwner({ port });
  const canvas = createWebuiWorkspaceCanvasOwner({ port });
  const panel = createWebuiWorkspacePanelOwner();
  const environment: WebuiWorkspaceEnvironmentOwner =
    createWebuiWorkspaceEnvironmentOwner({
      port,
      invalidateReview: () => review.invalidate(),
    });

  const listeners = new Set<() => void>();
  const compose = (): void => {
    snapshot = {
      ...files.state(),
      ...review.read(),
      environment: environment.state(),
      environmentRevision: environment.revision(),
      archive: archive.state(),
      canvas: canvas.state(),
    };
  };
  let snapshot: WebuiWorkspaceQueriesState = {
    ...files.state(),
    ...review.read(),
    environment: environment.state(),
    environmentRevision: environment.revision(),
    archive: archive.state(),
    canvas: canvas.state(),
  };
  const notify = (): void => {
    compose();
    for (const listener of [...listeners]) listener();
  };
  files.subscribe(notify);
  review.subscribe(notify);
  environment.subscribe(notify);
  archive.subscribe(notify);
  canvas.subscribe(notify);

  const invalidateWorkspaceGit = (signal: {
    readonly workspace?: string;
    readonly aliases?: readonly string[];
  }): void => {
    const matches = (workspaceDir: string | undefined): boolean =>
      workspaceDir !== undefined &&
      (signal.workspace === workspaceDir || Boolean(signal.aliases?.includes(workspaceDir)));
    // Review views for the workspace the signal names, at once.
    review.invalidateForWorkspace(signal);
    // The environment reload is coalesced into the previous 350 ms window.
    const workspaceDir = environment.state().workspaceDir;
    if (matches(workspaceDir)) environment.invalidate(workspaceDir!, 350);
  };

  // The five narrow contracts, each bound to the one owner that implements it.
  // A reader takes the one it renders; the panel takes all five, and the root
  // below keeps only what crosses resources.
  const filesCommands: WebuiWorkspaceFilesCommands = {
    canListFileTree: files.canListFileTree,
    canReadFile: files.canReadFile,
    selectWorkspace: files.selectWorkspace,
    loadFileTree: files.loadFileTree,
    loadDirectory: files.loadDirectory,
    readFile: files.readFile,
    setInlineFile: files.setInlineFile,
    discardFileTab: files.discardTab,
    browseWorkspaceDirs: files.browse,
    canBrowseWorkspaceDirs: files.canBrowseDirectories,
    reportDirectoryError: files.reportDirectoryError,
  };
  const environmentCommands: WebuiWorkspaceEnvironmentCommands = {
    canReadEnvironment: environment.canReadEnvironment,
    canMutateGit: environment.canMutateGit,
    loadEnvironment: environment.load,
    mutateGit: environment.mutateGit,
  };
  const reviewCommands: WebuiWorkspaceReviewCommands = {
    canReview: review.canReview,
    canSearchReviewDiffs: review.canSearchDiffs,
    invalidateReview: review.invalidate,
    loadReviewSummary: review.loadSummary,
    loadReviewDiffs: review.loadDiffs,
    searchReviewDiffs: review.search,
  };
  const archiveCommands: WebuiWorkspaceArchiveCommands = {
    canReadArchive: archive.canRead,
    canExtractArchive: archive.canExtract,
    readArchive: archive.read,
    extractArchive: archive.extract,
  };
  const canvasCommands: WebuiWorkspaceCanvasCommands = {
    canReadCanvas: canvas.canRead,
    canApplyCanvas: canvas.canApply,
    readCanvas: canvas.read,
    applyCanvas: canvas.apply,
  };
  const releaseSession = (sessionId: string): void => {
    canvas.release(sessionId);
  };
  const dispose = (): void => {
    files.dispose();
    archive.dispose();
    canvas.dispose();
    panel.dispose();
    environment.dispose();
    listeners.clear();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    files: filesCommands,
    environment: environmentCommands,
    review: reviewCommands,
    archive: archiveCommands,
    canvas: canvasCommands,
    panel,
    releaseSession,
    invalidateWorkspaceGit,
    dispose,
  };
}
