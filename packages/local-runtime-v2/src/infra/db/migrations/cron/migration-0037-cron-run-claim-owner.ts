import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';

const CRON_RUNS_TABLE = 'local_runtime_v2_cron_runs';

/**
 * ADR 0027 R4: a claimed run records who claimed it.
 *
 * Nullable on purpose. A host that does not write the column keeps working exactly as before, and
 * a run claimed by such a host stays unattributed — recovery decides those by its own scope rule
 * rather than by inference.
 */
export const migration: MigrationEntry = {
  version: 37,
  name: 'add_cron_run_claim_owner',
  up(database: MigrationDatabase): void {
    const columns = readColumns(database);
    if (columns.size === 0) return;
    if (columns.has('owner_instance_id')) return;
    database.exec(`
      ALTER TABLE ${CRON_RUNS_TABLE}
        ADD COLUMN owner_instance_id TEXT;
    `);
  },
};

function readColumns(database: MigrationDatabase): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${CRON_RUNS_TABLE})`)
      .all()
      .flatMap((row) => {
        if (typeof row !== 'object' || row === null || !('name' in row)) return [];
        return typeof row.name === 'string' ? [row.name] : [];
      }),
  );
}
