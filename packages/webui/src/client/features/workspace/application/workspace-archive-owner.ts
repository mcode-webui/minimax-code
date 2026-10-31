// The workspace archive owner.
//
// Reading an archive and extracting it are two commands with their own outcomes,
// and the listing is a resource keyed by what it names: the workspace, the archive
// path and the prefix inside it. The view used to hold all of that in its own
// component state, which meant a late answer for a prefix the user had already left
// could land on top of the current one. Here the key and its version decide, so a
// superseded listing is dropped by the same rule the file reads use.
//
// The archive *parser* is not here. This owner holds the command outcomes and the
// freshness of one listing.

import type {
  WebuiWorkspaceArchiveExtractResult,
  WebuiWorkspaceArchiveListing,
} from "../../../../shared/contracts/workspace.js";

export interface WebuiWorkspaceArchivePort {
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

export type WebuiArchiveListingState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly listing: WebuiWorkspaceArchiveListing }
  | { readonly status: "error"; readonly error: string };

export type WebuiArchiveExtractState =
  | { readonly status: "idle" }
  | { readonly status: "extracting" }
  | { readonly status: "done"; readonly result: WebuiWorkspaceArchiveExtractResult }
  | { readonly status: "error"; readonly error: string };

export interface WebuiWorkspaceArchiveState {
  /** The identity the listing belongs to, so a reader can tell whose answer it is. */
  readonly key?: string;
  readonly listing: WebuiArchiveListingState;
  readonly extract: WebuiArchiveExtractState;
}

export const initialWebuiWorkspaceArchiveState: WebuiWorkspaceArchiveState = {
  listing: { status: "idle" },
  extract: { status: "idle" },
};

export interface WebuiWorkspaceArchiveOwner {
  readonly state: () => WebuiWorkspaceArchiveState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly canRead: boolean;
  readonly canExtract: boolean;
  /** Read one archive listing. A superseded read (a different key) is dropped. */
  readonly read: (request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly prefix?: string;
  }) => void;
  readonly extract: (request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly destination: string;
    readonly prefix?: string;
  }) => Promise<void>;
  readonly dispose: () => void;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function archiveKey(request: {
  readonly workspaceDir: string;
  readonly path: string;
  readonly prefix?: string;
}): string {
  return `${request.workspaceDir}\u0000${request.path}\u0000${request.prefix ?? ""}`;
}

export function createWebuiWorkspaceArchiveOwner(deps: {
  readonly port: WebuiWorkspaceArchivePort;
}): WebuiWorkspaceArchiveOwner {
  const { port } = deps;
  let state = initialWebuiWorkspaceArchiveState;
  const listeners = new Set<() => void>();
  let version = 0;

  const set = (update: (current: WebuiWorkspaceArchiveState) => WebuiWorkspaceArchiveState): void => {
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const read = (request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly prefix?: string;
  }): void => {
    const readArchive = port.readWorkspaceArchive;
    const key = archiveKey(request);
    if (!readArchive) {
      set(() => ({
        key,
        listing: { status: "error", error: "当前运行时不支持读取压缩包。" },
        extract: { status: "idle" },
      }));
      return;
    }
    version += 1;
    const mine = version;
    set((current) => ({
      key,
      listing: { status: "loading" },
      // An extract outcome belongs to the listing it ran against, so a *different*
      // archive clears it rather than showing a stale result beside new contents.
      extract: current.key === key ? current.extract : { status: "idle" },
    }));
    void readArchive(request)
      .then((listing) => {
        if (mine !== version) return;
        set((current) => ({ ...current, listing: { status: "ready", listing } }));
      })
      .catch((reason: unknown) => {
        if (mine !== version) return;
        set((current) => ({ ...current, listing: { status: "error", error: message(reason) } }));
      });
  };

  const extract = async (request: {
    readonly workspaceDir: string;
    readonly path: string;
    readonly destination: string;
    readonly prefix?: string;
  }): Promise<void> => {
    const extractArchive = port.extractWorkspaceArchive;
    if (!extractArchive) {
      set((current) => ({
        ...current,
        extract: { status: "error", error: "当前运行时不支持解压。" },
      }));
      return;
    }
    set((current) => ({ ...current, extract: { status: "extracting" } }));
    try {
      const result = await extractArchive(request);
      set((current) => ({ ...current, extract: { status: "done", result } }));
    } catch (reason: unknown) {
      set((current) => ({ ...current, extract: { status: "error", error: message(reason) } }));
    }
  };

  return {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canRead: port.readWorkspaceArchive !== undefined,
    canExtract: port.extractWorkspaceArchive !== undefined,
    read,
    extract,
    dispose: () => {
      listeners.clear();
    },
  };
}
