// The workspace query owner: one cache for the workspace file tree, file
// contents, the working-tree review (summary, file diffs and search) and the
// git environment, with request versions, loading and error state, and exact
// invalidation (plan §7.1 `application/workspace-queries.ts`; §7.6 "Workspace
// panel state"; §7.7 stage 5; ticket #51).
//
// The two problems this closes, both named in the ticket:
//
//  1. **A late response from a superseded request.** A query owner that keys
//     nothing discards nothing: the user opens file A, closes it and opens B
//     before A answers, and A's page lands in B's view. Every request stamps a
//     version against its own key; a completion applies only while its version
//     is still the live one for that key, so a superseded response is dropped
//     rather than applied. The check runs at *completion* time, because the
//     key can move (or the workspace switch) during the round trip.
//
//  2. **A mutation invalidating the wrong amount.** A commit or a
//     `workspace.git.changed` signal refreshes exactly the views that depend on
//     that working tree — the environment and the review — and leaves every
//     other workspace alone. Invalidation bumps a revision the affected views
//     key on; it does not clear a global flag or reload the world.
//
// The panel keeps display state — active tab, expanded rows, selected path,
// search box, code mode — because that is display state, not query truth. The
// component holds no store writer and calls no transport method for these
// queries: it submits a query command here and reads the snapshot.
//
// This module is framework-free — no React, no DOM, no storage — so it can be
// unit-tested against a scripted port.

import type { WorkspacePort } from "../contracts/workspace-port.js";
import type {
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
  WebuiWorkspaceGitMutationRequest,
} from "../../shared/contracts/workspace.js";
import type {
  WebuiWorkspaceReviewDiffs,
  WebuiWorkspaceReviewSearchResult,
  WebuiWorkspaceReviewSummary,
} from "../../shared/contracts/review.js";
import { mergeWorkspaceFileChildren } from "../projection/workspace-file-tree.js";

/** The transport methods this owner drives. Absent means "not wired". */
export type WebuiWorkspaceQueryPort = Pick<
  WorkspacePort,
  | "listWorkspaceFileTree"
  | "readWorkspaceFile"
  | "getWorkspaceEnvironment"
  | "mutateWorkspaceGit"
  | "getWorkspaceReviewSummary"
  | "listWorkspaceReviewFileDiffs"
  | "searchWorkspaceReviewDiffs"
>;

/** One file's read result. `content` is present once the read resolved. */
export interface WebuiWorkspaceFileContentState {
  readonly loading: boolean;
  readonly content?: WebuiWorkspaceFileContent;
  readonly error?: string;
}

/** The file-tree query: the root listing plus the per-directory loads merged
 * into it. `workspaceDir` names the tree the state belongs to, so a stale
 * workspace's late answer is recognised and dropped. */
export interface WebuiWorkspaceFileTreeState {
  readonly workspaceDir?: string;
  readonly files: readonly WebuiWorkspaceFile[];
  readonly loading: boolean;
  readonly error?: string;
  readonly loadingDirectories: ReadonlySet<string>;
  readonly loadedDirectories: ReadonlySet<string>;
  readonly directoryErrors: Readonly<Record<string, string>>;
}

/** The git-environment query for one workspace. */
export interface WebuiWorkspaceEnvironmentState {
  readonly workspaceDir?: string;
  readonly environment?: WebuiWorkspaceEnvironment;
  readonly loading: boolean;
  readonly error?: string;
}

/** The review-summary query for one tab's workspace. `stale` is set while a
 * refresh runs over a previous summary, so the UI can say so without blanking. */
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

export interface WebuiWorkspaceQueriesState {
  /**
   * Bumps when the review views for the active workspace are invalidated — a
   * commit, a git-changed signal or a stale-snapshot retry. Effects that reload
   * a review query key on it, so invalidation is an explicit, single signal
   * instead of an ad-hoc refresh token per panel.
   */
  readonly reviewRevision: number;
  /** Bumps when the environment query for the active workspace is invalidated. */
  readonly environmentRevision: number;
  readonly fileTree: WebuiWorkspaceFileTreeState;
  /** File read results, keyed by the caller's tab id. */
  readonly files: ReadonlyMap<string, WebuiWorkspaceFileContentState>;
  readonly environment: WebuiWorkspaceEnvironmentState;
  readonly reviewSummary: WebuiWorkspaceReviewSummaryState;
  readonly reviewDiffs: WebuiWorkspaceReviewDiffState;
  readonly reviewSearch: WebuiWorkspaceReviewSearchState;
}

