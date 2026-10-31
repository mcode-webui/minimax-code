// The saved SSH hosts: add, update, switch on and off, remove, probe.
//
// The shape of this service is Desktop's (`ssh-runtime/connection-service.js`): a save answers with
// the saved host *and* the probe that followed it, a removal answers with the projects that went
// with the host, and a host that cannot be reached is reported as such.
//
// Two rules shape the answers:
//
//   * **A host that cannot be reached says so.** A probe that fails is `probe_failed`, never a
//     `connected` that nobody verified.
//   * **A password is staged, never stored.** It arrives with the save request, it is kept in
//     memory for the handshake, and it never reaches the browser again.
import { buildRemoteProbeCommand, buildSshArgs, SSH_PROBE_MARKER } from "./command.js";
import type { SshAskpassService } from "./askpass.js";
import type { SshCredentialStore } from "./credentials.js";
import type { SshConnectionRepository } from "./connection-repository.js";
import type { SshProjectRepository } from "./project-repository.js";
import type { SshTransport } from "./transport.js";
import type {
  SshConnectionRecord,
  SshEndpointRecord,
  SshProbeRecord,
} from "./types.js";
import {
  isSafeAbsoluteLocalPath,
  isSafeSshAlias,
  isSafeSshHostname,
  isSafeSshPort,
  isSafeSshUser,
} from "./validators.js";

export interface SshSaveConnectionInput {
  readonly alias: string;
  readonly displayName?: string;
  readonly endpoint: SshEndpointRecord;
  readonly enabled?: boolean;
  /** A password to stage for the first handshake. It is never stored and never echoed back. */
  readonly password?: string;
}

export interface SshSaveConnectionOutcome {
  readonly success: boolean;
  readonly connection?: SshConnectionRecord;
  readonly probe?: SshProbeRecord;
  readonly error?: string;
}

export interface SshRemoveConnectionOutcome {
  readonly success: boolean;
  readonly removedProjectIds: readonly string[];
  readonly error?: string;
}

export interface SshConnectionService {
  list(): Promise<readonly SshConnectionRecord[]>;
  save(input: SshSaveConnectionInput): Promise<SshSaveConnectionOutcome>;
  setEnabled(alias: string, enabled: boolean): Promise<SshSaveConnectionOutcome>;
  remove(alias: string): Promise<SshRemoveConnectionOutcome>;
  probe(alias: string): Promise<SshProbeRecord>;
}

export interface SshConnectionServiceOptions {
  readonly repository: SshConnectionRepository;
  readonly projects: SshProjectRepository;
  readonly transport: SshTransport;
  readonly credentials: SshCredentialStore;
  readonly askpass?: SshAskpassService;
}

const PROBE_TIMEOUT_MS = 20_000;

export function createSshConnectionService(
  options: SshConnectionServiceOptions,
): SshConnectionService {
  /** The probes in flight, so two handshakes for one host do not overlap. */
  const probing = new Set<string>();

  const probe = async (connection: SshConnectionRecord): Promise<SshProbeRecord> => {
    const password = options.credentials.get(connection.alias);
    const hasPassword = password !== undefined;
    const args = buildSshArgs(connection.endpoint, { password: hasPassword });
    const env = hasPassword ? options.askpass?.envFor(connection.alias) : undefined;
    const result = await options.transport.run(
      [...args, buildRemoteProbeCommand()],
      env ? { env, timeoutMs: PROBE_TIMEOUT_MS } : { timeoutMs: PROBE_TIMEOUT_MS },
    );
    return readProbeResult(connection.alias, result.stdout, result.stderr, result, password);
  };

  const runProbe = async (alias: string): Promise<SshProbeRecord> => {
    if (probing.has(alias)) {
      return { alias, status: "failed", detail: "这个主机的探测正在进行中。" };
    }
    const connection = await options.repository.get(alias);
    if (!connection) {
      return { alias, status: "failed", detail: "没有找到这个 SSH 主机。" };
    }
    if (!connection.enabled) {
      return { alias, status: "disabled", detail: "这个主机已停用。" };
    }
    probing.add(alias);
    try {
      return await probe(connection);
    } finally {
      probing.delete(alias);
    }
  };

  return {
    list: () => options.repository.list(),

    async save(input) {
      const alias = input.alias?.trim() ?? "";
      if (!isSafeSshAlias(alias)) {
        return { success: false, error: "invalid_input" };
      }
      const endpoint = readEndpoint(input.endpoint);
      if (!endpoint) return { success: false, error: "invalid_input" };
      if (input.password !== undefined) {
        try {
          options.credentials.stage(alias, input.password);
        } catch {
          return { success: false, error: "credential_unavailable" };
        }
      }

      const existing = await options.repository.get(alias);
      const enabled = input.enabled ?? existing?.enabled ?? true;
      const displayName = input.displayName?.trim() || existing?.displayName || alias;
      const saved = await options.repository.save({
        alias,
        displayName,
        endpoint,
        enabled,
        status: enabled ? "idle" : "disabled",
      });

      const probed = await runProbe(alias);
      // The stored record carries the probe's verdict, so the host list and the probe answer
      // agree: a host that could not be reached is listed as `probe_failed`, not as saved-and-fine.
      const lastError = probed.status === "connected" ? undefined : probed.detail;
      const connection: SshConnectionRecord = {
        ...saved,
        status: probed.status,
        ...(lastError === undefined ? {} : { lastError }),
      };
      await options.repository.save({
        alias: connection.alias,
        displayName: connection.displayName,
        endpoint: connection.endpoint,
        enabled: connection.enabled,
        status: connection.status,
        ...(connection.lastError === undefined ? {} : { lastError: connection.lastError }),
      });
      return { success: true, connection, probe: probed };
    },

    async setEnabled(alias, enabled) {
      if (!isSafeSshAlias(alias)) return { success: false, error: "invalid_input" };
      const connection = await options.repository.get(alias);
      if (!connection) return { success: false, error: "connection_not_found" };
      const saved = await options.repository.setEnabled(alias, enabled, enabled ? "idle" : "disabled");
      return { success: true, connection: saved };
    },

    async remove(alias) {
      if (!isSafeSshAlias(alias)) return { success: false, removedProjectIds: [], error: "invalid_input" };
      const connection = await options.repository.get(alias);
      if (!connection) return { success: false, removedProjectIds: [], error: "connection_not_found" };
      const removedProjectIds = await options.projects.removeByHost(alias);
      await options.repository.remove(alias);
      options.credentials.remove(alias);
      return { success: true, removedProjectIds };
    },

    probe: runProbe,
  };
}

