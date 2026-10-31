// The saved SSH hosts.
//
// Desktop keeps one store per concern and reports an identity revision when the record under an
// alias changes; this port keeps the same two facts, because the WebUI's host list and its
// project list have to agree about which host a project is rooted on.
//
// The store holds no credential. A password is staged in memory for the first handshake and is
// never written here.
import path from "node:path";

import { SshRuntimeError } from "./errors.js";
import { SSH_STORE_VERSION, readJsonStore, writeJsonStore } from "./storage.js";
import type { SshConnectionRecord, SshEndpointRecord, SshStatus } from "./types.js";

interface StoredConnection {
  readonly alias: string;
  readonly displayName: string;
  readonly endpoint: SshEndpointRecord;
  readonly enabled: boolean;
  readonly status: SshStatus;
  readonly lastError?: string;
}

interface StoredConnections {
  readonly version: number;
  /** Bumped on every write, so a reader can tell one revision from the next. */
  readonly revision: number;
  readonly connections: readonly StoredConnection[];
}

export interface SshConnectionRepository {
  list(): Promise<readonly SshConnectionRecord[]>;
  get(alias: string): Promise<SshConnectionRecord | undefined>;
  /** Create or replace one host. */
  save(record: {
    readonly alias: string;
    readonly displayName: string;
    readonly endpoint: SshEndpointRecord;
    readonly enabled: boolean;
    readonly status: SshStatus;
    readonly lastError?: string;
  }): Promise<SshConnectionRecord>;
  setEnabled(alias: string, enabled: boolean, status: SshStatus): Promise<SshConnectionRecord>;
  remove(alias: string): Promise<boolean>;
  /** The revision the store was last written at, for one host or for the store as a whole. */
  getIdentityRevision(alias?: string): Promise<number>;
}

export function createSshConnectionRepository(filePath: string): SshConnectionRepository {
  const readStore = async (): Promise<StoredConnections> => {
    const stored = await readJsonStore<StoredConnections>(filePath);
    if (!stored || stored.version !== SSH_STORE_VERSION || !Array.isArray(stored.connections)) {
      return { version: SSH_STORE_VERSION, revision: 0, connections: [] };
    }
    return {
      version: stored.version,
      revision: typeof stored.revision === "number" ? stored.revision : 0,
      connections: stored.connections.filter(isStoredConnection),
    };
  };

  const writeStore = async (connections: readonly StoredConnection[]): Promise<number> => {
    const store = await readStore();
    const revision = store.revision + 1;
    await writeJsonStore(filePath, {
      version: SSH_STORE_VERSION,
      revision,
      connections,
    } satisfies StoredConnections);
    return revision;
  };

  return {
    async list() {
      const store = await readStore();
      return store.connections.map(toRecord);
    },

    async get(alias) {
      const store = await readStore();
      const found = store.connections.find((connection) => connection.alias === alias);
      return found ? toRecord(found) : undefined;
    },

    async save(record) {
      const store = await readStore();
      const stored: StoredConnection = {
        alias: record.alias,
        displayName: record.displayName,
        endpoint: record.endpoint,
        enabled: record.enabled,
        status: record.status,
        ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
      };
      const connections = [
        ...store.connections.filter((connection) => connection.alias !== record.alias),
        stored,
      ];
      await writeStore(connections);
      return toRecord(stored);
    },

    async setEnabled(alias, enabled, status) {
      const store = await readStore();
      const found = store.connections.find((connection) => connection.alias === alias);
      if (!found) {
        throw new SshRuntimeError("connection_not_found", "没有找到这个 SSH 主机。");
      }
      const stored: StoredConnection = { ...found, enabled, status };
      const connections = store.connections.map((connection) =>
        connection.alias === alias ? stored : connection,
      );
      await writeStore(connections);
      return toRecord(stored);
    },

    async remove(alias) {
      const store = await readStore();
      const connections = store.connections.filter((connection) => connection.alias !== alias);
      if (connections.length === store.connections.length) return false;
      await writeStore(connections);
      return true;
    },

    async getIdentityRevision(alias) {
      const store = await readStore();
      if (alias === undefined) return store.revision;
      const found = store.connections.find((connection) => connection.alias === alias);
      return found ? store.revision : 0;
    },
  };
}

/** The default location of the connection store under a runtime data directory. */
export function sshConnectionStorePath(dataDir: string): string {
  return path.join(dataDir, "ssh", "connections.json");
}

function toRecord(stored: StoredConnection): SshConnectionRecord {
  return {
    alias: stored.alias,
    displayName: stored.displayName,
    endpoint: stored.endpoint,
    enabled: stored.enabled,
    status: stored.status,
    ...(stored.lastError === undefined ? {} : { lastError: stored.lastError }),
  };
}

function isStoredConnection(value: unknown): value is StoredConnection {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.alias === "string" && typeof record.endpoint === "object" && record.endpoint !== null;
}
