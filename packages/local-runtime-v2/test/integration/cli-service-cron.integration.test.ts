/**
 * #272: the runtime host reaches the Cron service.
 *
 * The WebUI resolves to a v2 host that declares itself a scheduler host, and ADR 0027 says that is
 * only worth anything if the created service is *reachable from the host* rather than sealed
 * inside `createLocalRuntimeHostV2` locals — the condition the retired 0012 record listed and this
 * feature re-opened.
 *
 * This boots the real host with `runtimeOwnerKind: 'webui'` and drives scheduled tasks through its
 * `cliService`, which is the ordinary client-to-runtime boundary: no cron orchestration is
 * imported here, and the assertion is on what the host answers, not on a table's shape.
 *
 * **Not a unit test.** A real host takes tens of seconds and opens SQLite. It uses a temporary data
 * directory and a synthetic agent name; it never touches real user data.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CreatedLocalRuntimeHost, LocalRuntimeConfig } from "@mavis/local-runtime";
import { afterEach, describe, expect, it } from "vitest";

import type { CliService } from "../../src/local/cli-service.js";
import { createLocalRuntimeHostV2ForTest } from "../../src/runtime.js";

/**
 * The CLI service is attached by the v2 assembly (`createStartedHost`), which the V1 host type the
 * factory returns does not declare. Naming it here keeps the test on the real class rather than on
 * a structural stand-in.
 */
type HostWithCliService = CreatedLocalRuntimeHost & { readonly cliService?: CliService };

const hosts: CreatedLocalRuntimeHost[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.apiHost.close().catch(() => undefined);
  for (const dir of dataDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function bootWebuiHost(): Promise<HostWithCliService> {
  const dataDir = await mkdtemp(join(tmpdir(), "cli-service-cron-"));
  dataDirs.push(dataDir);
  await mkdir(join(dataDir, "workspace"), { recursive: true });
  const config: LocalRuntimeConfig = { dataDir };
  const host = await createLocalRuntimeHostV2ForTest({
    dataDir,
    runtimeOwnerKind: "webui",
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(dataDir, "workspace"),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
  hosts.push(host);
  await host.ready;
  return host;
}

describe("a webui host's CLI service and its Cron service", () => {
  it(
    "creates and lists a scheduled task without the caller importing cron orchestration",
    async () => {
      const host = await bootWebuiHost();
      const cliService = host.cliService;
      if (!cliService) throw new Error("the webui host built no CLI service");

      const created = await cliService.createCronTask({
        name: "queue digest",
        agentName: "agent-one",
        schedule: { kind: "recurring", expression: "*/5 * * * *" },
        prompt: "Summarize what is waiting in the queue.",
        sessionTarget: { mode: "new" },
      });

      expect(created.cronId).not.toBe("");
      expect(created.name).toBe("queue digest");
      // The definition is armed: the shared scheduler row carries the next slot, which is what a
      // reachable Cron service means rather than a definition written to a table and forgotten.
      expect(typeof created.nextRunAtMs).toBe("number");
      expect(created.enabled).toBe(true);

      const page = cliService.listCronTasks();
      expect(page.items.map((item) => item.cronId)).toEqual([created.cronId]);
      expect(page.items[0]?.schedule).toEqual({ kind: "recurring", expression: "*/5 * * * *" });
    },
    180_000,
  );

  it(
    "reads the run history of a task it just ran",
    async () => {
      const host = await bootWebuiHost();
      const cliService = host.cliService;
      if (!cliService) throw new Error("the webui host built no CLI service");

      const created = await cliService.createCronTask({
        name: "run history",
        agentName: "agent-one",
        // A far-future slot: this test is about the manual path, not about the timer firing.
        schedule: { kind: "recurring", expression: "0 0 1 1 *" },
        prompt: "Do the thing.",
        sessionTarget: { mode: "new" },
      });

      const run = await cliService.runCronTaskNow(created.cronId);
      expect(run.cronId).toBe(created.cronId);
      expect(run.triggerSource).toBe("manual");

      const runs = cliService.listCronTaskRuns({ cronId: created.cronId });
      expect(runs.items.map((item) => item.runId)).toContain(run.runId);
    },
    180_000,
  );
});