/** The endpoint a save request carries, when it is one this runtime accepts. */
function readEndpoint(value: SshEndpointRecord | undefined): SshEndpointRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (value.kind === "ssh_config") {
    const alias = value.alias?.trim();
    if (!alias || !isSafeSshAlias(alias)) return undefined;
    if (value.host !== undefined && !isSafeSshHostname(value.host)) return undefined;
    if (value.port !== undefined && !isSafeSshPort(value.port)) return undefined;
    if (value.identityFile !== undefined && !isSafeAbsoluteLocalPath(value.identityFile)) {
      return undefined;
    }
    return {
      kind: "ssh_config",
      alias,
      ...(value.host === undefined ? {} : { host: value.host }),
      ...(value.port === undefined ? {} : { port: value.port }),
      ...(value.username === undefined ? {} : { username: value.username }),
      ...(value.identityFile === undefined ? {} : { identityFile: value.identityFile }),
    };
  }
  if (value.kind !== "manual") return undefined;
  const host = value.host?.trim();
  if (!host || !isSafeSshHostname(host)) return undefined;
  if (value.username !== undefined && !isSafeSshUser(value.username)) return undefined;
  if (value.port !== undefined && !isSafeSshPort(value.port)) return undefined;
  if (value.identityFile !== undefined && !isSafeAbsoluteLocalPath(value.identityFile)) {
    return undefined;
  }
  return {
    kind: "manual",
    host,
    ...(value.port === undefined ? {} : { port: value.port }),
    ...(value.username === undefined ? {} : { username: value.username }),
    ...(value.identityFile === undefined ? {} : { identityFile: value.identityFile }),
  };
}

/**
 * What one probe answered.
 *
 * A failed probe keeps the reason, so the host list can say *why* the host is not usable instead
 * of showing a bare status. The reason is a short sentence: OpenSSH's own output can be several
 * lines, and the browser is not a log viewer.
 */
function readProbeResult(
  alias: string,
  stdout: string,
  stderr: string,
  result: { readonly code: number | null; readonly timedOut: boolean; readonly spawnError?: NodeJS.ErrnoException },
  password: string | undefined,
): SshProbeRecord {
  if (result.spawnError) {
    if (result.spawnError.code === "ENOENT") {
      return { alias, status: "probe_failed", detail: "系统里没有找到 ssh 命令。" };
    }
    return {
      alias,
      status: "probe_failed",
      detail: redact(`无法启动 ssh：${result.spawnError.message}`, password),
    };
  }
  if (result.timedOut) {
    return { alias, status: "probe_failed", detail: "连接超时，主机没有在期限内回应。" };
  }
  const markerIndex = stdout.indexOf(SSH_PROBE_MARKER);
  if (markerIndex < 0) {
    const reason = firstLine(stderr) || firstLine(stdout);
    return {
      alias,
      status: "probe_failed",
      detail: redact(reason ? `主机没有完成握手：${reason}` : "主机没有完成握手。", password),
    };
  }
  const values = new Map<string, string>();
  for (const line of stdout.slice(markerIndex + SSH_PROBE_MARKER.length).split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (!values.has(key)) values.set(key, line.slice(separator + 1).trim());
  }
  const hostname = values.get("hostname");
  const user = values.get("remote_user");
  const where = [hostname, user].filter((value) => Boolean(value)).join("@");
  return {
    alias,
    status: "connected",
    ...(where ? { detail: `已连接：${where}` } : { detail: "已连接。" }),
  };
}

/** The first non-empty line of a captured output, trimmed to a readable length. */
function firstLine(value: string): string {
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
  return "";
}

/** A staged password must never appear in a message the browser reads. */
function redact(value: string, password: string | undefined): string {
  if (!password) return value;
  return value.split(password).join("***");
}
