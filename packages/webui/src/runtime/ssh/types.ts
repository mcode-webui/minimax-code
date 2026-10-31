// The SSH runtime's own records.
//
// These types stay inside `src/runtime/ssh/`. The browser may only name the wire DTOs in
// `src/shared/contracts/ssh.ts`, and the harness adapter converts field by field, so a field added
// here can never reach the wire by accident.
//
// The status vocabulary is Desktop's own (`ssh-runtime/connection-service.js`): `idle` before the
// first probe, `connected` when the host answered, `probe_failed` when it did not, `disabled` for a
// host the user switched off.
export type SshStatus =
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
export type SshEndpointKind = "manual" | "ssh_config";

export interface SshEndpointRecord {
  readonly kind: SshEndpointKind;
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly identityFile?: string;
  /** The `Host` entry this endpoint came from, for `ssh_config` endpoints. */
  readonly alias?: string;
}

export interface SshConnectionRecord {
  readonly alias: string;
  readonly displayName: string;
  readonly endpoint: SshEndpointRecord;
  readonly enabled: boolean;
  readonly status: SshStatus;
  readonly lastError?: string;
}

export interface SshProjectRecord {
  readonly id: string;
  readonly alias: string;
  readonly path: string;
  readonly displayName: string;
}

export interface SshDiscoveredHostRecord {
  readonly alias: string;
  readonly hostname?: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
}

export interface SshDiscoveryRecord {
  /** Whether `~/.ssh/config` was found at all. */
  readonly configFound: boolean;
  readonly hosts: readonly SshDiscoveredHostRecord[];
  /** Set when the config file exists but could not be read. */
  readonly error?: "config_unreadable";
}

export interface SshProbeRecord {
  readonly alias: string;
  readonly status: SshStatus;
  readonly detail?: string;
}

export type SshDirectoryEntryKind = "directory" | "file" | "symlink" | "other";

export interface SshDirectoryEntryRecord {
  readonly name: string;
  readonly path: string;
  readonly kind: SshDirectoryEntryKind;
}

export interface SshDirectoryListingRecord {
  readonly alias: string;
  readonly path: string;
  readonly entries: readonly SshDirectoryEntryRecord[];
  readonly status: SshStatus;
  readonly error?: string;
}

export type SshTerminalStatus = "starting" | "running" | "closed" | "failed";

export interface SshTerminalSessionRecord {
  readonly terminalId: string;
  readonly alias: string;
  readonly status: SshTerminalStatus;
  readonly error?: string;
}
