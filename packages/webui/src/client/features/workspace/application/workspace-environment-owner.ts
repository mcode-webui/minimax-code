// The workspace environment owner.
//
// The git environment of one workspace is its own resource: it is keyed by the
// workspace directory, it is invalidated by its own signals, and its reload is
// coalesced into one window. It used to share an owner with the file tree, the
// file contents and the review — four concerns with four identities and four
// invalidations. The review half is its own owner; this is the environment half.
//
// What stays behind is the *composition*: the panels read one snapshot, so the
// mixed owner merges this slice on read, exactly as it merges the review's.

import type {
  WebuiWorkspaceEnvironment,
  WebuiWorkspaceGitMutationRequest,
} from "../../../../shared/contracts/workspace.js";

/** The transport methods this owner drives. Absent means "not wired". */
export interface WebuiWorkspaceEnvironmentPort {
  readonly getWorkspaceEnvironment?: (request: {
    readonly workspaceDir: string;
  }) => Promise<WebuiWorkspaceEnvironment>;
  readonly mutateWorkspaceGit?: (
    request: WebuiWorkspaceGitMutationRequest,
  ) => Promise<Record<string, unknown>>;
}

/** The git-environment query for one workspace. */
export interface WebuiWorkspaceEnvironmentState {
  readonly workspaceDir?: string;
  readonly environment?: WebuiWorkspaceEnvironment;
  readonly loading: boolean;
  readonly error?: string;
}

export const initialWebuiWorkspaceEnvironmentState: WebuiWorkspaceEnvironmentState =
  { loading: false };

export interface WebuiWorkspaceEnvironmentOwner {
  readonly state: () => WebuiWorkspaceEnvironmentState;
  /** The revision the environment panel's effect reloads on. */
  readonly revision: () => number;
  readonly canReadEnvironment: boolean;
  readonly canMutateGit: boolean;
  readonly load: (workspaceDir: string) => void;
  /**
   * Ask for a reload. `debounceMs` coalesces a burst of signals into one fetch;
   * `0` fires at once. Only the revision moves — the panel's effect performs the
   * single reload, so a coalesced signal is one fetch rather than a fetch beside
   * the effect's own.
   */
  readonly invalidate: (workspaceDir: string, debounceMs: number) => void;
  /** Run a git mutation, then invalidate exactly the views it affected. */
  readonly mutateGit: (
    request: WebuiWorkspaceGitMutationRequest,
  ) => Promise<Record<string, unknown>>;
  readonly dispose: () => void;
  /** The mixed owner merges this slice on read, so it needs to hear when this
   *  half moved. */
  readonly subscribe: (listener: () => void) => () => void;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function createWebuiWorkspaceEnvironmentOwner(deps: {
  readonly port: WebuiWorkspaceEnvironmentPort;
  /** The review invalidation a git mutation owes, injected by the composer. */
  readonly invalidateReview: () => void;
}): WebuiWorkspaceEnvironmentOwner {
  const { port } = deps;
  let state = initialWebuiWorkspaceEnvironmentState;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const versions = new Map<string, number>();

  const bump = (key: string): number => {
    const next = (versions.get(key) ?? 0) + 1;
    versions.set(key, next);
    return next;
  };
  const isCurrent = (key: string, version: number): boolean =>
    (versions.get(key) ?? 0) === version;

  const set = (update: (current: WebuiWorkspaceEnvironmentState) => WebuiWorkspaceEnvironmentState): void => {
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const load = (workspaceDir: string): void => {
    const key = `environment:${workspaceDir}`;
    const version = bump(key);
    if (!port.getWorkspaceEnvironment) return;
    const getEnvironment = port.getWorkspaceEnvironment;
    set((current) =>
      current.workspaceDir === workspaceDir
        ? { ...current, loading: true }
        : { ...initialWebuiWorkspaceEnvironmentState, workspaceDir, loading: true },
    );
    void getEnvironment({ workspaceDir })
      .then((environment) => {
        if (!isCurrent(key, version)) return;
        set((current) =>
          current.workspaceDir === workspaceDir
            ? { workspaceDir, environment, loading: false }
            : current,
        );
      })
      .catch((reason: unknown) => {
        if (!isCurrent(key, version)) return;
        set((current) =>
          current.workspaceDir === workspaceDir
            ? { workspaceDir, loading: false, error: message(reason) }
            : current,
        );
      });
  };

  const invalidate = (workspaceDir: string, debounceMs: number): void => {
    const fire = (): void => {
      set((current) =>
        current.workspaceDir === workspaceDir
          ? { ...current, loading: true }
          : current,
      );
      revision += 1;
      for (const listener of [...listeners]) listener();
    };
    if (timer !== undefined) clearTimeout(timer);
    if (debounceMs <= 0) {
      fire();
      return;
    }
    timer = setTimeout(fire, debounceMs);
  };

  const mutateGit = async (
    request: WebuiWorkspaceGitMutationRequest,
  ): Promise<Record<string, unknown>> => {
    if (!port.mutateWorkspaceGit) return {};
    const result = await port.mutateWorkspaceGit(request);
    // Exactly the views this mutation affects: the git environment and the review
    // of the workspace it ran in. Nothing else reloads.
    invalidate(request.workspaceDir, 0);
    deps.invalidateReview();
    return result;
  };

  return {
    state: () => state,
    revision: () => revision,
    canReadEnvironment: port.getWorkspaceEnvironment !== undefined,
    canMutateGit: port.mutateWorkspaceGit !== undefined,
    load,
    invalidate,
    mutateGit,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      listeners.clear();
    },
  };
}