export const initialWebuiWorkspaceFileTreeState: WebuiWorkspaceFileTreeState = {
  files: [],
  loading: false,
  loadingDirectories: new Set(),
  loadedDirectories: new Set(),
  directoryErrors: {},
};

export const initialWebuiWorkspaceEnvironmentState: WebuiWorkspaceEnvironmentState =
  { loading: false };

export const initialWebuiWorkspaceReviewSummaryState: WebuiWorkspaceReviewSummaryState =
  { loading: false };

export const initialWebuiWorkspaceReviewDiffState: WebuiWorkspaceReviewDiffState = {
  loading: false,
  diffs: {},
};

export const initialWebuiWorkspaceReviewSearchState: WebuiWorkspaceReviewSearchState =
  { loading: false };

export const initialWebuiWorkspaceQueriesState: WebuiWorkspaceQueriesState = {
  reviewRevision: 0,
  environmentRevision: 0,
  fileTree: initialWebuiWorkspaceFileTreeState,
  files: new Map(),
  environment: initialWebuiWorkspaceEnvironmentState,
  reviewSummary: initialWebuiWorkspaceReviewSummaryState,
  reviewDiffs: initialWebuiWorkspaceReviewDiffState,
  reviewSearch: initialWebuiWorkspaceReviewSearchState,
};

/** The batch size the review diff loader uses, preserved from the panel. */
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

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function withoutKey(
  record: Readonly<Record<string, string>>,
  key: string,
): Readonly<Record<string, string>> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** The children a directory load returned, or `undefined` when it was dropped. */
export type WebuiWorkspaceDirLoad = readonly WebuiWorkspaceFile[] | undefined;

export interface WebuiWorkspaceQueries {
  readonly getSnapshot: () => WebuiWorkspaceQueriesState;
  readonly subscribe: (listener: () => void) => () => void;
  /** True when a directory listing capability is wired. */
  readonly canListFileTree: boolean;
  readonly canReadFile: boolean;
  readonly canReadEnvironment: boolean;
  readonly canMutateGit: boolean;
  readonly canReview: boolean;
  readonly canSearchReviewDiffs: boolean;

  /** Reset the file tree to `workspaceDir` (a workspace switch clears the
   * previous tree's directories, errors and in-flight guards). */
  readonly selectWorkspace: (workspaceDir: string | undefined) => void;
  /** Load the root of `workspaceDir`'s file tree. */
  readonly loadFileTree: (workspaceDir: string) => void;
  /** Load one directory, merging children into the tree. Resolves with the
   * children it read, or `undefined` when the load was superseded. */
  readonly loadDirectory: (
    workspaceDir: string,
    path: string,
  ) => Promise<WebuiWorkspaceDirLoad>;

  /** Read one file into the tab's slot. Superseded reads are dropped. */
  readonly readFile: (tabId: string, workspaceDir: string, path: string) => void;
  /** Seed a tab's slot with inline content the tab already carries (the plan
   * file lives outside the workspace root, so it is not read). */
  readonly setInlineFile: (
    tabId: string,
    content: string,
    resolvedPath: string,
  ) => void;

  /** Load the review summary for a tab's workspace. Resolves with the summary
   * when it applied, or `undefined` when the load was superseded. */
  readonly loadReviewSummary: (
    tabId: string,
    workspaceDir: string,
  ) => Promise<WebuiWorkspaceReviewSummary | undefined>;
  /** Load every file's diff for one snapshot, in batches. Stale snapshots are
   * refused and trigger a review invalidation rather than applying. */
  readonly loadReviewDiffs: (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly fileIds: readonly string[];
  }) => Promise<void>;
  /** Search the diffs of one snapshot. */
  readonly searchReviewDiffs: (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly query: string;
  }) => Promise<void>;

  /** Load the git environment for one workspace. */
  readonly loadEnvironment: (workspaceDir: string) => void;
  /** Run a git mutation and invalidate exactly the views it affects: the
   * environment and review for that workspace. Resolves with the raw result. */
  readonly mutateGit: (
    request: WebuiWorkspaceGitMutationRequest,
  ) => Promise<Record<string, unknown>>;

  /**
   * Invalidate the review and environment views for one workspace in response
   * to a `workspace.git.changed` signal naming it. The environment reload is
   * coalesced (the previous 350 ms window); the review revision bumps at once.
   */
  readonly invalidateWorkspaceGit: (signal: {
    readonly workspace?: string;
    readonly aliases?: readonly string[];
  }) => void;
  /** Record a directory-level failure the loader itself did not produce (the
   * auto-navigation's "could not locate the file" message). */
  readonly reportDirectoryError: (
    workspaceDir: string,
    path: string,
    error: string,
  ) => void;
}

