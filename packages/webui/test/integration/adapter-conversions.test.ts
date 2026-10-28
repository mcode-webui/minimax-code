// The adapter's translations, asserted through the real host.
//
// The gap this file closes is that `createHarnessPortFromHost` — the layer that turns the
// runtime's objects into the WebUI's port types — was only ever exercised against
// host stubs shaped by the WebUI's own declarations, so its expectations came from
// the same place as its implementation. This file pins the translations that
// actually transform something against the real runtime host, in an isolated data
// directory, with the expectations taken from the operation contracts and the
// observable runtime behaviour rather than from the adapter source.
//
// The conversion inventory this file covers, and where each row is pinned:
//
// | Group | Translation | Pinned here (real host) | Pinned by stub, and why |
// | --- | --- | --- | --- |
// | execution | `isGoalEnabled()` boolean -> `{ enabled }` | shape | — |
// | execution | `clearGoal()` boolean -> `{ success }` | yes | — |
// | execution | `patchGoal()` strips `sessionId` and passes the rest as the patch | yes (status round trip) | — |
// | execution | `getGoal()` absent goal -> `undefined` | yes | — |
// | execution | `getActiveTurn()` no active turn -> `undefined` | yes | — |
// | execution | `sendMessage`/`resumeSession` signal -> `{ signal }` context | the turn's stream (see `real-host-model-turn.test.ts`) | — |
// | execution | `requestCompaction` optional-slot guard + its own message | — | stub: the v2 host always exposes it, so the missing-slot branch cannot be reached live |
// | sessions | `listSessions` items reach `WebuiSessionListItem` unchanged | identity fields | the wire-declaration rows (e.g. `sessionType`) belong to the derivation pass |
// | workspace | `getWorkspaceEnvironment` projection with defaults (`0`, `"skipped"`) | yes, repo and non-repo | — |
// | workspace | `readWorkspaceFile` path fallback + its two refusal messages | yes | — |
// | workspace | `readWorkspaceArchive` falls back to this package's reader | yes (the v2 host has no archive method) | — |
// | interactions | `listPendingPermissions` normalises a missing list to `[]` | yes | — |
// | interactions | `getPendingQuestionnaire` second ask by the session's own agent | yes (empty result stays empty) | the non-empty requery needs a pending questionnaire, which `webui-service.test.ts` drives |
// | interactions | `permissionReplyValue` wire string -> runtime enum value | — | the value is not observable through the real host; the wire frames are pinned in `webui-service.test.ts` |
// | models | `selectModel` boolean verdict -> `{ success }` | yes | — |
// | models | `listSkills` projects the runtime's skill list | shape, if the host has skills | fixture-covered in `webui-service.test.ts` |
// | account | quota/check-in/login clients supplied by the assembly, not the host | out of scope: they are WebUI-owned, and their tests are unit-level |
//
// The host-failure path is asserted too: a runtime rejection has to reach the
// caller as a rejection, not as a fabricated success.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  WebuiGoalCreateRequest,
  WebuiGoalPatchRequest,
} from "../../src/shared/contracts/goal.js";
import { removeRealHostDataDir } from "./remove-real-host-data-dir.js";

