// Agent main memory (K area) — the storage contract, pinned against a real
// temp data dir rather than a re-implementation.
//
// What matters here and cannot be asserted from a static render:
//
//   1. The summary read carries no `content`. A live main file runs past the
//      runtime's 64KB cleanup threshold, so a bodyless read is the difference
//      between a settings row and a large payload on every panel open. The
//      test writes a file over that threshold and pins both reads.
//   2. An empty write deletes the file, matching `GlobalInstructions.write`.
//      Without this a user cannot clear their memory at all.
//   3. The agent name is a path segment under `agents/`, so traversal must be
//      rejected. This is the same guard the runtime applies, and a settings
//      panel takes the name from a request body — it cannot be trusted.
//   4. A failed write leaves the previous content intact rather than truncating
//      a 100KB memory file to nothing.
//
// The panel's own render is covered by `personalization-settings.test.tsx`;
// this file is the storage underneath it.

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentMemoryPath,
  assertSafeAgentName,
  isInsideDataDir,
  readAgentMemory,
  WEBUI_DEFAULT_AGENT_NAME,
  writeAgentMemory,
} from "../../src/server/agent-memory.js";
import {
  getAgentMemoryOperation,
  setAgentMemoryOperation,
} from "../../src/server/operation/operations.js";
import type { WebuiAgentMemoryView } from "../../src/client/contracts.js";
import { WebuiErrorCode } from "../../src/server/envelope.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "webui-agent-memory-"));
  tempDirs.push(dir);
  return dir;
}

describe("getAgentMemoryOperation validation", () => {
  it("defaults to a summary read with no content", () => {
    expect(getAgentMemoryOperation.validate(undefined)).toEqual({
      ok: true,
      body: { agentName: WEBUI_DEFAULT_AGENT_NAME },
    });
  });

  it("accepts includeContent only as a boolean", () => {
    expect(getAgentMemoryOperation.validate({ includeContent: true })).toEqual({
      ok: true,
      body: { includeContent: true, agentName: WEBUI_DEFAULT_AGENT_NAME },
    });
    expect(
      getAgentMemoryOperation.validate({ includeContent: "yes" }),
    ).toMatchObject({ ok: false, code: WebuiErrorCode.invalidBody });
  });

  it("rejects a non-object body", () => {
    expect(getAgentMemoryOperation.validate([])).toMatchObject({
      ok: false,
      code: WebuiErrorCode.invalidBody,
    });
  });
});

describe("setAgentMemoryOperation validation", () => {
  it("accepts an empty string because it removes the file", () => {
    expect(setAgentMemoryOperation.validate({ content: "" })).toEqual({
      ok: true,
      body: { content: "", agentName: WEBUI_DEFAULT_AGENT_NAME },
    });
  });

  it("rejects a missing or non-string content", () => {
    for (const body of [{}, { content: null }, { content: 7 }, "text"]) {
      expect(setAgentMemoryOperation.validate(body)).toMatchObject({
        ok: false,
        code: WebuiErrorCode.invalidBody,
      });
    }
  });
});

describe("assertSafeAgentName", () => {
  it("accepts an ordinary agent directory name", () => {
    expect(assertSafeAgentName(" mavis ")).toBe("mavis");
  });

  // The name becomes `agents/<name>/`, so anything that escapes that directory
  // has to be refused before it reaches a path join.
  it("rejects traversal, separators and control characters", () => {
    for (const name of ["", "   ", "../escape", "a/b", "a\\b", "..", "a\u0000b", undefined]) {
      expect(() => assertSafeAgentName(name)).toThrow();
    }
  });
});

describe("isInsideDataDir", () => {
  it("accepts a path under the data dir and refuses one outside it", () => {
    const dataDir = "/tmp/profile";
    expect(isInsideDataDir(dataDir, "/tmp/profile/agents/mavis/memory/MEMORY.md")).toBe(true);
    expect(isInsideDataDir(dataDir, "/tmp/profile-other/agents/mavis/memory/MEMORY.md")).toBe(false);
  });
});

describe("agent main memory storage", () => {
  it("reports an absent file without creating it", async () => {
    const dataDir = await tempDataDir();
    const view = await readAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME);

    expect(view).toMatchObject({
      agentName: WEBUI_DEFAULT_AGENT_NAME,
      path: agentMemoryPath(dataDir, WEBUI_DEFAULT_AGENT_NAME),
      exists: false,
      sizeBytes: 0,
    });
    expect(view.content).toBeUndefined();
  });

  it("omits the body on a summary read and includes it on demand", async () => {
    const dataDir = await tempDataDir();
    // Larger than the runtime's 64KB cleanup threshold, which is what makes
    // the summary read worth having at all.
    const body = `# 记忆\n${"x".repeat(70 * 1024)}\n`;
    await writeAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME, body);

    const summary = await readAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME);
    expect(summary.exists).toBe(true);
    expect(summary.sizeBytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(summary.updatedAt).toBeTruthy();
    expect(summary.content).toBeUndefined();

    const full = await readAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME, {
      includeContent: true,
    });
    expect(full.content).toBe(body);
  });

  it("round-trips through the same path the runtime reads", async () => {
    const dataDir = await tempDataDir();
    const content = "# 决策必查表\n\n- 记住这条\n";
    await writeAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME, content);

    expect(
      await readFile(agentMemoryPath(dataDir, WEBUI_DEFAULT_AGENT_NAME), "utf8"),
    ).toBe(content);
  });

  it("removes the file on a blank write and keeps the removal idempotent", async () => {
    const dataDir = await tempDataDir();
    await writeAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME, "# 有内容\n");

    await expect(writeAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME, "   ")).resolves.toMatchObject({
      exists: false,
      sizeBytes: 0,
    });
    await expect(
      readFile(agentMemoryPath(dataDir, WEBUI_DEFAULT_AGENT_NAME), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Blank-when-absent must not throw: the panel's save button is idempotent.
    await expect(writeAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME, "")).resolves.toMatchObject({
      exists: false,
    });
  });

  it("leaves prior content intact when the write path is not a file", async () => {
    const dataDir = await tempDataDir();
    await writeAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME, "keep me");

    // A directory where the file belongs makes the write fail; the failure must
    // surface as a stable error, not a truncated memory file.
    const filePath = agentMemoryPath(dataDir, WEBUI_DEFAULT_AGENT_NAME);
    await rm(filePath, { force: true });
    await mkdir(filePath, { recursive: true });

    await expect(
      writeAgentMemory(dataDir, WEBUI_DEFAULT_AGENT_NAME, "new content"),
    ).rejects.toMatchObject({ code: "AGENT_MEMORY_UNAVAILABLE" });
  });
});
