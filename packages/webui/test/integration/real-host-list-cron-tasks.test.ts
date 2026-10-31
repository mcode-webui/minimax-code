/**
 * `listCronTasks` across the real boundary.
 *
 * What is real here: the production WebUI assembly (`createWebuiRuntimeHost`, the `webui` owner
 * kind with its quarantined cold start), the production harness adapter and its conversions, the
 * production operation binding with its validator, and the production operation registry built from
 * them. What is not real: the browser.
 *
 * Driving the list this way rather than calling the port directly is the point — the claim under
 * review is a seam claim. "A person opens the panel and sees the tasks" depends on the registry
 * entry forwarding to a capability, the adapter converting the runtime's cron view into the WebUI's
 * own DTO, and the validator accepting the envelope the panel actually sends. Each of those rots
 * independently, so the assertion runs through all of them.
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

async function bootWebuiHost() {
  const dataDir = await mkdtemp(join(tmpdir(), "webui-list-cron-tasks-"));
  disposers.push(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, "workspace"), { recursive: true });
  const assembled = await createWebuiRuntimeHost({ dataDir, appVersion: "list-cron-tasks" });
  disposers.push(() => assembled.host.apiHost.close().catch(() => undefined));
  return assembled;
}

/** The unary body of a registry answer, rejecting the stream shape this operation never returns. */
function unaryBody(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || !("body" in result)) {
    throw new Error("listCronTasks answered with a non-unary result");
  }
  return (result as { readonly body: Record<string, unknown> }).body;
}

describe("listCronTasks over the real service and the real host", () => {
  it("answers with the WebUI's own task page for a task the host holds", async () => {
    const assembled = await bootWebuiHost();
    const cliService = assembled.host.cliService;
    if (!cliService?.createCronTask) {
      throw new Error("the webui host reaches no Cron service");
    }

    const created = await cliService.createCronTask({
      name: "queue digest",
      agentName: "agent-one",
      schedule: { kind: "recurring", expression: "0 9 * * *" },
      prompt: "Summarize what is waiting in the queue.",
      sessionTarget: { mode: "new" },
    });

    const entry = createOperationRegistry(assembled.harnessPort).get("listCronTasks");
    if (!entry) throw new Error("listCronTasks was not registered");

    const body = unaryBody(await entry.handle({ requestId: "list-1" }, undefined));

    expect(body.hasMore).toBe(false);
    const items = body.items as readonly Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      cronId: created.cronId,
      name: "queue digest",
      agentName: "agent-one",
      enabled: true,
      schedule: { kind: "recurring", expression: "0 9 * * *" },
      sessionTarget: { mode: "new" },
      project: null,
      model: null,
    });
    // The next fire time comes from the shared scheduler row, not from the definition alone.
    expect(typeof items[0]?.nextRunAtMs).toBe("number");
  }, 240_000);

  it("validates the paging envelope before the capability sees it", async () => {
    const assembled = await bootWebuiHost();
    const entry = createOperationRegistry(assembled.harnessPort).get("listCronTasks");
    if (!entry) throw new Error("listCronTasks was not registered");

    // The dispatcher validates, not the binding, so the validator is asserted where it runs.
    const { operation } = entry;
    expect(operation.validate(undefined)).toEqual({ ok: true, body: {} });
    expect(operation.validate({ agentName: "agent-one", limit: 10 })).toEqual({
      ok: true,
      body: { agentName: "agent-one", limit: 10 },
    });
    expect(operation.validate({ limit: 0 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("limit must be an integer"),
    });
    expect(operation.validate({ cursor: "  " })).toMatchObject({ ok: false });
    expect(operation.validate({ limit: 10_000 })).toMatchObject({ ok: false });
  }, 240_000);
});
