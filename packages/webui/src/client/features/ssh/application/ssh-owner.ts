// The SSH business owner.
//
// Framework-free — no React, no DOM — so the transitions are testable against a scripted port
// (`packages/webui/AGENTS.md`: no jsdom in this package).
//
// The facts it has to get right:
//
//   * **An unwired transport is not an empty list.** "This host cannot manage SSH hosts" and "you
//     have no SSH hosts" are different answers, and only the second one belongs in the empty
//     state.
//   * **A host that cannot be reached keeps its status.** A failed probe leaves the host in the
//     list with `probe_failed`, because a host that was saved and did not answer is not the same
//     thing as a host that was never saved.
//   * **The terminal's output is kept.** The browser attaches to a session that already exists, so
//     the output that arrived before the panel opened is part of what the panel shows.
import type {
  WebuiSshConnection,
  WebuiSshDirectoryEntry,
  WebuiSshDiscovery,
  WebuiSshProject,
  WebuiSshProjectRequest,
  WebuiSshProbeResult,
  WebuiSshSaveConnectionRequest,
} from "../../../../shared/contracts/ssh.js";
import type { SshPort } from "../contracts/ssh-port.js";
import {
  WEBUI_SSH_DISCOVERY_FAILED,
  WEBUI_SSH_FAILED,
  WEBUI_SSH_READ_FAILED,
  WEBUI_SSH_TERMINAL_FAILED,
  WEBUI_SSH_UNAVAILABLE,
  webuiSshErrorMessage,
} from "../projection/ssh-panel.js";

export type WebuiSshStatus = "idle" | "loading" | "ready" | "error";

export interface WebuiSshSnapshot {
  readonly status: WebuiSshStatus;
  readonly connections: readonly WebuiSshConnection[];
  readonly projects: readonly WebuiSshProject[];
  /** The hosts in `~/.ssh/config`, once the discovery ran. */
  readonly discovery?: WebuiSshDiscovery;
  /** Present when the last read failed; the rows are then the last good ones. */
  readonly error?: string;
  readonly loadedAtMs?: number;
}

export type WebuiSshTerminalStatus = "closed" | "running" | "failed";

export interface WebuiSshTerminalSnapshot {
  readonly terminalId?: string;
  readonly alias?: string;
  readonly status: WebuiSshTerminalStatus;
  readonly output: string;
  readonly error?: string;
}

/**
 * What a mutation answered.
 *
 * A failure is a value, not a thrown error: the panel's job is to put the reason next to the
 * field that was wrong, and a thrown error would land in a generic error boundary that cannot.
 */
export type WebuiSshMutation =
  | {
      readonly ok: true;
      readonly connection?: WebuiSshConnection;
      readonly probe?: WebuiSshProbeResult;
      readonly project?: WebuiSshProject;
      /** The projects that went with a removed host. */
      readonly removedProjectIds?: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/** What one remote directory answered. */
export type WebuiSshDirectoryListing =
  | {
      readonly ok: true;
      readonly path: string;
      readonly entries: readonly WebuiSshDirectoryEntry[];
    }
  | { readonly ok: false; readonly message: string };

export interface WebuiSshOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => WebuiSshSnapshot;
  readonly getTerminalSnapshot: () => WebuiSshTerminalSnapshot;
  /** Reads the saved hosts and the projects. Concurrent calls share one request. */
  readonly load: () => Promise<void>;
  /** Reads the hosts in `~/.ssh/config`. */
  readonly loadDiscovery: () => Promise<void>;
  readonly saveConnection: (request: WebuiSshSaveConnectionRequest) => Promise<WebuiSshMutation>;
  readonly setEnabled: (alias: string, enabled: boolean) => Promise<WebuiSshMutation>;
  readonly removeConnection: (alias: string) => Promise<WebuiSshMutation>;
  readonly probeConnection: (alias: string) => Promise<WebuiSshMutation>;
  readonly saveProject: (request: WebuiSshProjectRequest) => Promise<WebuiSshMutation>;
  readonly removeProject: (id: string) => Promise<WebuiSshMutation>;
  /** One remote directory, for the folder browser. */
  readonly listDirectories: (
    alias: string,
    path?: string,
  ) => Promise<WebuiSshDirectoryListing>;
  readonly openTerminal: (alias: string, path?: string) => Promise<WebuiSshMutation>;
  readonly writeTerminal: (data: string) => Promise<boolean>;
  readonly resizeTerminal: (cols: number, rows: number) => Promise<boolean>;
  readonly closeTerminal: () => Promise<void>;
  /** Follows the open terminal's output. Returns the stop function. */
  readonly watchTerminal: () => () => void;
}

