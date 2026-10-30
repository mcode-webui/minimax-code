// Wire contract record: every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiSshStatus` | A host's connection state. | The SSH service's probe and operation states. | `runtime/harness/ssh.ts`; the SSH settings tab. |
// | `WebuiSshEndpoint` | Where a host lives and how to reach it. | The SSH settings tab's host form. | `runtime/harness/ssh.ts`. |
// | `WebuiSshConnection` | One saved SSH host. | The SSH service's connection list. | `runtime/harness/ssh.ts`; the SSH settings tab. |
// | `WebuiSshDiscoveredHost` | One host found in `~/.ssh/config`. | The SSH service's discovery. | `runtime/harness/ssh.ts`; the SSH settings tab. |
// | `WebuiSshDiscovery` | The whole discovery result, including the empty case. | The SSH service's discovery. | `runtime/harness/ssh.ts`; the SSH settings tab. |
// | `WebuiSshProbeResult` | The outcome of one host probe. | The SSH service's probe. | `runtime/harness/ssh.ts`; the SSH settings tab. |
// | `WebuiSshSaveConnectionRequest` | A host to save (create or update). | The SSH settings tab's host form. | `runtime/harness/ssh.ts`. |
// | `WebuiSshSaveConnectionResult` | The saved host and its first probe. | The SSH service's save path. | `runtime/harness/ssh.ts`; the SSH settings tab. |
// | `WebuiSshSetEnabledRequest` | Whether a saved host takes part in routing. | The SSH settings tab's enable switch. | `runtime/harness/ssh.ts`. |
// | `WebuiSshRemoveResult` | Whether a host was removed, and which projects it took with it. | The SSH service's remove path. | `runtime/harness/ssh.ts`; the SSH settings tab. |
// | `WebuiSshListDirectoriesRequest` | A remote directory to list. | The SSH project's folder browser. | `runtime/harness/ssh.ts`. |
// | `WebuiSshDirectoryEntry` | One entry inside a remote directory. | The SSH service's directory listing. | `runtime/harness/ssh.ts`; the SSH project's folder browser. |
// | `WebuiSshListDirectoriesResult` | One remote directory listing. | The SSH service's directory listing. | `runtime/harness/ssh.ts`; the SSH project's folder browser. |
// | `WebuiSshProject` | One project rooted on an SSH host. | The SSH service's project list. | `runtime/harness/ssh.ts`; the SSH settings tab. |
// | `WebuiSshProjectRequest` | A project to create or update. | The SSH settings tab's project form. | `runtime/harness/ssh.ts`. |
// | `WebuiSshTerminalSession` | One live remote terminal. | The SSH terminal service. | `runtime/harness/ssh.ts`; the remote terminal view. |
//
// The service's own records (`SshConnection`, `SshProject`, …) stay inside the service: `src/shared`
// may not import them, so the harness adapter converts. The status vocabulary and the endpoint
// kinds are Desktop's own (`ssh-runtime/connection-service.js`).

/**
 * A host's connection state.
 *
 * The vocabulary is Desktop's own: `idle` before the first probe, `connecting` while a probe or
 * reconnect runs, `connected` when the host answered, `disconnected` after a clean drop,
 * `reconnecting` while a dropped link backs off, `failed` when the attempt failed, `probe_failed`
 * when the host answered but was not usable, `ready` when the host verified end to end, and
 * `disabled` for a host the user switched off.
 */
export type WebuiSshStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "failed"
  | "probe_failed"
  | "ready"
  | "unknown"
  | "disabled";

/** How a host is addressed: typed in by hand, or named in `~/.ssh/config`. */
export type WebuiSshEndpointKind = "manual" | "ssh_config";

export interface WebuiSshEndpoint {
  readonly kind: WebuiSshEndpointKind;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly identityFile?: string;
  /** The `Host` entry this endpoint came from, for `ssh_config` endpoints. */
  readonly alias?: string;
}

export interface WebuiSshConnection {
  readonly alias: string;
  readonly displayName: string;
  readonly endpoint: WebuiSshEndpoint;
  readonly enabled: boolean;
  readonly status: WebuiSshStatus;
  readonly lastError?: string;
}

export interface WebuiSshDiscoveredHost {
  readonly alias: string;
  readonly hostname?: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
}

export interface WebuiSshDiscovery {
  /**
   * Whether `~/.ssh/config` was found at all.
   *
   * Desktop tells the two empty states apart: no config file, versus a config file with no hosts.
   */
  readonly configFound: boolean;
  readonly hosts: readonly WebuiSshDiscoveredHost[];
  readonly error?: "config_unreadable";
}

export interface WebuiSshProbeResult {
  readonly alias: string;
  readonly status: WebuiSshStatus;
  readonly detail?: string;
}

export interface WebuiSshSaveConnectionRequest {
  readonly alias: string;
  readonly displayName?: string;
  readonly endpoint: WebuiSshEndpoint;
  readonly enabled?: boolean;
  /** A password to stage for the first handshake; never stored in the browser. */
  readonly password?: string;
}

export interface WebuiSshSaveConnectionResult {
  readonly success: boolean;
  readonly connection?: WebuiSshConnection;
  readonly probe?: WebuiSshProbeResult;
  readonly error?: string;
}

export interface WebuiSshSetEnabledRequest {
  readonly alias: string;
  readonly enabled: boolean;
}

export interface WebuiSshRemoveResult {
  readonly success: boolean;
  /** The projects that were rooted on the removed host and went with it. */
  readonly removedProjectIds: readonly string[];
  readonly error?: string;
}

export interface WebuiSshListDirectoriesRequest {
  readonly alias: string;
  /** The remote directory to list; absent means the host's home directory. */
  readonly path?: string;
}

export type WebuiSshDirectoryEntryKind = "directory" | "file" | "symlink" | "other";

export interface WebuiSshDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: WebuiSshDirectoryEntryKind;
}

export interface WebuiSshListDirectoriesResult {
  readonly alias: string;
  readonly path: string;
  readonly entries: readonly WebuiSshDirectoryEntry[];
  readonly status: WebuiSshStatus;
  readonly error?: string;
}

export interface WebuiSshProject {
  readonly id: string;
  readonly alias: string;
  readonly path: string;
  readonly displayName: string;
}

export interface WebuiSshProjectRequest {
  readonly id?: string;
  readonly alias: string;
  readonly path: string;
  readonly displayName?: string;
}

export interface WebuiSshProjectResult {
  readonly success: boolean;
  readonly project?: WebuiSshProject;
  readonly error?: string;
}

/** One live remote terminal. */
export interface WebuiSshTerminalSession {
  readonly terminalId: string;
  readonly alias: string;
  readonly status: "starting" | "running" | "closed" | "failed";
  readonly error?: string;
}

/**
 * The remote terminal's output stream.
 *
 * Same envelope shape as the session event channel: a source of frames, or a structured refusal
 * when this host cannot host the terminal.
 */
export type WebuiSshTerminalStreamResult =
  | {
      readonly ok: true;
      readonly source:
        | AsyncIterable<{ readonly data: string }>
        | Iterable<{ readonly data: string }>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: {
        readonly key?: string;
        readonly message: string;
        readonly detail?: string;
      };
    };
