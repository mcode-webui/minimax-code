// The projects rooted on a saved SSH host, and the remote folder browser behind them.
//
// A project is a folder on a remote machine. The browser lists one remote directory at a time, so
// the person picks the folder the project is rooted in — the runtime never mounts a remote
// filesystem and never copies a remote tree into the browser.
//
// The listing comes from the remote side's own `ls`, through one `ssh` invocation, and the answer
// is parsed from a NUL separated record so a file name with a space cannot forge a field.
import {
  buildRemoteDirectoryListCommand,
  buildSshArgs,
  SSH_DIRECTORY_MARKER,
} from "./command.js";
import type { SshAskpassService } from "./askpass.js";
import type { SshConnectionRepository } from "./connection-repository.js";
import type { SshCredentialStore } from "./credentials.js";
import type { SshProjectRepository } from "./project-repository.js";
import type { SshTransport } from "./transport.js";
import type {
  SshDirectoryEntryRecord,
  SshDirectoryListingRecord,
  SshProjectRecord,
} from "./types.js";
import { isSafeAbsoluteRemotePath, isSafeSshAlias } from "./validators.js";

export interface SshProjectSaveInput {
  readonly id?: string;
  readonly alias: string;
  readonly path: string;
  readonly displayName?: string;
}

export interface SshProjectSaveOutcome {
  readonly success: boolean;
  readonly project?: SshProjectRecord;
  readonly error?: string;
}

export interface SshProjectService {
  list(): Promise<readonly SshProjectRecord[]>;
  save(input: SshProjectSaveInput): Promise<SshProjectSaveOutcome>;
  remove(id: string): Promise<SshProjectSaveOutcome>;
  /** One remote directory, for the folder browser. */
  listDirectories(alias: string, path?: string): Promise<SshDirectoryListingRecord>;
}

export interface SshProjectServiceOptions {
  readonly repository: SshProjectRepository;
  readonly connections: SshConnectionRepository;
  readonly transport: SshTransport;
  readonly credentials: SshCredentialStore;
  readonly askpass?: SshAskpassService;
}

const LISTING_TIMEOUT_MS = 30_000;

export function createSshProjectService(options: SshProjectServiceOptions): SshProjectService {
  return {
    list: () => options.repository.list(),

    async save(input) {
      const alias = input.alias?.trim() ?? "";
      if (!isSafeSshAlias(alias)) return { success: false, error: "invalid_input" };
      const path = input.path?.trim() ?? "";
      if (!isSafeAbsoluteRemotePath(path)) return { success: false, error: "invalid_input" };
      const connection = await options.connections.get(alias);
      if (!connection) return { success: false, error: "connection_not_found" };
      const displayName = input.displayName?.trim() || path.split("/").filter(Boolean).pop() || alias;
      const project = await options.repository.save({
        ...(input.id ? { id: input.id } : {}),
        alias,
        path,
        displayName,
      });
      return { success: true, project };
    },

    async remove(id) {
      if (typeof id !== "string" || id.trim() === "") {
        return { success: false, error: "invalid_input" };
      }
      const removed = await options.repository.remove(id);
      if (!removed) return { success: false, error: "project_not_found" };
      return { success: true };
    },

    async listDirectories(alias, path) {
      const hostAlias = alias?.trim() ?? "";
      if (!isSafeSshAlias(hostAlias)) {
        return {
          alias: hostAlias,
          path: path ?? "",
          entries: [],
          status: "failed",
          error: "invalid_input",
        };
      }
      const connection = await options.connections.get(hostAlias);
      if (!connection) {
        return {
          alias: hostAlias,
          path: path ?? "",
          entries: [],
          status: "failed",
          error: "connection_not_found",
        };
      }
      if (!connection.enabled) {
        return {
          alias: hostAlias,
          path: path ?? "",
          entries: [],
          status: "disabled",
          error: "host_disabled",
        };
      }
      // The remote path is quoted when the command is built, and refused here when it is not a
      // path at all: a folder the person did not pick is not one this runtime walks into.
      const requestedPath = path && path.trim() !== "" ? path.trim() : "/";
      if (!isSafeAbsoluteRemotePath(requestedPath)) {
        return {
          alias: hostAlias,
          path: requestedPath,
          entries: [],
          status: "failed",
          error: "invalid_input",
        };
      }
      const password = options.credentials.get(hostAlias);
      const args = buildSshArgs(connection.endpoint, { password: password !== undefined });
      const env = password !== undefined ? options.askpass?.envFor(hostAlias) : undefined;
      const result = await options.transport.run(
        [...args, buildRemoteDirectoryListCommand(requestedPath)],
        env ? { env, timeoutMs: LISTING_TIMEOUT_MS } : { timeoutMs: LISTING_TIMEOUT_MS },
      );
      return readDirectoryListing(hostAlias, requestedPath, result.stdout, result.stderr, result, password);
    },
  };
}

