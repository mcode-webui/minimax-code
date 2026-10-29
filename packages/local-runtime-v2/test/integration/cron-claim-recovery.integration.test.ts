/**
 * ADR 0027 R4: a claimed run records its claimant, and recovery is scoped to it.
 *
 * Before this rule, `recoverPendingRuns` marked **every** claimed pending run failed at boot. That
 * is wrong in both directions once the WebUI executes: the Desktop's boot sweep kills a live WebUI
 * run, and a WebUI that never sweeps leaves its own crashed run pending forever — and `delete` then
 * refuses the definition with "Cron definition has pending runs", so a WebUI-only user is left with
 * a cron they cannot remove.
 *
 * Section 1 drives the real Cron composition over real SQLite with a real runtime-owner identity.
 * Section 2 boots the real WebUI host twice to prove its boot recovery actually runs.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreatedLocalRuntimeHost, LocalRuntimeConfig } from "@mavis/local-runtime";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseClient } from "../../src/infra/db/client.js";
import { initializeDatabase } from "../../src/infra/db/initialize.js";
import { cronDefinitions, cronRuns } from "../../src/infra/db/schema/cron.js";
import { createRuntimeOwnerIdentity } from "../../src/infra/runtime-owner/identity.js";
import { Scheduler } from "../../src/infra/scheduler/index.js";
import {
  composeCronService,
  type CronClaimRecoveryOptions,
} from "../../src/service/cron/composition.js";
import { createLocalRuntimeHostV2ForTest } from "../../src/runtime.js";

const disposers: Array<() => Promise<void> | void> = [];
const dataDirs: string[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  for (const dir of dataDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temporaryDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "cron-claim-recovery-"));
  dataDirs.push(dataDir);
  return dataDir;
}

async function openDatabase(dataDir: string): Promise<DatabaseClient> {
  const client = new DatabaseClient({ dataDir });
  disposers.push(() => client.close());
  await initializeDatabase({ database: client, dataDir });
  return client;
}

interface Composition {
  readonly scheduler: Scheduler;
  readonly cron: ReturnType<typeof composeCronService>;
}

function compose(
  client: DatabaseClient,
  recovery: CronClaimRecoveryOptions | undefined,
): Composition {
  const scheduler = new Scheduler({ db: client.db });
  disposers.push(() => scheduler.stop());
  const cron = composeCronService({
    db: client.db,
    scheduler,
    ...(recovery ? { recovery } : {}),
  });
  scheduler.start({ restorePersistedJobExecution: true });
  return { scheduler, cron };
}

/** Seeds a pending run that a crashed host claimed, the way that host's claim would have left it. */
let seededRuns = 0;

function seedClaimedRun(
  client: DatabaseClient,
  cronId: string,
  claimOwnerId: string | undefined,
): string {
  const runId = `run-${randomUUID()}`;
  const now = Date.now();
  seededRuns += 1;
  client.db
    .insert(cronRuns)
    .values({
      runId,
      cronId,
      schedulerTriggerId: `${cronId}:0:${String(seededRuns)}`,
      triggerSource: "scheduled",
      status: "pending",
      createdAtMs: now,
      executionClaimedAtMs: now,
      ...(claimOwnerId === undefined ? {} : { ownerInstanceId: claimOwnerId }),
    })
    .run();
  return runId;
}

function readRun(client: DatabaseClient, runId: string) {
  return client.db.select().from(cronRuns).where(eq(cronRuns.runId, runId)).get();
}

async function createTask(
  cron: Composition["cron"],
  dataDir: string,
): Promise<string> {
  const created = await cron.service.createDefinition({
    name: `task-${randomUUID().slice(0, 8)}`,
    agentName: "agent-one",
    schedule: { kind: "recurring", expression: "0 0 1 1 *" },
    prompt: "Do the thing.",
    sessionTarget: { mode: "new" },
  });
  expect(created.cronId).not.toBe("");
  return created.cronId;
}

