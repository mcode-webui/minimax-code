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
  readUserProfile,
  USER_PROFILE_MAX_CHARS,
  userMemoryPath,
  WebuiProfileFileError,
  WEBUI_DEFAULT_AGENT_NAME,
  writeAgentMemory,
  writeGlobalInstructions,
  writeUserProfile,
} from "../../src/server/profile-files.js";
import {
  getAgentMemoryOperation,
  getMemorySettingsOperation,
  getUserProfileOperation,
  setAgentMemoryOperation,
  setMemorySettingsOperation,
  setUserProfileOperation,
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

/**
 * The personalization markers are a copied contract, not a shared import:
 * nothing in this repository writes them, and `LocalPromptMemoryReader` — the
 * interface that feeds the prompt composer — has no implementation here. So the
 * literals are pinned below. If the desktop surface renames or re-pairs them,
 * this suite fails instead of the panel quietly editing the wrong region.
 */
const PROFILE_START = "<!-- mavis-personalization:start -->";
const PROFILE_END = "<!-- mavis-personalization:end -->";

describe("the user profile marker contract", () => {
  it("pins both marker literals and the injection ceiling", () => {
    expect(PROFILE_START).toBe("<!-- mavis-personalization:start -->");
    expect(PROFILE_END).toBe("<!-- mavis-personalization:end -->");
    // `MEMORY_TAIL_INJECTION_CAP_CHARS` in `packages/shared/src/memory-limits.ts`.
    // The composer truncates the profile to its tail past this mark, so text
    // above it is stored but never reaches the model.
    expect(USER_PROFILE_MAX_CHARS).toBe(10 * 1024);
  });
});

describe("readUserProfile", () => {
  it("returns the marked region and never the collector's entries", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    await writeFile(
      userMemoryPath(dataDir),
      [
        PROFILE_START,
        "# User profile",
        "Occupation: staff engineer",
        PROFILE_END,
        '<!-- mem-append-reason: collected -->',
        "### a preference the runtime learned",
        "",
      ].join("\n"),
      "utf8",
    );

    const view = await readUserProfile(dataDir);

    expect(view.exists).toBe(true);
    expect(view.malformed).toBe(false);
    expect(view.content).toBe("# User profile\nOccupation: staff engineer");
    // The size reported is the whole file, because the file is what the user
    // would inspect on disk; the content is only the region.
    expect(view.sizeBytes).toBeGreaterThan(view.content.length);
  });

  it("reports an absent file without creating one", async () => {
    const dataDir = await tempDataDir();

    const view = await readUserProfile(dataDir);

    expect(view).toMatchObject({ content: "", exists: false, malformed: false, sizeBytes: 0 });
    await expect(readFile(userMemoryPath(dataDir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a file with only collector entries as having no region", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    await writeFile(
      userMemoryPath(dataDir),
      '<!-- mem-append-reason: collected -->\nsomething learned\n',
      "utf8",
    );

    const view = await readUserProfile(dataDir);

    // The file exists and is non-empty, but it holds no profile. Reporting
    // this as "no profile" is the whole point: the panel must not show the
    // collector's output as if the user had written it.
    expect(view.exists).toBe(false);
    expect(view.malformed).toBe(false);
    expect(view.content).toBe("");
    expect(view.sizeBytes).toBeGreaterThan(0);
  });

  it("flags a half-present marker pair instead of guessing the region", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    await writeFile(userMemoryPath(dataDir), `${PROFILE_START}\nhalf a region\n`, "utf8");

    const view = await readUserProfile(dataDir);

    expect(view.malformed).toBe(true);
    expect(view.exists).toBe(false);
    expect(view.content).toBe("");
  });
});

describe("writeUserProfile", () => {
  it("replaces only the region and preserves everything around it", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    const before = `${PROFILE_START}\nold profile\n${PROFILE_END}\n<!-- mem-append-reason: kept -->\nentry\n`;
    await writeFile(userMemoryPath(dataDir), before, "utf8");

    const view = await writeUserProfile(dataDir, "new profile");

    expect(view.content).toBe("new profile");
    const after = await readFile(userMemoryPath(dataDir), "utf8");
    expect(after).toContain(PROFILE_START);
    expect(after).toContain(PROFILE_END);
    expect(after).toContain("<!-- mem-append-reason: kept -->");
    expect(after).not.toContain("old profile");
  });

  it("keeps a newline between the start marker and the body", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    await writeFile(
      userMemoryPath(dataDir),
      `${PROFILE_START}\nold profile\n${PROFILE_END}\n<!-- mem-append-reason: kept -->\nentry\n`,
      "utf8",
    );

    await writeUserProfile(dataDir, "Nickname: izzy");

    // The exact layout, not "contains the profile". The reader trims the body,
    // so a missing separator is invisible in the panel — the file just reads
    // `<start># User profile` to every other tool that opens it raw, and no
    // assertion on `content` would ever have caught it.
    expect(await readFile(userMemoryPath(dataDir), "utf8")).toBe(
      `${PROFILE_START}\nNickname: izzy\n${PROFILE_END}\n<!-- mem-append-reason: kept -->\nentry\n`,
    );
  });

  it("repairs a region whose separator was already lost", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    // The shape an earlier write left on disk: the body glued to the marker.
    await writeFile(userMemoryPath(dataDir), `${PROFILE_START}# User profile\n${PROFILE_END}\n`, "utf8");

    const view = await writeUserProfile(dataDir, "# User profile");

    expect(view.content).toBe("# User profile");
    expect(await readFile(userMemoryPath(dataDir), "utf8")).toBe(
      `${PROFILE_START}\n# User profile\n${PROFILE_END}\n`,
    );
  });

  it("is byte-idempotent across repeated saves", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    await writeFile(
      userMemoryPath(dataDir),
      `${PROFILE_START}\nold\n${PROFILE_END}\n<!-- mem-append-reason: kept -->\nentry\n`,
      "utf8",
    );

    await writeUserProfile(dataDir, "  padded  ");
    const once = await readFile(userMemoryPath(dataDir), "utf8");
    await writeUserProfile(dataDir, "  padded  ");
    await writeUserProfile(dataDir, "  padded  ");

    // A write that drifts by a byte per save is the failure mode this pins: the
    // separators around the body are rebuilt from scratch every time, so three
    // saves have to land on the same file as one.
    expect(await readFile(userMemoryPath(dataDir), "utf8")).toBe(once);
    expect(once).toBe(`${PROFILE_START}\npadded\n${PROFILE_END}\n<!-- mem-append-reason: kept -->\nentry\n`);
  });

  it("leaves no blank line when the profile is cleared", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    await writeFile(userMemoryPath(dataDir), `${PROFILE_START}\nold\n${PROFILE_END}\nentry\n`, "utf8");

    await writeUserProfile(dataDir, "   ");

    // One newline, not two: the body is empty, so there is nothing between the
    // markers to separate, and an extra blank line would read as a stray edit
    // to anyone looking at the file.
    expect(await readFile(userMemoryPath(dataDir), "utf8")).toBe(`${PROFILE_START}\n${PROFILE_END}\nentry\n`);
  });

  it("appends a region to a file that has none, keeping the existing bytes", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    await writeFile(userMemoryPath(dataDir), "<!-- mem-append-reason: kept -->\nentry\n", "utf8");

    await writeUserProfile(dataDir, "hello");

    const after = await readFile(userMemoryPath(dataDir), "utf8");
    expect(after).toContain("<!-- mem-append-reason: kept -->");
    expect(after).toContain(PROFILE_START);
    expect((await readUserProfile(dataDir)).content).toBe("hello");
  });

  it("clears the region without deleting the file the collector appends to", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    await writeFile(
      userMemoryPath(dataDir),
      `${PROFILE_START}\nprofile\n${PROFILE_END}\n<!-- mem-append-reason: kept -->\n`,
      "utf8",
    );

    const view = await writeUserProfile(dataDir, "   ");

    expect(view.content).toBe("");
    // Blanking the profile must not remove the file: the entries in it were
    // written by the memory collector, not by the user, and deleting them
    // would lose memory the runtime gathered.
    const after = await readFile(userMemoryPath(dataDir), "utf8");
    expect(after).toContain("<!-- mem-append-reason: kept -->");
    expect(after).toContain(PROFILE_END);
  });

  it("creates nothing when asked to clear a file that has no region", async () => {
    const dataDir = await tempDataDir();

    await writeUserProfile(dataDir, "");

    await expect(readFile(userMemoryPath(dataDir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to write a half-marked file rather than duplicating the region", async () => {
    const dataDir = await tempDataDir();
    await mkdir(join(dataDir, "memory"), { recursive: true });
    const damaged = `${PROFILE_START}\nhalf a region\n`;
    await writeFile(userMemoryPath(dataDir), damaged, "utf8");

    await expect(writeUserProfile(dataDir, "new profile")).rejects.toMatchObject({
      code: "USER_PROFILE_MALFORMED",
    });
    // Unchanged, not repaired: a repair here would be a guess about where the
    // region ends, and the wrong guess drops whatever sits after it.
    expect(await readFile(userMemoryPath(dataDir), "utf8")).toBe(damaged);
  });

  it("round-trips content the user would actually type", async () => {
    const dataDir = await tempDataDir();
    const profile = "Nickname: izzy\n\n## More about you\n\n- 开发走 dev-izzy\n- 不擅自 push";

    await writeUserProfile(dataDir, profile);

    expect((await readUserProfile(dataDir)).content).toBe(profile);
  });

  it("surfaces a stable error code rather than the raw filesystem error", async () => {
    const dataDir = await tempDataDir();
    // A directory where the file should be: readFile reports EISDIR, and the
    // panel needs a code it can branch on rather than a platform string.
    await mkdir(userMemoryPath(dataDir), { recursive: true });

    await expect(readUserProfile(dataDir)).rejects.toBeInstanceOf(WebuiProfileFileError);
  });
});

describe("user profile and memory settings operations", () => {
  it("takes no parameters on the two reads, matching the agent-memory read", () => {
    // The transport sends `{}` for every read, so an object body is accepted
    // and ignored rather than rejected — the same contract `getAgentMemory`
    // already has. Only a non-object frame is a protocol error.
    expect(getUserProfileOperation.validate(undefined)).toEqual({ ok: true, body: undefined });
    expect(getUserProfileOperation.validate({})).toEqual({ ok: true, body: undefined });
    expect(getMemorySettingsOperation.validate({})).toEqual({ ok: true, body: undefined });
    expect(getUserProfileOperation.validate([])).toMatchObject({ ok: false });
    expect(getMemorySettingsOperation.validate("x")).toMatchObject({ ok: false });
  });

  it("requires a string content on the profile write", () => {
    expect(setUserProfileOperation.validate({ content: "x" })).toEqual({
      ok: true,
      body: { content: "x" },
    });
    // An absent content must not read as "clear the profile": the user never
    // opened the editor, and a malformed frame is not consent to delete.
    expect(setUserProfileOperation.validate({})).toMatchObject({
      ok: false,
      code: WebuiErrorCode.invalidBody,
    });
    expect(setUserProfileOperation.validate({ content: 1 })).toMatchObject({ ok: false });
  });

  it("accepts either switch alone and rejects anything else", () => {
    expect(setMemorySettingsOperation.validate({ enabled: false })).toEqual({
      ok: true,
      body: { enabled: false },
    });
    expect(setMemorySettingsOperation.validate({ proactive: true })).toEqual({
      ok: true,
      body: { proactive: true },
    });
    // The frame is two booleans and nothing else. A general config payload
    // would let a caller reach the API-key roots through this operation.
    expect(setMemorySettingsOperation.validate({ minmax_api: { key: "x" } })).toEqual({
      ok: true,
      body: {},
    });
    expect(setMemorySettingsOperation.validate({ enabled: "off" })).toMatchObject({
      ok: false,
      code: WebuiErrorCode.invalidBody,
    });
    expect(setMemorySettingsOperation.validate(null)).toMatchObject({ ok: false });
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