export function createWebuiWorkspaceQueries(deps: {
  readonly port: WebuiWorkspaceQueryPort;
}): WebuiWorkspaceQueries {
  const { port } = deps;
  let state = initialWebuiWorkspaceQueriesState;
  const listeners = new Set<() => void>();
  // One monotonic counter per request key: a completion applies only while its
  // version is the live one for that key (ticket #51 "late response discarded").
  const versions = new Map<string, number>();
  const bump = (key: string): number => {
    const next = (versions.get(key) ?? 0) + 1;
    versions.set(key, next);
    return next;
  };
  const isCurrent = (key: string, version: number): boolean =>
    (versions.get(key) ?? 0) === version;

  const set = (
    update: (current: WebuiWorkspaceQueriesState) => WebuiWorkspaceQueriesState,
  ): void => {
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const setFile = (
    tabId: string,
    value: WebuiWorkspaceFileContentState,
  ): void => {
    set((current) => {
      const files = new Map(current.files);
      files.set(tabId, value);
      return { ...current, files };
    });
  };

  // The environment reload is coalesced: a burst of git-changed signals for one
  // workspace collapses to one reload, exactly as the panel's 350 ms timer did.
  let environmentTimer: ReturnType<typeof setTimeout> | undefined;
  // Snapshot ids a stale review already retried for a tab, so a stale loop
  // cannot thrash the refresh.
  const retriedSnapshots = new Set<string>();

  const invalidateReview = (): void => {
    set((current) => ({ ...current, reviewRevision: current.reviewRevision + 1 }));
  };

  const selectWorkspace = (workspaceDir: string | undefined): void => {
    set((current) =>
      current.fileTree.workspaceDir === workspaceDir
        ? current
        : {
            ...current,
            fileTree: { ...initialWebuiWorkspaceFileTreeState, workspaceDir },
          },
    );
  };

  const loadFileTree = (workspaceDir: string): void => {
    const key = `tree:${workspaceDir}`;
    const version = bump(key);
    if (!port.listWorkspaceFileTree) {
      set((current) => ({
        ...current,
        fileTree: {
          ...initialWebuiWorkspaceFileTreeState,
          workspaceDir,
          error: "文件浏览能力暂不可用。",
        },
      }));
      return;
    }
    const listTree = port.listWorkspaceFileTree;
    set((current) => ({
      ...current,
      fileTree: {
        ...initialWebuiWorkspaceFileTreeState,
        workspaceDir,
        loading: true,
      },
    }));
    void listTree({ workspaceDir })
      .then((files) => {
        if (!isCurrent(key, version)) return;
        set((current) =>
          current.fileTree.workspaceDir === workspaceDir
            ? { ...current, fileTree: { ...current.fileTree, files, loading: false, error: undefined } }
            : current,
        );
      })
      .catch((reason: unknown) => {
        if (!isCurrent(key, version)) return;
        set((current) =>
          current.fileTree.workspaceDir === workspaceDir
            ? {
                ...current,
                fileTree: {
                  ...initialWebuiWorkspaceFileTreeState,
                  workspaceDir,
                  error: message(reason),
                },
              }
            : current,
        );
      });
  };

  const loadDirectory = async (
    workspaceDir: string,
    path: string,
  ): Promise<WebuiWorkspaceDirLoad> => {
    if (!port.listWorkspaceFileTree) {
      set((current) => ({
        ...current,
        fileTree: {
          ...current.fileTree,
          directoryErrors: {
            ...current.fileTree.directoryErrors,
            [path]: "文件夹读取能力暂不可用。",
          },
        },
      }));
      return undefined;
    }
    const key = `dir:${workspaceDir}\0${path}`;
    const version = bump(key);
    const listTree = port.listWorkspaceFileTree;
    set((current) =>
      current.fileTree.workspaceDir !== workspaceDir
        ? current
        : {
            ...current,
            fileTree: {
              ...current.fileTree,
              loadingDirectories: new Set(current.fileTree.loadingDirectories).add(path),
              directoryErrors: withoutKey(current.fileTree.directoryErrors, path),
            },
          },
    );
    try {
      const children = await listTree({ workspaceDir, path });
      if (!isCurrent(key, version)) return undefined;
      let applied: WebuiWorkspaceDirLoad;
      set((current) => {
        if (current.fileTree.workspaceDir !== workspaceDir) return current;
        applied = children;
        const loadingDirectories = new Set(current.fileTree.loadingDirectories);
        loadingDirectories.delete(path);
        return {
          ...current,
          fileTree: {
            ...current.fileTree,
            files: mergeWorkspaceFileChildren(current.fileTree.files, path, children),
            loadedDirectories: new Set(current.fileTree.loadedDirectories).add(path),
            loadingDirectories,
          },
        };
      });
      return applied;
    } catch (reason) {
      if (!isCurrent(key, version)) return undefined;
      set((current) => {
        if (current.fileTree.workspaceDir !== workspaceDir) return current;
        const loadingDirectories = new Set(current.fileTree.loadingDirectories);
        loadingDirectories.delete(path);
        return {
          ...current,
          fileTree: {
            ...current.fileTree,
            loadingDirectories,
            directoryErrors: {
              ...current.fileTree.directoryErrors,
              [path]: message(reason),
            },
          },
        };
      });
      return undefined;
    }
  };

  const readFile = (tabId: string, workspaceDir: string, path: string): void => {
    if (state.files.get(tabId)?.content) return;
    const key = `file:${tabId}`;
    const version = bump(key);
    if (!port.readWorkspaceFile) {
      setFile(tabId, { loading: false, error: "文件读取能力暂不可用。" });
      return;
    }
    const read = port.readWorkspaceFile;
    setFile(tabId, { loading: true });
    void read({ workspaceDir, path })
      .then((content) => {
        if (!isCurrent(key, version)) return;
        setFile(tabId, { loading: false, content });
      })
      .catch((reason: unknown) => {
        if (!isCurrent(key, version)) return;
        setFile(tabId, { loading: false, error: message(reason) });
      });
  };

  const setInlineFile = (tabId: string, content: string, resolvedPath: string): void => {
    // Supersede any in-flight read for this tab so a late read does not
    // overwrite the inline content the tab already carries.
    bump(`file:${tabId}`);
    setFile(tabId, {
      loading: false,
      content: { type: "text", content, resolvedPath },
    });
  };

  const refreshStaleReview = (tabId: string, snapshotId: string): void => {
    const retryKey = `${tabId}:${snapshotId}`;
    if (retriedSnapshots.has(retryKey)) return;
    retriedSnapshots.add(retryKey);
    invalidateReview();
  };

  const loadReviewSummary = async (
    tabId: string,
    workspaceDir: string,
  ): Promise<WebuiWorkspaceReviewSummary | undefined> => {
    const key = `reviewSummary:${tabId}`;
    const version = bump(key);
    if (!port.getWorkspaceReviewSummary) {
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
    const getSummary = port.getWorkspaceReviewSummary;
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

  const loadReviewDiffs = async (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly fileIds: readonly string[];
  }): Promise<void> => {
    const { tabId, workspaceDir, snapshotId, fileIds } = request;
    const key = `reviewDiffs:${tabId}`;
    const version = bump(key);
    if (!port.listWorkspaceReviewFileDiffs) {
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
    const listDiffs = port.listWorkspaceReviewFileDiffs;
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

  const searchReviewDiffs = async (request: {
    readonly tabId: string;
    readonly workspaceDir: string;
    readonly snapshotId: string;
    readonly query: string;
  }): Promise<void> => {
    const { tabId, workspaceDir, snapshotId, query } = request;
    if (!port.searchWorkspaceReviewDiffs) return;
    const key = `reviewSearch:${tabId}`;
    const version = bump(key);
    const search = port.searchWorkspaceReviewDiffs;
    set((current) => ({
      ...current,
      reviewSearch: { tabId, workspaceDir, snapshotId, loading: true },
    }));
    try {
      const result = await search({
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

  const loadEnvironment = (workspaceDir: string): void => {
    const key = `environment:${workspaceDir}`;
    const version = bump(key);
    if (!port.getWorkspaceEnvironment) return;
    const getEnvironment = port.getWorkspaceEnvironment;
    set((current) =>
      current.environment.workspaceDir === workspaceDir
        ? { ...current, environment: { ...current.environment, loading: true } }
        : { ...current, environment: { workspaceDir, loading: true } },
    );
    void getEnvironment({ workspaceDir })
      .then((environment) => {
        if (!isCurrent(key, version)) return;
        set((current) =>
          current.environment.workspaceDir === workspaceDir
            ? { ...current, environment: { workspaceDir, environment, loading: false } }
            : current,
        );
      })
      .catch((reason: unknown) => {
        if (!isCurrent(key, version)) return;
        set((current) =>
          current.environment.workspaceDir === workspaceDir
            ? { ...current, environment: { workspaceDir, loading: false, error: message(reason) } }
            : current,
        );
      });
  };

  const invalidateEnvironment = (workspaceDir: string, debounceMs: number): void => {
    // Bump the revision only: the environment panel's effect performs the one
    // reload, keyed on the revision, so a coalesced signal is one fetch rather
    // than a fetch beside the effect's own.
    const fire = (): void => {
      set((current) =>
        current.environment.workspaceDir === workspaceDir
          ? { ...current, environmentRevision: current.environmentRevision + 1 }
          : current,
      );
    };
    if (environmentTimer !== undefined) clearTimeout(environmentTimer);
    if (debounceMs <= 0) {
      fire();
      return;
    }
    environmentTimer = setTimeout(fire, debounceMs);
  };

  const mutateGit = async (
    request: WebuiWorkspaceGitMutationRequest,
  ): Promise<Record<string, unknown>> => {
    if (!port.mutateWorkspaceGit) return {};
    const result = await port.mutateWorkspaceGit(request);
    // Exactly the views this mutation affects: the git environment and the
    // review of the workspace it ran in. Nothing else reloads.
    invalidateEnvironment(request.workspaceDir, 0);
    invalidateReview();
    return result;
  };

  const reportDirectoryError = (
    workspaceDir: string,
    path: string,
    error: string,
  ): void => {
    set((current) =>
      current.fileTree.workspaceDir !== workspaceDir
        ? current
        : {
            ...current,
            fileTree: {
              ...current.fileTree,
              directoryErrors: { ...current.fileTree.directoryErrors, [path]: error },
            },
          },
    );
  };

  const invalidateWorkspaceGit = (signal: {
    readonly workspace?: string;
    readonly aliases?: readonly string[];
  }): void => {
    const matches = (workspaceDir: string | undefined): boolean =>
      workspaceDir !== undefined &&
      (signal.workspace === workspaceDir || Boolean(signal.aliases?.includes(workspaceDir)));
    // Review views for the workspace the signal names, at once.
    if (matches(state.reviewSummary.workspaceDir)) invalidateReview();
    // The environment reload is coalesced into the previous 350 ms window.
    if (matches(state.environment.workspaceDir)) {
      invalidateEnvironment(state.environment.workspaceDir!, 350);
    }
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canListFileTree: port.listWorkspaceFileTree !== undefined,
    canReadFile: port.readWorkspaceFile !== undefined,
    canReadEnvironment: port.getWorkspaceEnvironment !== undefined,
    canMutateGit: port.mutateWorkspaceGit !== undefined,
    canReview: port.getWorkspaceReviewSummary !== undefined,
    canSearchReviewDiffs: port.searchWorkspaceReviewDiffs !== undefined,
    selectWorkspace,
    loadFileTree,
    loadDirectory,
    readFile,
    setInlineFile,
    loadReviewSummary,
    loadReviewDiffs,
    searchReviewDiffs,
    loadEnvironment,
    mutateGit,
    reportDirectoryError,
    invalidateWorkspaceGit,
  };
}