describe("recovery is scoped to the claimant", () => {
  it("leaves a run claimed by a live host alone, and reclaims the one whose claimant is gone", async () => {
    const dataDir = await temporaryDataDir();
    const client = await openDatabase(dataDir);
    const live = await createRuntimeOwnerIdentity({ dataDir });
    disposers.push(() => live.close());

    const { cron } = compose(client, {
      claimOwnerId: live.createOwnerId("cron-run"),
      isClaimantAlive: (ownerId) => live.isOwnerAlive(ownerId),
      reclaimUnattributedRuns: false,
    });
    const cronId = await createTask(cron, dataDir);

    const aliveRunId = seedClaimedRun(client, cronId, live.createOwnerId("cron-run"));
    const deadOwnerId = `cron-run:${String(process.pid)}:${randomUUID()}.gone`;
    const deadRunId = seedClaimedRun(client, cronId, deadOwnerId);

    await cron.recoverPendingRuns();

    // The live claimant still owns its run: its process may be mid-execution right now.
    expect(readRun(client, aliveRunId)?.status).toBe("pending");
    // The dead one is reclaimed, visibly, with the reason a restart leaves.
    const reclaimed = readRun(client, deadRunId);
    expect(reclaimed?.status).toBe("failed");
    expect(reclaimed?.errorCode).toBe("PROCESS_RESTARTED");
  }, 60_000);

  it("honours the host's scope for a run that records no claimant", async () => {
    const dataDir = await temporaryDataDir();
    const client = await openDatabase(dataDir);

    // A peer's sweep (the WebUI) must not touch a run it cannot attribute: the live Desktop may
    // still be executing it.
    const peer = compose(client, { reclaimUnattributedRuns: false });
    const peerCronId = await createTask(peer.cron, dataDir);
    const peerRunId = seedClaimedRun(client, peerCronId, undefined);
    await peer.cron.recoverPendingRuns();
    expect(readRun(client, peerRunId)?.status).toBe("pending");
    peer.cron.close();
    peer.scheduler.stop();

    // The Desktop's own scope is unchanged: its global sweep still reclaims them.
    const desktop = compose(client, { reclaimUnattributedRuns: true });
    await desktop.cron.recoverPendingRuns();
    expect(readRun(client, peerRunId)?.status).toBe("failed");
  }, 60_000);

  it("ends the pending run a dead host left behind, so the task can be removed", async () => {
    const dataDir = await temporaryDataDir();
    const client = await openDatabase(dataDir);
    const { cron } = compose(client, {
      isClaimantAlive: () => false,
      reclaimUnattributedRuns: false,
    });
    const cronId = await createTask(cron, dataDir);
    const runId = seedClaimedRun(
      client,
      cronId,
      `cron-run:${String(process.pid)}:${randomUUID()}.gone`,
    );

    // The residue: a run stuck in `pending` for ever, shown as running in history and never
    // reaching a terminal state.
    expect(readRun(client, runId)?.status).toBe("pending");

    await cron.recoverPendingRuns();
    expect(readRun(client, runId)?.status).toBe("failed");

    // And the task itself can be removed. Product deletion tombstones the definition and keeps the
    // run rows (`deleteRuns: false`), so the definition leaving the list is the observable outcome.
    await cron.service.deleteDefinition({ cronId });
    expect(cron.service.listDefinitions({}).items.map((item) => item.cronId)).not.toContain(cronId);
    expect(
      client.db.select().from(cronDefinitions).where(eq(cronDefinitions.cronId, cronId)).get()
        ?.deletedAtMs,
    ).toEqual(expect.any(Number));
  }, 60_000);
});

describe("a WebUI host's boot recovery", () => {
  it("sweeps a run its dead instance claimed, so the task is deletable again", async () => {
    const dataDir = await temporaryDataDir();

    // The first boot creates the schema and the definition, then leaves a run claimed by an
    // instance that no longer exists — the state a crashed WebUI leaves behind.
    const first = await bootWebuiHost(dataDir);
    const firstCli = first.cliService;
    if (!firstCli) throw new Error("the webui host built no CLI service");
    const created = await firstCli.createCronTask({
      name: "left behind",
      agentName: "agent-one",
      schedule: { kind: "recurring", expression: "0 0 1 1 *" },
      prompt: "Never delivered.",
      sessionTarget: { mode: "new" },
    });
    await first.apiHost.close();

    const seeder = new DatabaseClient({ dataDir });
    disposers.push(() => seeder.close());
    const runId = seedClaimedRun(
      seeder,
      created.cronId,
      `cron-run:${String(process.pid)}:${randomUUID()}.gone`,
    );
    seeder.close();

    const second = await bootWebuiHost(dataDir);
    const secondCli = second.cliService;
    if (!secondCli) throw new Error("the rebooted webui host built no CLI service");

    const reader = new DatabaseClient({ dataDir });
    disposers.push(() => reader.close());
    const swept = readRun(reader, runId);
    expect(swept?.status).toBe("failed");
    expect(swept?.errorCode).toBe("PROCESS_RESTARTED");

    // And the definition can be removed again, which is the user-visible point of the rule.
    await secondCli.deleteCronTask({ cronId: created.cronId });
    expect(secondCli.listCronTasks().items).toEqual([]);
  }, 240_000);
});

async function bootWebuiHost(dataDir: string): Promise<CreatedLocalRuntimeHost & {
  readonly cliService?: import("../../src/local/cli-service.js").CliService;
}> {
  const config: LocalRuntimeConfig = { dataDir };
  const host = await createLocalRuntimeHostV2ForTest({
    dataDir,
    runtimeOwnerKind: "webui",
    startupExecutionPolicy: "quarantined",
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(dataDir, "workspace"),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
  disposers.push(() => host.apiHost.close().catch(() => undefined));
  await host.ready;
  return host as CreatedLocalRuntimeHost & {
    readonly cliService?: import("../../src/local/cli-service.js").CliService;
  };
}
