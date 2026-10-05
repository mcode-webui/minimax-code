// Profile-owned file storage (K area) — `AGENTS.md` and the per-agent main
// memory, pinned against a real temp data dir rather than a re-implementation.
//
// What matters here and cannot be asserted from a static render:
//
//   1. The summary read carries no `content`. A live main file runs past the
//      runtime's 64KB cleanup threshold, so a bodyless read is the difference
//      between a settings row and a large payload on every panel open. The
//      test writes a file over that threshold and pins both reads.
//   2. An empty write deletes the file. Without this a user cannot clear their
//      instructions or their memory at all.
//   3. The agent name is a path segment under `agents/`, so traversal must be
//      rejected. This is the same guard the runtime applies, and a settings
//      panel takes the name from a request body — it cannot be trusted.
//   4. A failed write leaves the previous content intact rather than truncating
//      a 100KB memory file to nothing.
//
// The two size limits are copied out of the runtime as literals, which is the
// price of not importing the runtime's own classes (see the module header).
// They are pinned to exact values here so a change on the runtime side is a
// failing test on this side rather than a silent disagreement:
//
//   * `GLOBAL_INSTRUCTIONS_MAX_BYTES` — `local-runtime-v2` `.../persistence/
//     global-instructions.ts`. If the runtime's cap moves, this UI keeps
//     accepting text the runtime then drops at prompt assembly.
//   * `WEBUI_DEFAULT_AGENT_NAME` — `packages/tui/src/product-context.ts`. If
//     the default agent is renamed, the panel would edit a stale agent's
//     memory while looking correct.
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
  GLOBAL_INSTRUCTIONS_MAX_BYTES,
  globalInstructionsPath,
  isInsideDataDir,
  readAgentMemory,
  readGlobalInstructions,
  WEBUI_DEFAULT_AGENT_NAME,
  writeAgentMemory,
  writeGlobalInstructions,
} from "../../src/server/profile-files.js";
import {
  getAgentMemoryOperation,
  setAgentMemoryOperation,
} from "../../src/server/operation/operations.js";
import { WebuiErrorCode } from "../../src/server/envelope.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "webui-profile-files-"));
  tempDirs.push(dir);
  return dir;
}

describe("limits copied from the runtime", () => {
  it("pins the AGENTS.md cap and the default agent name", () => {
    expect(GLOBAL_INSTRUCTIONS_MAX_BYTES).toBe(32 * 1024);
    expect(WEBUI_DEFAULT_AGENT_NAME).toBe("mavis");
  });
});

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

describe("AGENTS.md storage", () => {
  it("reports an absent file as empty without creating it", async () => {
    const dataDir = await tempDataDir();

    await expect(readGlobalInstructions(dataDir)).resolves.toEqual({
      content: "",
      exists: false,
      path: globalInstructionsPath(dataDir),
      maxBytes: GLOBAL_INSTRUCTIONS_MAX_BYTES,
    });
    await expect(
      readFile(globalInstructionsPath(dataDir), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips content at the path Turn assembly reads", async () => {
    const dataDir = await tempDataDir();
    const content = "# Agents 全局设定\n\n| 维度 | 内容 |\n| --- | --- |\n";

    await writeGlobalInstructions(dataDir, content);
    await expect(readFile(join(dataDir, "AGENTS.md"), "utf8")).resolves.toBe(content);
    await expect(readGlobalInstructions(dataDir)).resolves.toMatchObject({
      content,
      exists: true,
    });
  });

  it("deletes the file on a blank write and keeps the removal idempotent", async () => {
    const dataDir = await tempDataDir();
    await writeGlobalInstructions(dataDir, "keep until cleared");

    await writeGlobalInstructions(dataDir, "   ");
    await expect(readGlobalInstructions(dataDir)).resolves.toMatchObject({
      content: "",
      exists: false,
    });
    await expect(
      readFile(globalInstructionsPath(dataDir), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(writeGlobalInstructions(dataDir, "")).resolves.toMatchObject({
      exists: false,
    });
  });

  it("refuses content over the cap the panel mirrors", async () => {
    const dataDir = await tempDataDir();

    await expect(
      writeGlobalInstructions(dataDir, "x".repeat(GLOBAL_INSTRUCTIONS_MAX_BYTES + 1)),
    ).rejects.toMatchObject({ code: "GLOBAL_INSTRUCTIONS_TOO_LARGE" });
  });

  it("leaves the previous content intact when an oversized write is rejected", async () => {
    const dataDir = await tempDataDir();
    await writeGlobalInstructions(dataDir, "keep me");

    await expect(
      writeGlobalInstructions(dataDir, "x".repeat(GLOBAL_INSTRUCTIONS_MAX_BYTES + 1)),
    ).rejects.toBeTruthy();
    expect(await readFile(globalInstructionsPath(dataDir), "utf8")).toBe("keep me");
  });

  it("measures the cap in bytes, not characters", async () => {
    const dataDir = await tempDataDir();
    // Half the cap in characters, but three bytes each in UTF-8.
    const chinese = "指".repeat(GLOBAL_INSTRUCTIONS_MAX_BYTES / 2);

    await expect(writeGlobalInstructions(dataDir, chinese)).rejects.toMatchObject({
      code: "GLOBAL_INSTRUCTIONS_TOO_LARGE",
    });
  });
});