export interface CreateWebuiSshOwnerOptions {
  readonly port: SshPort;
  readonly nowMs?: () => number;
}

const MAX_TERMINAL_OUTPUT = 200_000;

export function createWebuiSshOwner(options: CreateWebuiSshOwnerOptions): WebuiSshOwner {
  const nowMs = options.nowMs ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot: WebuiSshSnapshot = { status: "idle", connections: [], projects: [] };
  let terminal: WebuiSshTerminalSnapshot = { status: "closed", output: "" };
  let inFlight: Promise<void> | undefined;
  let stopWatching: (() => void) | undefined;

  const publish = (next: WebuiSshSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const publishTerminal = (next: WebuiSshTerminalSnapshot): void => {
    terminal = next;
    for (const listener of listeners) listener();
  };

  const load = async (): Promise<void> => {
    if (inFlight) return inFlight;
    const readConnections = options.port.listSshConnections;
    const readProjects = options.port.listSshProjects;
    if (!readConnections || !readProjects) {
      publish({
        ...snapshot,
        status: "error",
        error: WEBUI_SSH_UNAVAILABLE,
      });
      return;
    }
    publish({ ...snapshot, status: "loading" });
    inFlight = (async () => {
      try {
        const [connections, projects] = await Promise.all([readConnections(), readProjects()]);
        publish({
          status: "ready",
          connections,
          projects,
          ...(snapshot.discovery ? { discovery: snapshot.discovery } : {}),
          loadedAtMs: nowMs(),
        });
      } catch (error) {
        publish({
          ...snapshot,
          status: "error",
          error: error instanceof Error && error.message ? error.message : WEBUI_SSH_READ_FAILED,
        });
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const loadDiscovery = async (): Promise<void> => {
    const read = options.port.discoverSshHosts;
    if (!read) {
      publish({ ...snapshot, status: "error", error: WEBUI_SSH_UNAVAILABLE });
      return;
    }
    try {
      const discovery = await read();
      publish({ ...snapshot, discovery });
    } catch (error) {
      publish({
        ...snapshot,
        status: "error",
        error: error instanceof Error && error.message ? error.message : WEBUI_SSH_DISCOVERY_FAILED,
      });
    }
  };

  const failureMessage = (error: unknown): string =>
    error instanceof Error && error.message ? error.message : WEBUI_SSH_FAILED;

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getTerminalSnapshot: () => terminal,
    load,
    loadDiscovery,

    async saveConnection(request) {
      const save = options.port.saveSshConnection;
      if (!save) return { ok: false, message: WEBUI_SSH_UNAVAILABLE };
      try {
        const answer = await save(request);
        await load();
        if (!answer.success) {
          return { ok: false, message: webuiSshErrorMessage(answer.error) };
        }
        return {
          ok: true,
          ...(answer.connection ? { connection: answer.connection } : {}),
          ...(answer.probe ? { probe: answer.probe } : {}),
        };
      } catch (error) {
        return { ok: false, message: failureMessage(error) };
      }
    },

    async setEnabled(alias, enabled) {
      const setEnabled = options.port.setSshConnectionEnabled;
      if (!setEnabled) return { ok: false, message: WEBUI_SSH_UNAVAILABLE };
      try {
        const answer = await setEnabled({ alias, enabled });
        await load();
        if (!answer.success) {
          return { ok: false, message: webuiSshErrorMessage(answer.error) };
        }
        return { ok: true, ...(answer.connection ? { connection: answer.connection } : {}) };
      } catch (error) {
        return { ok: false, message: failureMessage(error) };
      }
    },

    async removeConnection(alias) {
      const remove = options.port.removeSshConnection;
      if (!remove) return { ok: false, message: WEBUI_SSH_UNAVAILABLE };
      try {
        const answer = await remove({ alias });
        await load();
        if (!answer.success) {
          return { ok: false, message: webuiSshErrorMessage(answer.error) };
        }
        return { ok: true, removedProjectIds: answer.removedProjectIds };
      } catch (error) {
        return { ok: false, message: failureMessage(error) };
      }
    },

    async probeConnection(alias) {
      const probe = options.port.probeSshConnection;
      if (!probe) return { ok: false, message: WEBUI_SSH_UNAVAILABLE };
      try {
        const answer = await probe({ alias });
        await load();
        return { ok: true, probe: answer };
      } catch (error) {
        return { ok: false, message: failureMessage(error) };
      }
    },

    async saveProject(request) {
      const save = options.port.saveSshProject;
      if (!save) return { ok: false, message: WEBUI_SSH_UNAVAILABLE };
      try {
        const answer = await save(request);
        await load();
        if (!answer.success) {
          return { ok: false, message: webuiSshErrorMessage(answer.error) };
        }
        return { ok: true, ...(answer.project ? { project: answer.project } : {}) };
      } catch (error) {
        return { ok: false, message: failureMessage(error) };
      }
    },

    async removeProject(id) {
      const remove = options.port.removeSshProject;
      if (!remove) return { ok: false, message: WEBUI_SSH_UNAVAILABLE };
      try {
        const answer = await remove({ id });
        await load();
        if (!answer.success) {
          return { ok: false, message: webuiSshErrorMessage(answer.error) };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, message: failureMessage(error) };
      }
    },

    async listDirectories(alias, path) {
      const list = options.port.listSshDirectories;
      if (!list) return { ok: false, message: WEBUI_SSH_UNAVAILABLE };
      try {
        const answer = await list({ alias, ...(path === undefined ? {} : { path }) });
        if (answer.status !== "ready") {
          return {
            ok: false,
            message: answer.error ?? webuiSshErrorMessage(undefined, "读取远端目录失败。"),
          };
        }
        return { ok: true, path: answer.path, entries: answer.entries };
      } catch (error) {
        return { ok: false, message: failureMessage(error) };
      }
    },

    async openTerminal(alias, path) {
      const open = options.port.openSshTerminal;
      if (!open) return { ok: false, message: WEBUI_SSH_UNAVAILABLE };
      try {
        const session = await open({ alias, ...(path === undefined ? {} : { path }) });
        if (!session.terminalId || session.status === "failed") {
          publishTerminal({
            alias,
            status: "failed",
            output: "",
            ...(session.error ? { error: session.error } : {}),
          });
          return { ok: false, message: session.error ?? WEBUI_SSH_TERMINAL_FAILED };
        }
        publishTerminal({
          terminalId: session.terminalId,
          alias: session.alias,
          status: "running",
          output: "",
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: failureMessage(error) };
      }
    },

    async writeTerminal(data) {
      const write = options.port.writeSshTerminal;
      const terminalId = terminal.terminalId;
      if (!write || !terminalId) return false;
      try {
        const answer = await write({ terminalId, data });
        return answer.accepted;
      } catch {
        return false;
      }
    },

    async resizeTerminal(cols, rows) {
      const resize = options.port.resizeSshTerminal;
      const terminalId = terminal.terminalId;
      if (!resize || !terminalId) return false;
      try {
        const answer = await resize({ terminalId, cols, rows });
        return answer.accepted;
      } catch {
        return false;
      }
    },

    async closeTerminal() {
      const close = options.port.closeSshTerminal;
      const terminalId = terminal.terminalId;
      stopWatching?.();
      stopWatching = undefined;
      if (close && terminalId) {
        try {
          await close({ terminalId });
        } catch {
          // A terminal that is already gone needs no closing.
        }
      }
      publishTerminal({ status: "closed", output: terminal.output });
    },

    watchTerminal() {
      stopWatching?.();
      stopWatching = undefined;
      const watch = options.port.watchSshTerminal;
      const terminalId = terminal.terminalId;
      if (!watch || !terminalId) return () => {};

      // The watch is the only delivery path: the frame callback carries the output, and the
      // returned function detaches it. A terminal this host cannot host is refused by the
      // operation that opens it, not by the watch.
      const stop = watch({ terminalId }, (frame) => {
        publishTerminal({
          ...terminal,
          status: "running",
          output: appendOutput(terminal.output, frame.data),
        });
      });
      stopWatching = stop;
      return stop;
    },
  };
}

/** Keep the output bounded: a long session must not grow the panel's memory without limit. */
function appendOutput(output: string, chunk: string): string {
  const next = output + chunk;
  return next.length > MAX_TERMINAL_OUTPUT ? next.slice(next.length - MAX_TERMINAL_OUTPUT) : next;
}
