/**
 * ADR 0027 R3: two scheduler hosts on one data directory fire a slot once.
 *
 * The WebUI and the Desktop are peers over one SQLite file. Each arms the persisted job in its own
 * process, so each holds its own `runCount`. Before firing, a host reads the durable row: when the
 * row disagrees on any fact the fire depends on, the host adopts the row, re-arms to its schedule,
 * and lets the host that did not drift own the slot.
 *
 * **What this proves.** Two real `Scheduler` instances, two real connections to one temporary SQLite
 * file, the real cron service on top of each: one slot produces one cron run row and one delivery,
 * a pause in one host stops the other host's timer, and a host whose counter was moved underneath it
 * defers that slot and converges on the next. **What it does not prove.** It does not prove the
 * WebUI declares the `webui` scheduler-host policy (#272 does), and it does not prove external
 * provider execution — session creation and delivery are scripted ports here.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseClient } from '../../src/infra/db/client.js';
import { initializeDatabase } from '../../src/infra/db/initialize.js';
import { cronRuns } from '../../src/infra/db/schema/cron.js';
import { schedulerJobs } from '../../src/infra/db/schema/scheduler.js';
import { Scheduler } from '../../src/infra/scheduler/index.js';
import { composeCronService, type CronComposition } from '../../src/service/cron/composition.js';

interface TestHost {
  readonly client: DatabaseClient;
  readonly scheduler: Scheduler;
  readonly cron: CronComposition;
  readonly deliveredRunIds: string[];
}

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function temporaryDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'cron-two-hosts-'));
  disposers.push(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

/** One runtime host's scheduler stack: its own connection, its own timers, the shared cron service. */
async function bootHost(dataDir: string, deliveredRunIds: string[] = []): Promise<TestHost> {
  const client = new DatabaseClient({ dataDir });
  disposers.push(() => client.close());
  await initializeDatabase({ database: client, dataDir });
  const scheduler = new Scheduler({ db: client.db });
  const cron = composeCronService({
    db: client.db,
    scheduler,
    sessionPorts: {
      sessionCreation: {
        create: async (request) => ({ sessionId: `session-${request.runId}` }),
      },
      delivery: {
        deliver: async (request) => {
          deliveredRunIds.push(request.runId);
          return { delivered: true };
        },
      },
    },
  });
  // The cron handler has to be registered before start(); restore arms persisted jobs.
  scheduler.start({ restorePersistedJobExecution: true });
  return { client, scheduler, cron, deliveredRunIds };
}

function scheduledRuns(host: TestHost): Array<typeof cronRuns.$inferSelect> {
  return host.client.db.select().from(cronRuns).all();
}

function jobRow(
  host: TestHost,
  schedulerId: string,
): typeof schedulerJobs.$inferSelect | undefined {
  return host.client.db
    .select()
    .from(schedulerJobs)
    .where(eq(schedulerJobs.schedulerId, schedulerId))
    .get();
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('two scheduler hosts on one data directory', () => {
  it('fire the same slot once, with one run row and one delivery', async () => {
    const dataDir = await temporaryDataDir();
    const first = await bootHost(dataDir);
    const definition = await first.cron.service.createDefinition({
      name: 'one slot',
      agentName: 'agent-one',
      schedule: { kind: 'once', runAtMs: Date.now() + 2_000 },
      prompt: 'Summarize the queue.',
      sessionTarget: { mode: 'new' },
    });
    // The second host boots after the definition exists, so it restores and arms the same job.
    const second = await bootHost(dataDir);
    const schedulerId = onlySchedulerId(first);
    expect(onlySchedulerId(second)).toBe(schedulerId);

    await waitFor(
      () => jobRow(first, schedulerId)?.state === 'completed',
      8_000,
      'the once job to complete in both hosts',
    );

    const runs = scheduledRuns(first);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerSource).toBe('scheduled');
    expect(runs[0]?.status).toBe('delivered');
    // The identity is unchanged: job, schedule generation, run count.
    expect(runs[0]?.schedulerTriggerId).toBe(`${schedulerId}:0:1`);
    expect(runs[0]?.cronId).toBe(definition.cronId);

    const deliveries = [...first.deliveredRunIds, ...second.deliveredRunIds];
    expect(deliveries).toEqual([runs[0]?.runId]);
  }, 30_000);

  it('stop the other host timer when one host pauses the task', async () => {
    const dataDir = await temporaryDataDir();
    const first = await bootHost(dataDir);
    const definition = await first.cron.service.createDefinition({
      name: 'every second',
      agentName: 'agent-one',
      schedule: { kind: 'recurring', expression: '* * * * * *' },
      prompt: 'Poll the queue.',
      sessionTarget: { mode: 'new' },
    });
    const second = await bootHost(dataDir);
    const schedulerId = onlySchedulerId(second);

    await waitFor(
      () => scheduledRuns(first).length >= 1,
      8_000,
      'the first scheduled run',
    );

    await first.cron.service.updateDefinition({ cronId: definition.cronId, enabled: false });

    // The other host only learns about the pause at its next fire: it reads the cancelled row,
    // adopts it, and stops its own timer instead of running the old expression.
    await waitFor(
      () => second.scheduler.get(schedulerId)?.state === 'cancelled',
      8_000,
      'the second host to adopt the cancelled row',
    );

    const runsAfterPause = scheduledRuns(first).length;
    await sleep(2_000);
    expect(scheduledRuns(first).length).toBe(runsAfterPause);
  }, 40_000);
});

