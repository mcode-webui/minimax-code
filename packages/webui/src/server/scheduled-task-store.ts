// WebUI-owned scheduled-task storage.
//
// ── Why this file exists at all ────────────────────────────────────────────
// The WebUI could have borrowed the desktop client's scheduled-task tables. It
// deliberately does not, and the reasons are load-bearing rather than taste:
//
//   * The v1 cron path is hard-wired off for webui
//     (`local-runtime-v2/src/compat/v1/runtime.ts`), and the table it reads is
//     empty in practice — the data moved to v2 during the migration.
//   * `local-runtime-v2`'s `CronService` is Electron-only (`enableCron` in
//     `services.ts`); a loopback WebUI process never gets that handle.
//   * v2's live rows live in `local_runtime_v2_cron_definitions`. Reading them
//     from here would be the worst possible combination: a second scheduler
//     with no access to v2's concurrency guards, writing turns into the same
//     agent queue as the desktop client.
//
// So: our own file, our own table, our own loop. The consequence is a product
// boundary, not a bug — **a scheduled task in the WebUI and a scheduled task
// in the desktop client are two different things that cannot see each other**,
// and turning the WebUI off stops its tasks from running without replaying
// them. `scheduled-task-scheduler.ts` owns that boundary's runtime half.
//
// ── Storage shape ──────────────────────────────────────────────────────────
// This is the first persistence the WebUI server owns: until now it only read
// credentials and quota out of `dataDir`. The database is a separate file
// under `<dataDir>/webui/`, never the runtime's own database, so "does not
// touch the v2 tables" is enforced by the filesystem rather than by
// discipline at every call site.
//
// Migration is driven by SQLite's own `user_version` pragma: it is per-file,
// transactional with the DDL it guards, and needs no bookkeeping table. Every
// step is `IF NOT EXISTS`, so re-running the migration on an already-migrated
// file is a no-op and an interrupted upgrade leaves the next start to finish
// the job.
//
// `better-sqlite3` is loaded through `createRequire` and lazily, the same way
// `terminal.ts` loads `node-pty`: it is a native addon, and a static import
// would hand esbuild a `.node` binding to bundle into the server artifact. The
// shipped standalone CLI already declares it as a runtime dependency
// (`release/webui-npm/package.json`) and `scripts/package-webui-npm.mjs`
// externalises it; in a source checkout it resolves through the workspace's
// hoisted `node_modules`. A host where it cannot load is not broken — the
// capability probe reports it and the surface fails closed with the reason.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);

export const SCHEDULED_TASK_SCHEMA_VERSION = 1;

/** The table is prefixed because the file is ours alone, and names outlive files. */
const TABLE = "webui_scheduled_task";

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  task_id            TEXT    PRIMARY KEY,
  name               TEXT    NOT NULL,
  agent_name         TEXT    NOT NULL,
  session_target     TEXT    NOT NULL CHECK (session_target IN ('new', 'existing')),
  session_id         TEXT,
  prompt             TEXT    NOT NULL,
  schedule_kind      TEXT    NOT NULL CHECK (schedule_kind IN ('once', 'interval')),
  run_at_ms          INTEGER,
  interval_ms        INTEGER,
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at_ms     INTEGER,
  last_status        TEXT CHECK (last_status IS NULL OR last_status IN ('succeeded', 'failed', 'missed')),
  last_error         TEXT,
  last_result        TEXT,
  last_session_id    TEXT,
  next_run_at_ms     INTEGER,
  missed_count       INTEGER NOT NULL DEFAULT 0,
  last_missed_at_ms  INTEGER,
  created_at_ms      INTEGER NOT NULL,
  updated_at_ms      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ${TABLE}_due
  ON ${TABLE} (enabled, next_run_at_ms);
