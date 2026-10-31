// The workspace files owner.
//
// The file tree and the file contents are one resource: both are keyed by the
// workspace directory and the tab, both are read through the workspace port, and
// both invalidate together when the workspace changes. They used to share an owner
// with the environment and the review; the review left first, then the environment.
// What is left here is the file half.
//
// The mixed owner composes this slice with the other two on read, so the panels
// keep reading one snapshot.

import type {
  WebuiWorkspaceDirectoryListing,
  WebuiWorkspaceFile,
  WebuiWorkspaceFileContent,
} from "../../../../shared/contracts/workspace.js";
import { mergeWorkspaceFileChildren } from "../projection/workspace-file-tree.js";

/** The transport methods this owner drives. Absent means "not wired". */
export interface WebuiWorkspaceFilesPort {
  readonly listWorkspaceFileTree?: (request: {
    readonly workspaceDir: string;
    /** A directory to list; absent means the tree's root. */
    readonly path?: string;
  }) => Promise<readonly WebuiWorkspaceFile[]>;
  readonly browseWorkspaceDirs?: (request: {
    readonly dir?: string;
  }) => Promise<WebuiWorkspaceDirectoryListing>;
  readonly readWorkspaceFile?: (request: {
    readonly workspaceDir: string;
    readonly path: string;
  }) => Promise<WebuiWorkspaceFileContent>;
}

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

/** The directory picker's listing: one answer, its freshness, its failure. */
export type WebuiDirectoryBrowseState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly listing: WebuiWorkspaceDirectoryListing }
  | { readonly status: "error"; readonly error: string };

export interface WebuiWorkspaceFilesState {
  readonly fileTree: WebuiWorkspaceFileTreeState;
  /** The directory browser's listing: the view renders, the owner reads. */
  readonly directoryBrowse: WebuiDirectoryBrowseState;
  /** File read results, keyed by the caller's tab id. */
  readonly files: ReadonlyMap<string, WebuiWorkspaceFileContentState>;
}

export const initialWebuiWorkspaceFileTreeState: WebuiWorkspaceFileTreeState = {
  files: [],
  loading: false,
  loadingDirectories: new Set(),
  loadedDirectories: new Set(),
  directoryErrors: {},
};

/** The slice this module owns; the review slice is merged in from its owner. */
type WebuiWorkspaceLocalState = Omit<
  WebuiWorkspaceFilesState,
  | "reviewRevision"
  | "reviewSummary"
  | "reviewDiffs"
  | "reviewSearch"
  | "environment"
  | "environmentRevision"
>;

export const initialWebuiWorkspaceFilesState: WebuiWorkspaceFilesState = {
  fileTree: initialWebuiWorkspaceFileTreeState,
  files: new Map(),
  directoryBrowse: { status: "idle" },
};

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

/**
 * Coerce a directory listing off the wire before it reaches the state.
 *
 * The transport resolves the server body verbatim (`resolve(frame.body as T)`
 * in `client/platform/transport.ts`), so a body that is missing `entries` — or
 * is not a listing at all — reaches the view, where `listing?.entries.length`
 * throws `Cannot read properties of undefined (reading 'length')` and the
 * whole app tree falls into the error boundary. The `?.` stopped one level
 * too early: it guarded `listing` and left `entries` bare.
 *
 * Normalising at the door means the view can read the listing it was given
 * without re-checking the wire's shape at every use, and a malformed answer
 * degrades to an empty directory rather than to a blank page.
 */
function normalizeDirectoryListing(
  value: WebuiWorkspaceDirectoryListing,
): WebuiWorkspaceDirectoryListing {
  const raw = value as Partial<WebuiWorkspaceDirectoryListing> | null;
  return {
    dir: typeof raw?.dir === "string" ? raw.dir : "",
    parent: typeof raw?.parent === "string" ? raw.parent : undefined,
    entries: Array.isArray(raw?.entries) ? raw.entries : [],
    truncated: raw?.truncated === true,
  };
}

/** The children a directory load returned, or `undefined` when it was dropped. */
export type WebuiWorkspaceDirLoad = readonly WebuiWorkspaceFile[] | undefined;

export interface WebuiWorkspaceFilesOwner {
  readonly state: () => WebuiWorkspaceFilesState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly canListFileTree: boolean;
  readonly canReadFile: boolean;
  readonly selectWorkspace: (workspaceDir: string | undefined) => void;
  readonly loadFileTree: (workspaceDir: string) => void;
  readonly loadDirectory: (workspaceDir: string, path: string) => Promise<WebuiWorkspaceDirLoad>;
  readonly readFile: (tabId: string, workspaceDir: string, path: string) => void;
  readonly setInlineFile: (tabId: string, content: string, resolvedPath: string) => void;
  /**
   * Release one tab: supersede its in-flight read and drop the content it held.
   * A closed tab has no reader left, so neither a late answer nor the bytes it
   * already carries belong to anything.
   */
  readonly discardTab: (tabId: string) => void;
  readonly canBrowseDirectories: boolean;
  /**
   * List one directory (absent means the runtime's default root). A browse that
   * answers after a newer one is dropped, so fast navigation cannot show the
   * wrong directory.
   */
  readonly browse: (dir?: string) => void;
  readonly reportDirectoryError: (workspaceDir: string, path: string, error: string) => void;
  readonly dispose: () => void;
}

