// The SSH cell of the harness port.
//
// The runtime owns the SSH capability on the host side, exactly as Desktop's Electron main process
// owns it (`dist/main/modules/ssh-runtime/`). This adapter forwards and converts, and it decides
// nothing:
//
//   * the runtime's own record types stop at this file. `shared/contracts/ssh.ts` is what the
//     browser may name, and `src/shared` may not import the runtime's records, so every field is
//     read and re-emitted rather than passed through.
//   * a host that does not expose a data directory cannot keep its saved hosts, so the absence is
//     resolved once, here, through `requireHostSlot` — the same guard every other capability uses.
//
// The runtime is built lazily and kept: the saved hosts, the staged passwords and the live
// terminals are state, and a second runtime would be a second answer to the same question.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireDataDir } from "./requirements.js";
import { createSshRuntime, type SshRuntime } from "../ssh/index.js";
import type {
  SshConnectionRecord,
  SshDirectoryEntryRecord,
  SshDirectoryListingRecord,
  SshDiscoveredHostRecord,
  SshDiscoveryRecord,
  SshEndpointRecord,
  SshProbeRecord,
  SshProjectRecord,
  SshTerminalSessionRecord,
} from "../ssh/types.js";
import type {
  WebuiSshConnection,
  WebuiSshDirectoryEntry,
  WebuiSshDirectoryEntryKind,
  WebuiSshDiscoveredHost,
  WebuiSshDiscovery,
  WebuiSshEndpoint,
  WebuiSshEndpointKind,
  WebuiSshListDirectoriesResult,
  WebuiSshProbeResult,
  WebuiSshProject,
  WebuiSshRemoveResult,
  WebuiSshSaveConnectionResult,
  WebuiSshStatus,
  WebuiSshTerminalSession,
} from "../../shared/contracts/ssh.js";

/** The fifteen members the SSH surface is made of. */
export type SshHarnessMembers = Pick<
  WebuiHarnessPort,
  | "listSshConnections"
  | "saveSshConnection"
  | "setSshConnectionEnabled"
  | "removeSshConnection"
  | "discoverSshHosts"
  | "probeSshConnection"
  | "listSshDirectories"
  | "listSshProjects"
  | "saveSshProject"
  | "removeSshProject"
  | "openSshTerminal"
  | "writeSshTerminal"
  | "resizeSshTerminal"
  | "closeSshTerminal"
  | "watchSshTerminal"
>;

export interface CreateSshAdapterOptions {
  /**
   * The runtime to forward to.
   *
   * The default builds one from the host's data directory. A composition root that already holds a
   * runtime — the assembly, or a test — passes it here instead.
   */
  readonly runtime?: SshRuntime;
}

const STATUSES: readonly WebuiSshStatus[] = [
  "idle",
  "connecting",
  "connected",
  "disconnected",
  "reconnecting",
  "failed",
  "probe_failed",
  "ready",
  "unknown",
  "disabled",
];

const ENDPOINT_KINDS: readonly WebuiSshEndpointKind[] = ["manual", "ssh_config"];