`;

/** The row shape, with SQLite's integers already narrowed back to booleans. */
export interface ScheduledTaskRecord {
  readonly taskId: string;
  readonly name: string;
  readonly agentName: string;
  readonly sessionTarget: "new" | "existing";
  readonly sessionId: string | null;
  readonly prompt: string;
  readonly scheduleKind: "once" | "interval";
  readonly runAtMs: number | null;
  readonly intervalMs: number | null;
  readonly enabled: boolean;
  readonly lastRunAtMs: number | null;
  readonly lastStatus: "succeeded" | "failed" | "missed" | null;
  readonly lastError: string | null;
  readonly lastResult: string | null;
  readonly lastSessionId: string | null;
  readonly nextRunAtMs: number | null;
  readonly missedCount: number;
  readonly lastMissedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ScheduledTaskCreateInput {
  readonly name: string;
  readonly agentName: string;
  readonly sessionTarget: "new" | "existing";
  readonly sessionId?: string | null;
  readonly prompt: string;
  readonly scheduleKind: "once" | "interval";
  /** First slot on the grid. Defaults to "now" for a one-shot task. */
  readonly runAtMs?: number | null;
  /** Recurring period. Ignored for a one-shot task. */
  readonly intervalMs?: number | null;
  readonly nowMs: number;
}

/**
 * The fields a caller may change. Mutable because the runtime assembles a
 * patch key by key; the record it is derived from is readonly on purpose,
 * since a row handed out for reading must not be writable in place.
 */
export type ScheduledTaskPatch = Partial<
  {
    -readonly [Key in keyof Pick<
      ScheduledTaskRecord,
      | "name"
      | "prompt"
      | "agentName"
      | "sessionTarget"
      | "sessionId"
      | "scheduleKind"
      | "runAtMs"
      | "intervalMs"
      | "enabled"
      | "nextRunAtMs"
    >]: Pick<
      ScheduledTaskRecord,
      Key
    >[Key];
  }
>;

export interface ScheduledTaskOutcome {
  readonly ranAtMs: number;
  readonly status: "succeeded" | "failed";
  readonly error?: string | undefined;
  readonly result?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly nextRunAtMs: number | null;
  readonly enabled: boolean;
}

/** The subset of `better-sqlite3` this module uses, declared structurally. */
export interface ScheduledTaskDatabase {
  prepare(sql: string): {
    run(...params: readonly unknown[]): unknown;
    all(...params: readonly unknown[]): readonly Record<string, unknown>[];
    get(...params: readonly unknown[]): Record<string, unknown> | undefined;
  };
  exec(sql: string): unknown;
  pragma(source: string): unknown;
  close(): void;
}

interface SqliteStatement {
  run(...params: readonly unknown[]): unknown;
  all(...params: readonly unknown[]): readonly Record<string, unknown>[];
  get(...params: readonly unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  pragma(source: string): { readonly user_version: number } | readonly number[];
  close(): void;
}

type SqliteConstructor = new (
  file: string,
  options?: Record<string, unknown>,
) => SqliteDatabase;

let cachedConstructor: SqliteConstructor | undefined;

/**
 * Resolves the native addon on demand. Kept separate from `openDatabase` so a
 * host that never touches scheduled tasks never pays for the load, and so the
 * failure is a value the capability probe can report rather than a throw that
 * takes the process down at import time.
 */
function loadSqliteConstructor(): SqliteConstructor {
  if (cachedConstructor) return cachedConstructor;
  const loaded = require("better-sqlite3") as SqliteConstructor;
  cachedConstructor = loaded;
  return loaded;
}

/**
 * Opens (creating if needed) the WebUI's scheduled-task database and brings it
 * to {@link SCHEDULED_TASK_SCHEMA_VERSION}.
 *
 * WAL keeps a panel read from blocking a tick's write, and `foreign_keys` is
 * left off deliberately: this file has exactly one table and no references.
 */
export function openScheduledTaskDatabase(file: string): ScheduledTaskDatabase {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const Database = loadSqliteConstructor();
  const database = new Database(file);
  database.pragma("journal_mode = WAL");
  const store = new ScheduledTaskStore(database as unknown as ScheduledTaskDatabase);
  store.migrate();
  return database as unknown as ScheduledTaskDatabase;
}

function readUserVersion(database: ScheduledTaskDatabase): number {
  // better-sqlite3 answers a named pragma with an array of rows — pragma
  // values are query results like any other — so `user_version` arrives as
  // `[{ user_version: n }]`. Both that and a bare scalar are accepted so the
  // store does not depend on which spelling the driver picked.
  const result = database.pragma("user_version") as unknown;
  if (Array.isArray(result)) {
    const row = result[0];
    if (row && typeof row === "object" && "user_version" in row)
      return Number((row as { readonly user_version: unknown }).user_version ?? 0);
    return Number(row ?? 0);
  }
  if (result && typeof result === "object" && "user_version" in result)
    return Number((result as { readonly user_version: unknown }).user_version ?? 0);
  return Number(result ?? 0);
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toNullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function toRecord(row: Record<string, unknown>): ScheduledTaskRecord {
  return {
    taskId: toText(row.task_id),
    name: toText(row.name),
    agentName: toText(row.agent_name),
    sessionTarget: toText(row.session_target) === "new" ? "new" : "existing",
    sessionId: toNullableText(row.session_id),
    prompt: toText(row.prompt),
    scheduleKind: toText(row.schedule_kind) === "once" ? "once" : "interval",
    runAtMs: toNullableNumber(row.run_at_ms),
    intervalMs: toNullableNumber(row.interval_ms),
    enabled: toNumber(row.enabled) === 1,
    lastRunAtMs: toNullableNumber(row.last_run_at_ms),
    lastStatus:
      row.last_status === "succeeded" ||
      row.last_status === "failed" ||
      row.last_status === "missed"
        ? row.last_status
        : null,
    lastError: toNullableText(row.last_error),
    lastResult: toNullableText(row.last_result),
    lastSessionId: toNullableText(row.last_session_id),
    nextRunAtMs: toNullableNumber(row.next_run_at_ms),
    missedCount: toNumber(row.missed_count),
    lastMissedAtMs: toNullableNumber(row.last_missed_at_ms),
    createdAtMs: toNumber(row.created_at_ms),
    updatedAtMs: toNumber(row.updated_at_ms),
  };
}

const COLUMNS =
  "task_id, name, agent_name, session_target, session_id, prompt, " +
  "schedule_kind, run_at_ms, interval_ms, enabled, last_run_at_ms, last_status, " +
  "last_error, last_result, last_session_id, next_run_at_ms, missed_count, " +
  "last_missed_at_ms, created_at_ms, updated_at_ms";

/**
 * All reads and writes for the WebUI's scheduled tasks.
 *
 * Every mutation is a single statement so the store never needs a
 * multi-statement transaction to stay consistent — a tick and a panel edit can
 * interleave, and each of them leaves the row valid on its own.
 */
export class ScheduledTaskStore {
  constructor(private readonly database: ScheduledTaskDatabase) {}

  /**
   * Brings the file to the current schema version.
   *
   * Steps run in order and each is individually idempotent, so an interrupted
   * upgrade resumes on the next start instead of needing a repair path. The
   * version is written after its DDL, which SQLite commits together with it.
   */
  migrate(): void {
    const current = readUserVersion(this.database);
    if (current >= SCHEDULED_TASK_SCHEMA_VERSION) return;
    this.database.exec(CREATE_TABLE_SQL);
    this.database.pragma(`user_version = ${SCHEDULED_TASK_SCHEMA_VERSION}`);
  }

  schemaVersion(): number {
    return readUserVersion(this.database);
  }

  list(): ScheduledTaskRecord[] {
    return this.database
      .prepare(`SELECT ${COLUMNS} FROM ${TABLE} ORDER BY created_at_ms ASC, task_id ASC`)
      .all()
      .map(toRecord);
  }

  get(taskId: string): ScheduledTaskRecord | undefined {
    const row = this.database
      .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE task_id = ?`)
      .get(taskId);
    return row ? toRecord(row) : undefined;
  }

  /**
   * Enabled tasks whose due time has arrived. The scheduler decides what to do
   * with each one; this method only reports candidates, so the miss accounting
   * stays in one place.
   */
  dueTasks(nowMs: number): ScheduledTaskRecord[] {
    return this.database
      .prepare(
        `SELECT ${COLUMNS} FROM ${TABLE}
         WHERE enabled = 1 AND next_run_at_ms IS NOT NULL AND next_run_at_ms <= ?
         ORDER BY next_run_at_ms ASC, task_id ASC`,
      )
      .all(nowMs)
      .map(toRecord);
  }

  /**
   * Inserts a task and returns the stored row. The identity is minted here
   * rather than by the caller: it is a storage detail, and a caller that could
   * supply it could also collide with an existing row.
   */
  create(input: ScheduledTaskCreateInput): ScheduledTaskRecord {
    const taskId = `sched-${randomUUID()}`;
    // A one-shot task with no explicit moment runs at the moment it was made;
    // a recurring task always carries its interval, and one with no explicit
    // anchor starts counting from now.
    const runAtMs =
      input.runAtMs ?? (input.scheduleKind === "once" ? input.nowMs : null);
    this.database
      .prepare(
        `INSERT INTO ${TABLE} (
           task_id, name, agent_name, session_target, session_id, prompt,
           schedule_kind, run_at_ms, interval_ms, enabled, next_run_at_ms,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        taskId,
        input.name,
        input.agentName,
        input.sessionTarget,
        input.sessionId ?? null,
        input.prompt,
        input.scheduleKind,
        runAtMs,
        input.intervalMs ?? null,
        runAtMs,
        input.nowMs,
        input.nowMs,
      );
    const created = this.get(taskId);
    if (!created) throw new Error("scheduled task row vanished after insert");
    return created;
  }

  /** Returns the updated row, or `undefined` when the task does not exist. */
  update(taskId: string, patch: ScheduledTaskPatch & { readonly nowMs: number }): ScheduledTaskRecord | undefined {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const columns: Readonly<Record<string, string>> = {
      name: "name",
      prompt: "prompt",
      agentName: "agent_name",
      sessionTarget: "session_target",
      sessionId: "session_id",
      scheduleKind: "schedule_kind",
      runAtMs: "run_at_ms",
      intervalMs: "interval_ms",
      enabled: "enabled",
      nextRunAtMs: "next_run_at_ms",
    };
    for (const [key, column] of Object.entries(columns)) {
      if (!(key in patch)) continue;
      assignments.push(`${column} = ?`);
      const value = (patch as Record<string, unknown>)[key];
      values.push(key === "enabled" ? (value ? 1 : 0) : value);
    }
    if (!assignments.length) return this.get(taskId);
    assignments.push("updated_at_ms = ?");
    values.push(patch.nowMs, taskId);
    this.database
      .prepare(`UPDATE ${TABLE} SET ${assignments.join(", ")} WHERE task_id = ?`)
      .run(...values);
    return this.get(taskId);
  }

  /** Idempotent: reports whether a row was actually removed. */
  remove(taskId: string): boolean {
    const result = this.database
      .prepare(`DELETE FROM ${TABLE} WHERE task_id = ?`)
      .run(taskId) as { readonly changes?: number };
    return Number(result?.changes ?? 0) > 0;
  }

  recordOutcome(taskId: string, outcome: ScheduledTaskOutcome): void {
    this.database
      .prepare(
        `UPDATE ${TABLE} SET
           last_run_at_ms = ?, last_status = ?, last_error = ?, last_result = ?,
           last_session_id = COALESCE(?, last_session_id), next_run_at_ms = ?,
           enabled = ?, updated_at_ms = ?
         WHERE task_id = ?`,
      )
      .run(
        outcome.ranAtMs,
        outcome.status,
        outcome.error ?? null,
        outcome.result ?? null,
        outcome.sessionId ?? null,
        outcome.nextRunAtMs,
        outcome.enabled ? 1 : 0,
        outcome.ranAtMs,
        taskId,
      );
  }

  /**
   * Records a run that came due while the WebUI was not running. `missedAtMs`
   * is the due time, not the moment the miss was noticed, so the panel can say
   * which slot was lost.
   */
  recordMissed(
    taskId: string,
    missed: {
      readonly missedAtMs: number;
      readonly nextRunAtMs: number | null;
      readonly enabled: boolean;
      readonly nowMs: number;
    },
  ): void {
    this.database
      .prepare(
        `UPDATE ${TABLE} SET
           missed_count = missed_count + 1, last_missed_at_ms = ?,
           last_status = 'missed', last_error = NULL, next_run_at_ms = ?,
           enabled = ?, updated_at_ms = ?
         WHERE task_id = ?`,
      )
      .run(
        missed.missedAtMs,
        missed.nextRunAtMs,
        missed.enabled ? 1 : 0,
        missed.nowMs,
        taskId,
      );
  }

  close(): void {
    this.database.close();
  }
}