/**
 * What one directory listing answered.
 *
 * The remote side names the canonical path it resolved, so the browser shows the real path rather
 * than the one that was asked for.
 */
function readDirectoryListing(
  alias: string,
  requestedPath: string,
  stdout: string,
  stderr: string,
  result: { readonly code: number | null; readonly timedOut: boolean; readonly spawnError?: NodeJS.ErrnoException },
  password: string | undefined,
): SshDirectoryListingRecord {
  if (result.spawnError) {
    return {
      alias,
      path: requestedPath,
      entries: [],
      status: "probe_failed",
      error: "系统里没有找到 ssh 命令。",
    };
  }
  if (result.timedOut) {
    return {
      alias,
      path: requestedPath,
      entries: [],
      status: "probe_failed",
      error: "读取远端目录超时。",
    };
  }
  const markerIndex = stdout.indexOf(SSH_DIRECTORY_MARKER);
  if (markerIndex < 0) {
    return {
      alias,
      path: requestedPath,
      entries: [],
      status: "probe_failed",
      error: redact(`远端没有返回目录列表：${firstLine(stderr)}`, password),
    };
  }
  const fields = stdout
    .slice(markerIndex + SSH_DIRECTORY_MARKER.length)
    .split(String.fromCharCode(0))
    .filter((field) => field.length > 0);
  if (fields[0] === "status=not_found") {
    return {
      alias,
      path: requestedPath,
      entries: [],
      status: "failed",
      error: "远端目录不存在。",
    };
  }
  if (fields[0] !== "status=ready" || !fields[1]?.startsWith("path=")) {
    return {
      alias,
      path: requestedPath,
      entries: [],
      status: "probe_failed",
      error: "远端返回的目录列表无法读取。",
    };
  }
  const canonicalPath = fields[1].slice("path=".length);
  if (!isSafeAbsoluteRemotePath(canonicalPath)) {
    return {
      alias,
      path: requestedPath,
      entries: [],
      status: "probe_failed",
      error: "远端返回的目录路径不合法。",
    };
  }
  const entries: SshDirectoryEntryRecord[] = [];
  for (let index = 2; index + 1 < fields.length; index += 2) {
    const kind = fields[index];
    const entryPath = fields[index + 1];
    if (!kind || !entryPath) continue;
    if (!isSafeAbsoluteRemotePath(entryPath)) continue;
    if (entryPath === canonicalPath) continue;
    const name = entryPath.slice(entryPath.lastIndexOf("/") + 1);
    if (!name) continue;
    entries.push({
      name,
      path: entryPath,
      kind: kind === "directory" || kind === "file" || kind === "symlink" ? kind : "other",
    });
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : right.kind === "directory" ? 1 : 0;
    return left.name.localeCompare(right.name);
  });
  return { alias, path: canonicalPath, entries, status: "ready" };
}

function firstLine(value: string): string {
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
  return "";
}

function redact(value: string, password: string | undefined): string {
  if (!password) return value;
  return value.split(password).join("***");
}