export function createWebuiWorkspaceFilesOwner(deps: {
  readonly port: WebuiWorkspaceFilesPort;
}): WebuiWorkspaceFilesOwner {
  const { port } = deps;
  let state = initialWebuiWorkspaceFilesState;
  const listeners = new Set<() => void>();
  const versions = new Map<string, number>();
  const bump = (key: string): number => {
    const next = (versions.get(key) ?? 0) + 1;
    versions.set(key, next);
    return next;
  };
  const isCurrent = (key: string, version: number): boolean =>
    (versions.get(key) ?? 0) === version;

  const set = (
    update: (current: WebuiWorkspaceFilesState) => WebuiWorkspaceFilesState,
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
      .then((answer) => {
        if (!isCurrent(key, version)) return;
        // The panel renders the tree it is handed, so an answer that is not a
        // tree must not reach it: it becomes an error state instead of a
        // "files is not iterable" crash inside the render.
        const files = Array.isArray(answer) ? answer : undefined;
        set((current) =>
          current.fileTree.workspaceDir === workspaceDir
            ? {
                ...current,
                fileTree: files
                  ? { ...current.fileTree, files, loading: false, error: undefined }
                  : {
                      ...initialWebuiWorkspaceFileTreeState,
                      workspaceDir,
                      error: "工作区文件列表返回了意外的结果。",
                    },
              }
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

  /**
   * Reads a file into the cache.
   *
   * The first argument is the **cache key**, not a tab id: the cache is keyed
   * by what the tab is showing, so a tab that changed from one file to another
   * reads the new one instead of keeping the old one's result.
   */
  const readFile = (cacheKey: string, workspaceDir: string, path: string): void => {
    if (state.files.get(cacheKey)?.content) return;
    const key = `file:${cacheKey}`;
    const version = bump(key);
    if (!port.readWorkspaceFile) {
      setFile(cacheKey, { loading: false, error: "文件读取能力暂不可用。" });
      return;
    }
    const read = port.readWorkspaceFile;
    setFile(cacheKey, { loading: true });
    void read({ workspaceDir, path })
      .then((content) => {
        if (!isCurrent(key, version)) return;
        setFile(cacheKey, { loading: false, content });
      })
      .catch((reason: unknown) => {
        if (!isCurrent(key, version)) return;
        setFile(cacheKey, { loading: false, error: message(reason) });
      });
  };

  const setInlineFile = (cacheKey: string, content: string, resolvedPath: string): void => {
    // Supersede any in-flight read for this tab so a late read does not
    // overwrite the inline content the tab already carries.
    bump(`file:${cacheKey}`);
    setFile(cacheKey, {
      loading: false,
      content: { type: "text", content, resolvedPath },
    });
  };

  let browseSeq = 0;
  const browse = (dir?: string): void => {
    const browseDirs = port.browseWorkspaceDirs;
    const mine = ++browseSeq;
    if (!browseDirs) {
      set((current) => ({
        ...current,
        directoryBrowse: { status: "error", error: "当前运行时不支持浏览目录。" },
      }));
      return;
    }
    set((current) => ({ ...current, directoryBrowse: { status: "loading" } }));
    void browseDirs(dir ? { dir } : {})
      .then((answer) => {
        if (mine !== browseSeq) return;
        const listing = normalizeDirectoryListing(answer);
        set((current) => ({ ...current, directoryBrowse: { status: "ready", listing } }));
      })
      .catch((reason: unknown) => {
        if (mine !== browseSeq) return;
        set((current) => ({
          ...current,
          directoryBrowse: { status: "error", error: message(reason) },
        }));
      });
  };

  const discardTab = (tabId: string): void => {
    bump(`file:${tabId}`);
    set((current) => {
      if (!current.files.has(tabId)) return current;
      const files = new Map(current.files);
      files.delete(tabId);
      return { ...current, files };
    });
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

  return {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canListFileTree: port.listWorkspaceFileTree !== undefined,
    canReadFile: port.readWorkspaceFile !== undefined,
    selectWorkspace,
    loadFileTree,
    loadDirectory,
    readFile,
    setInlineFile,
    discardTab,
    canBrowseDirectories: port.browseWorkspaceDirs !== undefined,
    browse,
    reportDirectoryError,
    dispose: () => {
      listeners.clear();
    },
  };
}