describe('a schedule changed in one host', () => {
  it('is adopted by the other host instead of producing a second run for the slot', async () => {
    const dataDir = await temporaryDataDir();
    const first = await bootHost(dataDir);
    const definition = await first.cron.service.createDefinition({
      name: 'every second',
      agentName: 'agent-one',
      schedule: { kind: 'recurring', expression: '* * * * * *' },
      prompt: 'Poll the queue.',
      sessionTarget: { mode: 'new' },
    });
    const second = await bootHost(dataDir);
    const schedulerId = onlySchedulerId(second);

    // A fire has just happened, so the next slot is a whole second away: change the schedule now
    // and the edit cannot race a peer's advance.
    await waitFor(() => scheduledRuns(first).length >= 1, 8_000, 'the first scheduled run');
    const runsBeforeEdit = scheduledRuns(first).length;
    await first.cron.service.updateDefinition({
      cronId: definition.cronId,
      schedule: { kind: 'recurring', expression: '*/2 * * * * *' },
    });
    expect(jobRow(first, schedulerId)?.scheduleGeneration).toBe(1);

    // The other host still holds generation 0 from boot. Its next fire reads the row, adopts the
    // new generation and the new expression, and aborts; only the editing host fires the slot.
    await waitFor(
      () => scheduledRuns(first).length > runsBeforeEdit,
      8_000,
      'the slot to fire',
    );
    await sleep(600);

    const newRuns = scheduledRuns(first).slice(runsBeforeEdit);
    expect(newRuns).toHaveLength(1);
    expect(newRuns[0]?.schedulerTriggerId).toBe(`${schedulerId}:1:1`);
  }, 40_000);
});

describe('a host whose counter was moved underneath it', () => {
  it('defers that slot and converges on the next one', async () => {
    const dataDir = await temporaryDataDir();
    const host = await bootHost(dataDir);
    await host.cron.service.createDefinition({
      name: 'every second',
      agentName: 'agent-one',
      schedule: { kind: 'recurring', expression: '* * * * * *' },
      prompt: 'Poll the queue.',
      sessionTarget: { mode: 'new' },
    });
    const schedulerId = onlySchedulerId(host);

    await waitFor(() => scheduledRuns(host).length >= 1, 8_000, 'the first scheduled run');
    const armed = jobRow(host, schedulerId);
    if (!armed || armed.nextRunAtMs === null) throw new Error('expected an armed job row');

    // The peer's advance: the durable counter moves while this host's in-memory record does not.
    const peer = new DatabaseClient({ dataDir });
    disposers.push(() => peer.close());
    peer.db
      .update(schedulerJobs)
      .set({ runCount: armed.runCount + 1 })
      .where(eq(schedulerJobs.schedulerId, schedulerId))
      .run();

    const runsBefore = scheduledRuns(host).length;
    // The deferred slot: the host adopts the row and does not fire.
    await sleep(Math.max(0, armed.nextRunAtMs + 400 - Date.now()));
    expect(scheduledRuns(host).length).toBe(runsBefore);
    expect(jobRow(host, schedulerId)?.runCount).toBe(armed.runCount + 1);

    // The next slot: the adopted counter is now the host's own, so it fires exactly once.
    await sleep(Math.max(0, armed.nextRunAtMs + 1_500 - Date.now()));
    expect(scheduledRuns(host).length).toBe(runsBefore + 1);
    expect(jobRow(host, schedulerId)?.runCount).toBe(armed.runCount + 2);
  }, 40_000);
});

function onlySchedulerId(host: TestHost): string {
  const rows = host.client.db.select().from(schedulerJobs).all();
  expect(rows).toHaveLength(1);
  return rows[0]!.schedulerId;
}
