/**
 * Creating, editing, disabling and deleting a scheduled task across the real boundary.
 *
 * Real: the production WebUI assembly (the `webui` owner with its quarantined cold start), the
 * harness adapter, the three operation validators, the bindings and the registry. Not real: the
 * browser.
 *
 * The outcome is asserted against the runtime, not against what the operation echoed back — a
 * definition's schedule generation and next fire time belong to the shared row, and an operation
 * that answered with its own request would pass this test while the task ran on the wrong schedule.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWebuiRuntimeHost } from "../../src/runtime/assembly.js";
import { createOperationRegistry } from "../../src/server/operation/operations.js";

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), "webui-cron-mutations-"));
  disposers.push(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, "workspace"), { recursive: true });
  const assembled = await createWebuiRuntimeHost({ dataDir, appVersion: "cron-mutations" });
  disposers.push(() => assembled.host.apiHost.close().catch(() => undefined));
  const registry = createOperationRegistry(assembled.harnessPort);
  const call = async (name: string, body: unknown): Promise<unknown> => {
    const entry = registry.get(name);
    if (!entry) throw new Error(`${name} was not registered`);
    const result = (await entry.handle({ requestId: `${name}-1` }, body)) as { body?: unknown };
    return result.body;
  };
  return { assembled, registry, call };
}

describe("scheduled-task mutations over the real service and the real host", () => {
  it("creates, edits, disables and deletes a task, and the runtime follows each step", async () => {
    const { assembled, call } = await boot();
    const cliService = assembled.host.cliService;
    if (!cliService?.listCronTasks) throw new Error("the webui host reaches no Cron service");

    const created = (await call("createCronTask", {
      name: "queue digest",
      agentName: "agent-one",
      prompt: "Summarize the queue.",
      schedule: { kind: "recurring", expression: "0 9 * * *" },
      sessionTarget: { mode: "new" },
    })) as Record<string, unknown>;
    const cronId = String(created.cronId);
    expect(cronId).not.toBe("");
    // The answer is the stored definition: it is armed, and the next slot came from the scheduler.
    expect(created).toMatchObject({ name: "queue digest", enabled: true, heldByThisClient: true });
    expect(typeof created.nextRunAtMs).toBe("number");
    expect(cliService.listCronTasks().items.map((item) => item.cronId)).toEqual([cronId]);

    // Editing the schedule and the request keeps the same definition — no delete and recreate.
    const edited = (await call("updateCronTask", {
      cronId,
      schedule: { kind: "recurring", expression: "*/15 * * * *" },
      prompt: "Summarize the queue, briefly.",
    })) as Record<string, unknown>;
    expect(edited.cronId).toBe(cronId);
    expect(edited.schedule).toEqual({ kind: "recurring", expression: "*/15 * * * *" });
    const stored = cliService.listCronTasks().items.find((item) => item.cronId === cronId);
    expect(stored?.schedule).toEqual({ kind: "recurring", expression: "*/15 * * * *" });

    // Turning it off cancels the armed job in the shared row, which is what another host adopts.
    const disabled = (await call("updateCronTask", { cronId, enabled: false })) as Record<
      string,
      unknown
    >;
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAtMs).toBeUndefined();

    // And back on again.
    const enabled = (await call("updateCronTask", { cronId, enabled: true })) as Record<
      string,
      unknown
    >;
    expect(enabled.enabled).toBe(true);
    expect(typeof enabled.nextRunAtMs).toBe("number");

    await call("deleteCronTask", { cronId });
    expect(cliService.listCronTasks().items).toEqual([]);
  }, 240_000);

  it("names the field a rejected task got wrong", async () => {
    const { registry, call } = await boot();
    // The dispatcher validates before the binding runs, so the validator is asserted where it
    // actually runs — and the message is what the editor puts beside the field.
    const create = registry.get("createCronTask")?.operation;
    const update = registry.get("updateCronTask")?.operation;
    if (!create || !update) throw new Error("the scheduling mutations were not registered");

    expect(
      create.validate({
        name: " ",
        agentName: "agent-one",
        prompt: "x",
        schedule: { kind: "recurring", expression: "0 9 * * *" },
        sessionTarget: { mode: "new" },
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("name") });

    expect(
      create.validate({
        name: "ok",
        agentName: "agent-one",
        prompt: "x",
        schedule: { kind: "recurring", expression: "0 9 * *" },
        sessionTarget: { mode: "new" },
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("schedule.expression") });

    expect(
      create.validate({
        name: "ok",
        agentName: "agent-one",
        prompt: "x",
        schedule: { kind: "once", runAtMs: 0 },
        sessionTarget: { mode: "new" },
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("schedule.runAtMs") });

    // A patch with nothing to change is a mistake, not a no-op.
    expect(update.validate({ cronId: "cron-1" })).toMatchObject({ ok: false });

    // And the runtime refuses the same empty name on its own, so the two messages stay honest even
    // though only the validator's reaches the panel.
    await expect(
      call("createCronTask", {
        name: " ",
        agentName: "agent-one",
        prompt: "x",
        schedule: { kind: "recurring", expression: "0 9 * * *" },
        sessionTarget: { mode: "new" },
      }),
    ).rejects.toBeInstanceOf(Error);
  }, 240_000);
});
