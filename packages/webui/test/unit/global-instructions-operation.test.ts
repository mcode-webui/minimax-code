import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GLOBAL_INSTRUCTIONS_MAX_BYTES,
  GlobalInstructions,
} from "@mavis/local-runtime-v2/turn-system";

import { WebuiErrorCode } from "../../src/server/envelope.js";
import {
  getGlobalInstructionsOperation,
  setGlobalInstructionsOperation,
} from "../../src/server/operation/operations.js";

function expectInvalid(operation: typeof setGlobalInstructionsOperation, body: unknown): void {
  expect(operation.validate(body)).toMatchObject({
    ok: false,
    code: WebuiErrorCode.invalidBody,
  });
}

describe("getGlobalInstructionsOperation validation", () => {
  it("accepts an absent or empty-object body", () => {
    expect(getGlobalInstructionsOperation.validate(undefined)).toEqual({ ok: true, body: {} });
    expect(getGlobalInstructionsOperation.validate({})).toEqual({ ok: true, body: {} });
  });

  it("rejects a non-object body", () => {
    expectInvalid(getGlobalInstructionsOperation, []);
    expectInvalid(getGlobalInstructionsOperation, "nope");
  });
});

describe("setGlobalInstructionsOperation validation", () => {
  it("passes the content through untouched", () => {
    const content = "# Agents 全局设定\n\n| 维度 | 内容 |\n| --- | --- |\n";
    expect(setGlobalInstructionsOperation.validate({ content })).toEqual({ ok: true, body: { content } });
  });

  // Empty content deletes the file (see `GlobalInstructions.write`), so it is a
  // legal body — but a missing or non-string content would delete it too, and
  // that must not be reachable from a malformed frame.
  it("accepts an empty string because it means delete the file", () => {
    expect(setGlobalInstructionsOperation.validate({ content: "" })).toEqual({ ok: true, body: { content: "" } });
  });

  it("rejects a missing, non-string, or non-object content", () => {
    expectInvalid(setGlobalInstructionsOperation, {});
    expectInvalid(setGlobalInstructionsOperation, { content: null });
    expectInvalid(setGlobalInstructionsOperation, { content: 42 });
    expectInvalid(setGlobalInstructionsOperation, []);
    expectInvalid(setGlobalInstructionsOperation, "content");
  });
});

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "webui-global-instructions-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Exercises the same `GlobalInstructions` the harness port binds, so the cap
 * and the delete-on-empty contract are asserted against the runtime's real
 * implementation rather than a re-implementation in the test.
 */
describe("global instructions file contract", () => {
  it("reports an absent file as empty without creating it", async () => {
    const dataDir = await tempDataDir();
    const instructions = new GlobalInstructions(dataDir);

    const state = await instructions.read();
    expect(state).toEqual({ content: "", exists: false, maxBytes: GLOBAL_INSTRUCTIONS_MAX_BYTES });
    await expect(readFile(join(dataDir, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips content and deletes the file on empty", async () => {
    const dataDir = await tempDataDir();
    const instructions = new GlobalInstructions(dataDir);

    await instructions.write("# 全局设定\n\n- 中文内容\n");
    expect(await readFile(join(dataDir, "AGENTS.md"), "utf8")).toBe("# 全局设定\n\n- 中文内容\n");
    await expect(instructions.read()).resolves.toMatchObject({ exists: true });

    await instructions.write("   ");
    expect(await instructions.read()).toMatchObject({ content: "", exists: false });
    await expect(readFile(join(dataDir, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses content over the cap that the UI mirrors", async () => {
    const dataDir = await tempDataDir();
    const instructions = new GlobalInstructions(dataDir);

    await expect(instructions.write("x".repeat(GLOBAL_INSTRUCTIONS_MAX_BYTES + 1))).rejects.toMatchObject({
      code: "GLOBAL_INSTRUCTIONS_TOO_LARGE",
    });
  });

  it("leaves the previous content intact when an oversized write is rejected", async () => {
    const dataDir = await tempDataDir();
    const instructions = new GlobalInstructions(dataDir);
    await instructions.write("keep me");

    await expect(instructions.write("x".repeat(GLOBAL_INSTRUCTIONS_MAX_BYTES + 1))).rejects.toBeTruthy();
    expect(await readFile(join(dataDir, "AGENTS.md"), "utf8")).toBe("keep me");
  });
});