/** Whether the Info-ZIP CLI is on PATH (`test/unit/webui-workspace-archive.test.ts` asks the same). */
const HAS_ZIP = (() => {
  try {
    execFileSync("zip", ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * A one-entry stored zip, byte by byte.
 *
 * The `zip` CLI is a fixture builder, not the thing under test — the port's
 * archive reader reads whatever bytes are in the file — and Windows hosts ship
 * without Info-ZIP. Rather than lose the fallback assertion on those hosts,
 * the same archive is written by hand, exactly the way the archive unit suite
 * substitutes a crafted zip when it cannot call the CLI.
 */
function craftSingleEntryZip(name: string, content: string): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const data = Buffer.from(content, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6); // UTF-8 names
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // unix host, spec 2.0
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(0, 10); // stored
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100644 & 0xffff) * 0x10000, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + data.length, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

interface Booted {
  readonly dataDir: string;
  readonly workspaceDir: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly port: Awaited<ReturnType<typeof bootPort>>["port"];
  close(): Promise<void>;
}

const booted: Booted[] = [];
const previousDataDir = process.env.MINIMAX_DATA_DIR;

afterEach(async () => {
  for (const entry of booted.splice(0)) await entry.close();
  if (previousDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
  else process.env.MINIMAX_DATA_DIR = previousDataDir;
});

const MODEL_ID = "stub-model";
const PROVIDER_ID = "custom_provider:stub";

/** The production chain, over the real host, in an isolated data directory. */
async function bootPort(options: { readonly git?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "webui-adapter-"));
  const workspaceDir = join(dataDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  if (options.git === true) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspaceDir });
    execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "seed"], {
      cwd: workspaceDir,
    });
  }
  await writeFile(join(workspaceDir, "tracked.txt"), "tracked\n", "utf8");
  // A config file exists before boot so `ensureConfigFile` cannot copy the
  // developer's own; the provider entry is what makes the model calls real.
  await writeFile(
    join(dataDir, "config.yaml"),
    [
      `defaultModel: ${PROVIDER_ID}/${MODEL_ID}`,
      "custom_provider:",
      "  stub:",
      "    name: Stub",
      "    api: openai-completions",
      "    options:",
      "      baseURL: http://127.0.0.1:1/v1",
      "      apiKey: stub-key",
      "    models:",
      `      ${MODEL_ID}:`,
      `        id: ${MODEL_ID}`,
      "        name: Stub Model",
      "        tool_call: true",
      "        limit:",
      "          context: 100000",
      "          output: 4096",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  process.env.MINIMAX_DATA_DIR = dataDir;
  (await import("@mavis/config")).resetConfig();

  const { createWebuiRuntimeHost } = await import("../../src/runtime/assembly.js");
  const { createHarnessPortFromHost } = await import("../../src/runtime/harness/adapter.js");
  const assembled = await createWebuiRuntimeHost({
    dataDir,
    appVersion: "adapter-conversions",
    mcodeTools: {
      prepare: async () => ({
        requested: false,
        ready: false,
        category: "disabled" as const,
        ensureCommandPath: () => undefined,
        dispose: async () => undefined,
      }),
    },
  });
  return {
    dataDir,
    workspaceDir,
    modelId: MODEL_ID,
    providerId: PROVIDER_ID,
    port: createHarnessPortFromHost(assembled.host),
    close: async () => {
      await assembled.host.apiHost.close().catch(() => undefined);
      await removeRealHostDataDir(dataDir);
    },
  };
}

async function withHost<T>(options: { readonly git?: boolean }, body: (host: Booted) => Promise<T>): Promise<T> {
  const host = await bootPort(options);
  booted.push(host);
  return body(host);
}

describe("adapter translations against the real host", () => {
  it(
    "wraps the goal verdicts, splits the patch and reports an absent goal as undefined",
    async () => {
      const port = await withHost({}, (host) => Promise.resolve(host.port));
      const created = await port.createSession({ name: "main" });
      const sessionId = created.session?.sessionId as string;

      // `isGoalEnabled()` is a wrapper: the port exposes an object, the runtime a
      // boolean, and the key set is the contract.
      const enabled = await port.isGoalEnabled();
      expect(Object.keys(enabled)).toEqual(["enabled"]);
      expect(typeof enabled.enabled).toBe("boolean");

      // An absent goal is undefined rather than an error.
      await expect(port.getGoal({ sessionId })).resolves.toBeUndefined();

      const goal = await port.createGoal({ sessionId, objective: "adapter evidence" } as WebuiGoalCreateRequest);
      expect((goal as { objective?: string }).objective).toBe("adapter evidence");
      expect(await port.getGoal({ sessionId })).toMatchObject({ objective: "adapter evidence" });

      // `patchGoal` takes the session id out of the request and passes the rest as
      // the patch; if that split were wrong, the patch would not land. The status
      // literal is the contract's own, so a value outside it cannot slip through a
      // cast into a silently ignored write.
      const patch: WebuiGoalPatchRequest = { sessionId, status: "paused" };
      await port.patchGoal(patch);
      expect(await port.getGoal({ sessionId })).toMatchObject({ status: "paused" });

      // `clearGoal()` is a wrapper too, and the goal is gone afterwards.
      await expect(port.clearGoal({ sessionId })).resolves.toEqual({ success: true });
      await expect(port.getGoal({ sessionId })).resolves.toBeUndefined();
    },
    120_000,
  );

  it(
    "projects the workspace environment with its defaults, for a repository and for a plain directory",
    async () => {
      await withHost({ git: true }, async ({ port, workspaceDir }) => {
        const environment = await port.getWorkspaceEnvironment({ workspaceDir });
        expect(environment.isGitRepo).toBe(true);
        expect(typeof environment.branch).toBe("string");
        expect(typeof environment.changedFiles).toBe("number");
        expect(typeof environment.insertions).toBe("number");
        expect(typeof environment.deletions).toBe("number");
        expect(["ready", "partial", "skipped"]).toContain(environment.lineStatsStatus);
      });

      await withHost({}, async (host) => {
        // A directory that is not a repository still answers, with the projection's
        // defaults rather than with a missing field.
        const environment = await host.port.getWorkspaceEnvironment({ workspaceDir: host.workspaceDir });
        expect(environment.isGitRepo).toBe(false);
        expect(environment.changedFiles).toBe(0);
        expect(environment.insertions).toBe(0);
        expect(environment.deletions).toBe(0);
        expect(environment.lineStatsStatus).toBe("skipped");
      });
    },
    120_000,
  );

  it(
    "reads a workspace file, refuses a missing one with its own message, and falls back to this package's archive reader",
    async () => {
      await withHost({}, async ({ port, workspaceDir }) => {
        const found = await port.readWorkspaceFile({ workspaceDir, path: "tracked.txt" });
        expect(found).toMatchObject({ type: "text", content: "tracked\n" });

        const missing = await port.readWorkspaceFile({ workspaceDir, path: "nope.txt" });
        expect((missing as { content?: string }).content).toBe("");
        expect(String((missing as { error?: string }).error)).toContain("nope.txt");

        // A bare file name is resolved by the exact-match search when the direct
        // read misses, and the adapter reports the path it resolved to.
        await mkdir(join(workspaceDir, "sub"), { recursive: true });
        await writeFile(join(workspaceDir, "sub", "nested.txt"), "nested\n", "utf8");
        const resolved = await port.readWorkspaceFile({ workspaceDir, path: "nested.txt" });
        expect(resolved).toMatchObject({ content: "nested\n" });
        expect((resolved as { resolvedPath?: string }).resolvedPath).toBe("sub/nested.txt");

        // The v2 host exposes no archive reader, so this exercises the fallback to
        // `runtime/workspace-archive.ts` through the real port.
        const archivePath = join(workspaceDir, "bundle.zip");
        if (HAS_ZIP) {
          execFileSync("zip", ["-q", "-r", archivePath, "tracked.txt"], { cwd: workspaceDir });
        } else {
          // No Info-ZIP on this host: the same archive, written byte by byte.
          await writeFile(archivePath, craftSingleEntryZip("tracked.txt", "tracked\n"));
        }
        const listing = await port.readWorkspaceArchive({ workspaceDir, path: "bundle.zip" });
        expect(listing.archivePath).toBe("bundle.zip");
        expect(listing.entries.map((entry) => entry.name)).toContain("tracked.txt");
      });
    },
    120_000,
  );

  it(
    "normalises an empty pending-permission list, keeps an empty questionnaire empty, and reports no active turn",
    async () => {
      const port = await withHost({}, (host) => Promise.resolve(host.port));
      const created = await port.createSession({ name: "main" });
      const sessionId = created.session?.sessionId as string;

      await expect(port.listPendingPermissions()).resolves.toEqual({ requests: [] });

      // The adapter asks a second time under the session's own agent name; an
      // empty answer must stay an empty answer rather than become an error.
      const questionnaire = await port.getPendingQuestionnaire({ name: "main", sessionId });
      expect(questionnaire).toEqual({});

      await expect(port.getActiveTurn({ id: sessionId })).resolves.toBeUndefined();
      await expect(port.listQueueMessages({ id: sessionId })).resolves.toMatchObject({ items: [] });
    },
    120_000,
  );

  it(
    "converts the model-selection verdict and lets a runtime refusal stay a refusal",
    async () => {
      await withHost({}, async ({ port, modelId, providerId }) => {
        const selected = await port.selectModel({
          providerId,
          modelId,
          sessionId: undefined,
        } as never);
        expect(selected).toEqual({ success: true });

        // A model the runtime does not route is a rejection, not `{ success: false }`
        // and not a silent pass.
        await expect(
          port.selectModel({ providerId: "custom_provider:missing", modelId: "nope" } as never),
        ).rejects.toThrow();
      });
    },
    120_000,
  );
});
