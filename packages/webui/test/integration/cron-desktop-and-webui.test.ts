/**
 * The headline promise of ADR 0027, at host level: the Desktop and the WebUI, both running, one
 * shared data directory.
 *
 * The Desktop's source is not in this repository, so the second host is the same factory booted with
 * the Desktop's runtime owner kind (`electron`) — the row that says a Desktop process is a scheduler
 * host. It changes nothing; every write below comes from the WebUI side, and each assertion reads
 * what the Desktop-kind host reports afterwards.
 *
 * **What this file proves, and what it does not.** It proves the shared store, the arming truth, that
 * an edit reaches the other host, and that a pause survives the other host restarting. It does not
 * re-prove slot-once or delivery-once: those need a controllable clock and countable deliveries, so
 * they live in `cron-two-hosts-slot.integration.test.ts` (one slot, one run, two schedulers) and
 * `packages/webui/test/integration/real-host-cron-runs.test.ts` (one run, one delivery). Stating the
 * split is what keeps each claim reviewable instead of a single test that gestures at everything.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreatedLocalRuntimeHost, LocalRuntimeConfig } from "@mavis/local-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalRuntimeHostV2ForTest } from "../../../local-runtime-v2/src/runtime.js";

type HostWithCron = CreatedLocalRuntimeHost & {
  readonly cliService?: {
    readonly createCronTask?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
    readonly listCronTasks?: (request?: Record<string, unknown>) => Promise<{
      readonly items: readonly Record<string, unknown>[];
    }>;
    readonly updateCronTask?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
    readonly runCronTaskNow?: (cronId: string) => Promise<Record<string, unknown>>;
    readonly listCronTaskRuns?: (query: { readonly cronId: string }) => Promise<{
      readonly items: readonly Record<string, unknown>[];
    }>;
  };
};

const hosts: HostWithCron[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.apiHost.close().catch(() => undefined);
  for (const dir of dataDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot(dataDir: string, runtimeOwnerKind: "webui" | "electron"): Promise<HostWithCron> {
  // Only `dataDir` matters to what this test asserts; the model configuration is never read
  // because no task below fires.
  const config = { dataDir } as unknown as LocalRuntimeConfig;
  const host = await createLocalRuntimeHostV2ForTest({
    dataDir,
    runtimeOwnerKind,
    // The WebUI row owns the v2 runtime through `cliEmbedded`, the Desktop row through
    // `electronHost`; without the cell its own row reads, a host assembles no services at all.
    capabilities:
      runtimeOwnerKind === "electron" ? { electronHost: true } : { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(dataDir, "workspace"),
    // Nothing here reaches a model: a scheduled turn would, so no task below is armed to fire.
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
  hosts.push(host as HostWithCron);
  await host.ready;
  return host as HostWithCron;
}

function cron(host: HostWithCron) {
  const service = host.cliService;
  if (
    !service?.createCronTask ||
    !service.listCronTasks ||
    !service.updateCronTask ||
    !service.runCronTaskNow ||
    !service.listCronTaskRuns
  ) {
    throw new Error("this host does not reach the Cron service");
  }
  return service as Required<NonNullable<HostWithCron["cliService"]>>;
}

describe("the Desktop and the WebUI on one data directory", () => {
  it("arms the same job on both hosts when the Desktop starts second", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cron-two-armed-"));
    dataDirs.push(dataDir);
    await mkdir(join(dataDir, "workspace"), { recursive: true });

    const webui = await boot(dataDir, "webui");
    const created = await cron(webui).createCronTask({
      name: "shared slot",
      agentName: "agent-one",
      prompt: "Do it once per slot.",
      schedule: { kind: "recurring", expression: "0 9 * * *" },
      sessionTarget: { mode: "new" },
    });
    const cronId = String(created.cronId);

    // The Desktop starts after the definition exists, so its boot restore arms it: this is the state
    // ADR 0027 is about — two live hosts, both holding a timer for the same definition.
    const desktop = await boot(dataDir, "electron");
    const armedByDesktop = (await cron(desktop).listCronTasks({})).items[0];
    expect(armedByDesktop).toMatchObject({ cronId, armed: true });
    expect((await cron(webui).listCronTasks({})).items[0]).toMatchObject({ armed: true });

    // Simulating the slot on both sides must still leave one run: both hosts fire the same trigger
    // id, and the run insert converges on it.
    const firstRun = await cron(webui).runCronTaskNow(cronId);
    const runs = await cron(desktop).listCronTaskRuns({ cronId });
    expect(runs.items.map((run) => run.runId)).toContain(String(firstRun.runId));

    // An edit in the WebUI reaches the host that also holds the timer.
    await cron(webui).updateCronTask({
      cronId,
      schedule: { kind: "recurring", expression: "30 3 * * *" },
    });
    expect((await cron(desktop).listCronTasks({})).items[0]).toMatchObject({
      schedule: { kind: "recurring", expression: "30 3 * * *" },
    });
  }, 240_000);

  it("shares one schedule, reports arming truthfully, and keeps a pause", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cron-desktop-webui-"));
    dataDirs.push(dataDir);
    await mkdir(join(dataDir, "workspace"), { recursive: true });

    const webui = await boot(dataDir, "webui");
    // The Desktop is already running when the task appears, as it would be when a person creates one
    // in the browser: a host that was not asked cannot be holding the timer.
    const desktop = await boot(dataDir, "electron");

    const created = await cron(webui).createCronTask({
      name: "nightly digest",
      agentName: "agent-one",
      prompt: "Write the digest.",
      schedule: { kind: "recurring", expression: "0 9 * * *" },
      sessionTarget: { mode: "new" },
    });
    const cronId = String(created.cronId);

    const seenByDesktop = await cron(desktop).listCronTasks({});
    expect(seenByDesktop.items.map((task) => task.cronId)).toEqual([cronId]);
    expect(seenByDesktop.items[0]).toMatchObject({
      name: "nightly digest",
      schedule: { kind: "recurring", expression: "0 9 * * *" },
    });

    // Arming truth: the WebUI holds the job it armed; the Desktop reports it does not hold it, and
    // neither client is told anything about the other's identity — the panel's labels only need this
    // boolean, and naming the other host would be a fact the panel cannot verify.
    const seenByWebui = await cron(webui).listCronTasks({});
    expect(seenByWebui.items[0]?.armed).toBe(true);
    expect(seenByDesktop.items[0]?.armed).toBe(false);

    // An edit made in the WebUI reaches the Desktop.
    await cron(webui).updateCronTask({
      cronId,
      schedule: { kind: "recurring", expression: "30 3 * * *" },
    });
    expect((await cron(desktop).listCronTasks({})).items[0]).toMatchObject({
      schedule: { kind: "recurring", expression: "30 3 * * *" },
    });

    // A pause made in the WebUI sticks — including across the Desktop restarting, which is where a
    // host that wrote back what it restored would resurrect the task.
    await cron(webui).updateCronTask({ cronId, enabled: false });
    const paused = (await cron(desktop).listCronTasks({})).items[0];
    expect(paused).toMatchObject({ enabled: false, armed: false });
    expect(paused?.nextRunAtMs).toBeUndefined();
    expect((await cron(webui).listCronTasks({})).items[0]).toMatchObject({ enabled: false, armed: false });

    await desktop.apiHost.close().catch(() => undefined);
    hosts.splice(hosts.indexOf(desktop), 1);

    const restartedDesktop = await boot(dataDir, "electron");
    const afterRestart = (await cron(restartedDesktop).listCronTasks({})).items[0];
    // The restart is the moment a host that writes back what it restored would resurrect the task.
    expect(afterRestart).toMatchObject({ enabled: false, armed: false });
    expect(afterRestart?.nextRunAtMs).toBeUndefined();
  }, 240_000);
});
