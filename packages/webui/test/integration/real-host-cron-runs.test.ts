/**
 * Running a scheduled task now, and reading what happened.
 *
 * Two claims, and they are different claims:
 *
 *   1. the WebUI can trigger a run and read its history across the real boundary;
 *   2. a run triggered on demand executes **exactly once** even when another host shares the data
 *      directory — which is not a property of the trigger but of `claimExecution` being atomic.
 *
 * Section 1 boots the production assembly. Section 2 uses two real Cron compositions over one SQLite
 * file with counting delivery ports, because "delivered once" is only observable where deliveries
 * are counted, and a real host would try to deliver a turn to a model.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseClient } from "../../../local-runtime-v2/src/infra/db/client.js";
import { initializeDatabase } from "../../../local-runtime-v2/src/infra/db/initialize.js";
import { cronRuns } from "../../../local-runtime-v2/src/infra/db/schema/cron.js";
import { Scheduler } from "../../../local-runtime-v2/src/infra/scheduler/index.js";
import { composeCronService } from "../../../local-runtime-v2/src/service/cron/composition.js";
import { createWebuiRuntimeHost } from "../../src/runtime/assembly.js";
import { createOperationRegistry } from "../../src/server/operation/operations.js";

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function temporaryDataDir(prefix: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  disposers.push(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, "workspace"), { recursive: true });
  return dataDir;
}

describe("run now and run history over the real host", () => {
  it("runs a task immediately and shows the run in its history", async () => {
    const dataDir = await temporaryDataDir("webui-cron-runs-");
    const assembled = await createWebuiRuntimeHost({ dataDir, appVersion: "cron-runs" });
    disposers.push(() => assembled.host.apiHost.close().catch(() => undefined));
    const registry = createOperationRegistry(assembled.harnessPort);
    const call = async (name: string, body: unknown): Promise<unknown> => {
      const entry = registry.get(name);
      if (!entry) throw new Error(`${name} was not registered`);
      return ((await entry.handle({ requestId: `${name}-1` }, body)) as { body?: unknown }).body;
    };
    const cliService = assembled.host.cliService;
    if (!cliService?.createCronTask) throw new Error("the webui host reaches no Cron service");

    const created = (await call("createCronTask", {
      name: "run now",
      agentName: "agent-one",
      prompt: "Do it now.",
      // A slot far away: this test is about the manual path, not about the timer.
      schedule: { kind: "recurring", expression: "0 0 1 1 *" },
      sessionTarget: { mode: "new" },
    })) as Record<string, unknown>;
    const cronId = String(created.cronId);

    const run = (await call("runCronTaskNow", { cronId })) as Record<string, unknown>;
    expect(run.cronId).toBe(cronId);
    expect(run.triggerSource).toBe("manual");
    expect(String(run.runId)).not.toBe("");

    const page = (await call("listCronTaskRuns", { cronId })) as {
      items: readonly Record<string, unknown>[];
    };
    expect(page.items.map((item) => item.runId)).toContain(run.runId);
    expect(page.items[0]).toMatchObject({ triggerSource: "manual", cronId });

    // A second trigger is a second run: on demand means on demand.
    const second = (await call("runCronTaskNow", { cronId })) as Record<string, unknown>;
    expect(second.runId).not.toBe(run.runId);
    const after = (await call("listCronTaskRuns", { cronId })) as {
      items: readonly Record<string, unknown>[];
    };
    expect(after.items).toHaveLength(2);
  }, 240_000);
});

describe("a run triggered on demand executes exactly once", () => {
  it("delivers once even when another host recovers the same run", async () => {
    const dataDir = await temporaryDataDir("webui-cron-run-once-");
    const first = new DatabaseClient({ dataDir });
    disposers.push(() => first.close());
    await initializeDatabase({ database: first, dataDir });

    const deliveredRunIds: string[] = [];
    const ports = {
      sessionCreation: { create: async (request: { runId: string }) => ({ sessionId: `session-${request.runId}` }) },
      delivery: {
        deliver: async (request: { runId: string; sessionId: string }) => {
          // The session id makes a redelivery of the same run observable: it is the same everywhere.
          deliveredRunIds.push(`${request.runId}@${request.sessionId}`);
          return { delivered: true as const };
        },
      },
    };

    const schedulerA = new Scheduler({ db: first.db });
    disposers.push(() => schedulerA.stop());
    const cronA = composeCronService({ db: first.db, scheduler: schedulerA, sessionPorts: ports });
    schedulerA.start({ restorePersistedJobExecution: true });

    const created = await cronA.service.createDefinition({
      name: "on demand",
      agentName: "agent-one",
      schedule: { kind: "recurring", expression: "0 0 1 1 *" },
      prompt: "Do it once.",
      sessionTarget: { mode: "new" },
    });

    const run = await cronA.service.triggerManualRun(created.cronId);
    await cronA.close();
    expect(deliveredRunIds).toEqual([`${run.runId}@session-${run.runId}`]);

    const rows = first.db.select().from(cronRuns).where(eq(cronRuns.cronId, created.cronId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("delivered");
    expect(rows[0]?.schedulerTriggerId).toBeNull();

    // A second host on the same data directory recovers pending runs at boot. The run above is
    // already delivered, so nothing is redelivered — and if it were still pending, the atomic claim
    // would still let only one host execute it.
    const second = new DatabaseClient({ dataDir });
    disposers.push(() => second.close());
    const schedulerB = new Scheduler({ db: second.db });
    disposers.push(() => schedulerB.stop());
    const cronB = composeCronService({ db: second.db, scheduler: schedulerB, sessionPorts: ports });
    schedulerB.start({ restorePersistedJobExecution: true });
    await cronB.recoverPendingRuns();
    await cronB.close();

    expect(deliveredRunIds).toEqual([`${run.runId}@session-${run.runId}`]);
    expect(
      second.db.select().from(cronRuns).where(eq(cronRuns.cronId, created.cronId)).all(),
    ).toHaveLength(1);
  }, 120_000);
});