const ENTRY_KINDS: readonly WebuiSshDirectoryEntryKind[] = [
  "directory",
  "file",
  "symlink",
  "other",
];

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** The runtime's endpoint, as the wire names it. */
function toEndpoint(endpoint: SshEndpointRecord): WebuiSshEndpoint {
  const kind = oneOf(endpoint.kind, ENDPOINT_KINDS, "manual");
  const host = readText(endpoint.host);
  const port = readNumber(endpoint.port);
  const username = readText(endpoint.username);
  const identityFile = readText(endpoint.identityFile);
  const alias = readText(endpoint.alias);
  return {
    kind,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(username === undefined ? {} : { username }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(alias === undefined ? {} : { alias }),
  };
}

/** The runtime's host, as the wire names it. */
function toConnection(connection: SshConnectionRecord): WebuiSshConnection {
  const lastError = readText(connection.lastError);
  return {
    alias: connection.alias,
    displayName: connection.displayName,
    endpoint: toEndpoint(connection.endpoint),
    enabled: readBoolean(connection.enabled),
    status: oneOf(connection.status, STATUSES, "unknown"),
    ...(lastError === undefined ? {} : { lastError }),
  };
}

function toProbe(probe: SshProbeRecord): WebuiSshProbeResult {
  const detail = readText(probe.detail);
  return {
    alias: probe.alias,
    status: oneOf(probe.status, STATUSES, "unknown"),
    ...(detail === undefined ? {} : { detail }),
  };
}

function toDiscoveredHost(host: SshDiscoveredHostRecord): WebuiSshDiscoveredHost {
  const hostname = readText(host.hostname);
  const user = readText(host.user);
  const port = readNumber(host.port);
  const identityFile = readText(host.identityFile);
  return {
    alias: host.alias,
    ...(hostname === undefined ? {} : { hostname }),
    ...(user === undefined ? {} : { user }),
    ...(port === undefined ? {} : { port }),
    ...(identityFile === undefined ? {} : { identityFile }),
  };
}

function toDiscovery(discovery: SshDiscoveryRecord): WebuiSshDiscovery {
  return {
    configFound: readBoolean(discovery.configFound),
    hosts: discovery.hosts.map(toDiscoveredHost),
    ...(discovery.error === "config_unreadable" ? { error: "config_unreadable" as const } : {}),
  };
}

function toProject(project: SshProjectRecord): WebuiSshProject {
  return {
    id: project.id,
    alias: project.alias,
    path: project.path,
    displayName: project.displayName,
  };
}

function toDirectoryEntry(entry: SshDirectoryEntryRecord): WebuiSshDirectoryEntry {
  return {
    name: entry.name,
    path: entry.path,
    kind: oneOf(entry.kind, ENTRY_KINDS, "other"),
  };
}

function toDirectoryListing(listing: SshDirectoryListingRecord): WebuiSshListDirectoriesResult {
  const error = readText(listing.error);
  return {
    alias: listing.alias,
    path: listing.path,
    entries: listing.entries.map(toDirectoryEntry),
    status: oneOf(listing.status, STATUSES, "unknown"),
    ...(error === undefined ? {} : { error }),
  };
}

function toTerminalSession(session: SshTerminalSessionRecord): WebuiSshTerminalSession {
  const error = readText(session.error);
  return {
    terminalId: session.terminalId,
    alias: session.alias,
    status: oneOf(session.status, ["starting", "running", "closed", "failed"] as const, "failed"),
    ...(error === undefined ? {} : { error }),
  };
}

export function createSshAdapter(
  host: WebuiRuntimeHostHandle,
  options: CreateSshAdapterOptions = {},
): SshHarnessMembers {
  let runtimePromise: Promise<SshRuntime> | undefined;

  /**
   * The runtime this adapter forwards to.
   *
   * A host without a data directory cannot keep a saved host, so the absence is refused here
   * rather than at every member.
   */
  const requireRuntime = async (): Promise<SshRuntime> => {
    if (options.runtime) return options.runtime;
    runtimePromise ??= createSshRuntime({ dataDir: requireDataDir(host) });
    return runtimePromise;
  };

  return {
    async listSshConnections() {
      const connections = await (await requireRuntime()).connections.list();
      return connections.map(toConnection);
    },

    async saveSshConnection(request) {
      const outcome = await (await requireRuntime()).connections.save({
        alias: request.alias,
        ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
        endpoint: request.endpoint,
        ...(request.enabled === undefined ? {} : { enabled: request.enabled }),
        ...(request.password === undefined ? {} : { password: request.password }),
      });
      const answer: WebuiSshSaveConnectionResult = {
        success: outcome.success,
        ...(outcome.connection ? { connection: toConnection(outcome.connection) } : {}),
        ...(outcome.probe ? { probe: toProbe(outcome.probe) } : {}),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      };
      return answer;
    },

    async setSshConnectionEnabled(request) {
      const outcome = await (await requireRuntime()).connections.setEnabled(
        request.alias,
        request.enabled,
      );
      const answer: WebuiSshSaveConnectionResult = {
        success: outcome.success,
        ...(outcome.connection ? { connection: toConnection(outcome.connection) } : {}),
        ...(outcome.probe ? { probe: toProbe(outcome.probe) } : {}),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      };
      return answer;
    },

    async removeSshConnection(request): Promise<WebuiSshRemoveResult> {
      const outcome = await (await requireRuntime()).connections.remove(request.alias);
      return {
        success: outcome.success,
        removedProjectIds: [...outcome.removedProjectIds],
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      };
    },

    async discoverSshHosts() {
      return toDiscovery(await (await requireRuntime()).discovery());
    },

    async probeSshConnection(request) {
      return toProbe(await (await requireRuntime()).connections.probe(request.alias));
    },

    async listSshDirectories(request) {
      const listing = await (await requireRuntime()).projects.listDirectories(
        request.alias,
        request.path,
      );
      return toDirectoryListing(listing);
    },

    async listSshProjects() {
      const projects = await (await requireRuntime()).projects.list();
      return projects.map(toProject);
    },

    async saveSshProject(request) {
      const outcome = await (await requireRuntime()).projects.save({
        ...(request.id === undefined ? {} : { id: request.id }),
        alias: request.alias,
        path: request.path,
        ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
      });
      return {
        success: outcome.success,
        ...(outcome.project ? { project: toProject(outcome.project) } : {}),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      };
    },

    async removeSshProject(request) {
      const outcome = await (await requireRuntime()).projects.remove(request.id);
      return {
        success: outcome.success,
        ...(outcome.project ? { project: toProject(outcome.project) } : {}),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      };
    },

    async openSshTerminal(request) {
      const outcome = await (await requireRuntime()).terminals.open({
        alias: request.alias,
        ...(request.path === undefined ? {} : { path: request.path }),
      });
      return toTerminalSession(outcome.session);
    },

    async writeSshTerminal(request) {
      const accepted = (await requireRuntime()).terminals.write(request.terminalId, request.data);
      return { accepted };
    },

    async resizeSshTerminal(request) {
      const accepted = (await requireRuntime()).terminals.resize(
        request.terminalId,
        request.cols,
        request.rows,
      );
      return { accepted };
    },

    async closeSshTerminal(request) {
      const accepted = (await requireRuntime()).terminals.close(request.terminalId);
      return { accepted };
    },

    async watchSshTerminal(request) {
      const runtime = await requireRuntime();
      try {
        const source = runtime.terminals.watch(request.terminalId);
        return {
          ok: true as const,
          source: source as AsyncIterable<{ readonly data: string }>,
        };
      } catch (error) {
        return {
          ok: false as const,
          status: 404,
          body: {
            message: error instanceof Error ? error.message : "没有找到这个远程终端。",
          },
        };
      }
    },
  };
}
