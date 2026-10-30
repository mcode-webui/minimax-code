// The projects rooted on a saved SSH host.
//
// A project is a folder on a remote machine: which host it lives on, which path, and the name it
// is shown under. The store is separate from the host store, so removing a host can name the
// projects that went with it — the answer the browser shows after a removal.
import path from "node:path";
import { randomUUID } from "node:crypto";

import { SshRuntimeError } from "./errors.js";
import { SSH_STORE_VERSION, readJsonStore, writeJsonStore } from "./storage.js";
import type { SshProjectRecord } from "./types.js";

interface StoredProject {
  readonly id: string;
  readonly alias: string;
  readonly path: string;
  readonly displayName: string;
}

interface StoredProjects {
  readonly version: number;
  readonly revision: number;
  readonly projects: readonly StoredProject[];
}

export interface SshProjectRepository {
  list(): Promise<readonly SshProjectRecord[]>;
  get(id: string): Promise<SshProjectRecord | undefined>;
  save(record: {
    readonly id?: string;
    readonly alias: string;
    readonly path: string;
    readonly displayName: string;
  }): Promise<SshProjectRecord>;
  remove(id: string): Promise<boolean>;
  /** Remove every project rooted on one host and name the ones that went. */
  removeByHost(alias: string): Promise<readonly string[]>;
}

export function createSshProjectRepository(filePath: string): SshProjectRepository {
  const readStore = async (): Promise<StoredProjects> => {
    const stored = await readJsonStore<StoredProjects>(filePath);
    if (!stored || stored.version !== SSH_STORE_VERSION || !Array.isArray(stored.projects)) {
      return { version: SSH_STORE_VERSION, revision: 0, projects: [] };
    }
    return {
      version: stored.version,
      revision: typeof stored.revision === "number" ? stored.revision : 0,
      projects: stored.projects.filter(isStoredProject),
    };
  };

  const writeStore = async (projects: readonly StoredProject[]): Promise<void> => {
    const store = await readStore();
    await writeJsonStore(filePath, {
      version: SSH_STORE_VERSION,
      revision: store.revision + 1,
      projects,
    } satisfies StoredProjects);
  };

  return {
    async list() {
      const store = await readStore();
      return store.projects.map(toRecord);
    },

    async get(id) {
      const store = await readStore();
      const found = store.projects.find((project) => project.id === id);
      return found ? toRecord(found) : undefined;
    },

    async save(record) {
      const store = await readStore();
      const id = record.id ?? `ssh-project-${randomUUID()}`;
      const stored: StoredProject = {
        id,
        alias: record.alias,
        path: record.path,
        displayName: record.displayName,
      };
      const projects = [
        ...store.projects.filter((project) => project.id !== id),
        stored,
      ];
      await writeStore(projects);
      return toRecord(stored);
    },

    async remove(id) {
      const store = await readStore();
      const projects = store.projects.filter((project) => project.id !== id);
      if (projects.length === store.projects.length) return false;
      await writeStore(projects);
      return true;
    },

    async removeByHost(alias) {
      const store = await readStore();
      const removed = store.projects.filter((project) => project.alias === alias);
      if (removed.length === 0) return [];
      await writeStore(store.projects.filter((project) => project.alias !== alias));
      return removed.map((project) => project.id);
    },
  };
}

/** The default location of the project store under a runtime data directory. */
export function sshProjectStorePath(dataDir: string): string {
  return path.join(dataDir, "ssh", "projects.json");
}

function toRecord(stored: StoredProject): SshProjectRecord {
  return {
    id: stored.id,
    alias: stored.alias,
    path: stored.path,
    displayName: stored.displayName,
  };
}

function isStoredProject(value: unknown): value is StoredProject {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.alias === "string" &&
    typeof record.path === "string" &&
    typeof record.displayName === "string"
  );
}

/** The project-not-found failure, so the service and the terminal say it the same way. */
export function projectNotFound(): SshRuntimeError {
  return new SshRuntimeError("project_not_found", "没有找到这个 SSH 项目。");
}
