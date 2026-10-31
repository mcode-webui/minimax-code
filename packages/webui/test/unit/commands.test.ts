import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { runWebuiCommand } from "../../src/runtime/commands/runner.js";
import {
  createSessionOperation,
  createUserModelProviderOperation,
  getSessionOperation,
  getSessionRewindPreviewOperation,
  listSessionsOperation,
  listSkillsOperation,
  runCommandOperation,
} from "../../src/server/operation/operations.js";

describe("WebUI command adapter", () => {
  it("returns the six-command catalogue for help", async () => {
    const result = await runWebuiCommand({} as never, { command: "help" });
    expect(result.output).toContain("/compact");
    expect(result.data).toHaveLength(6);
  });

  it("uses the CliService single-object compaction shape", async () => {
    const requestCompaction = vi.fn().mockResolvedValue({ success: true });
    await runWebuiCommand({ requestCompaction } as never, { command: "compact", sessionId: "s1", agentName: "main", input: "focus" });
    expect(requestCompaction).toHaveBeenCalledWith({ name: "main", id: "s1", reason: "ui_request", customInstructions: "focus" });
  });

  it("maps nothing-to-compact to a handled response", async () => {
    const result = await runWebuiCommand({ requestCompaction: vi.fn().mockResolvedValue({ code: "NOTHING_TO_COMPACT" }) } as never, { command: "compact", sessionId: "s1" });
    expect(result).toEqual({ handled: true, output: "No compaction is needed for this conversation yet." });
  });

  it("preserves a runtime rejection code for the service envelope", async () => {
    await expect(
      runWebuiCommand(
        {
          requestCompaction: vi.fn().mockResolvedValue({
            code: "runtimeRejected",
            error: "not allowed",
          }),
        } as never,
        { command: "compact", sessionId: "s1" },
      ),
    ).rejects.toMatchObject({ code: "runtimeRejected", message: "not allowed" });
  });

  it("rejects malformed and unknown command request bodies", () => {
    // The message is pinned, not just the code: `invalid_body` is the answer to
    // every rejected body, so a code-only assertion cannot tell a changed
    // message — or a predicate that started rejecting something new — from the
    // behaviour it was written against. AGENTS.md asks for this whenever a
    // validator is touched, and `runCommand`'s was (the command list moved to
    // `shared/contracts/commands.ts`).
    assert.deepEqual(runCommandOperation.validate(null), {
      ok: false,
      code: "invalid_body",
      message: "runCommand body must be an object",
    });
    assert.deepEqual(runCommandOperation.validate({ command: "not-a-command" }), {
      ok: false,
      code: "invalid_body",
      message: "runCommand command is invalid",
    });
    // Each optional field names itself, so the caller knows which one to fix.
    for (const field of ["input", "sessionId", "agentName", "workspaceDir"]) {
      assert.deepEqual(
        runCommandOperation.validate({ command: "help", [field]: 42 }),
        {
          ok: false,
          code: "invalid_body",
          message: `${field} must be a string`,
        },
      );
    }
  });

  it("validates and preserves the optional team-mode create field", () => {
    expect(
      createSessionOperation.validate({
        name: "main",
        workspaceDir: process.cwd(),
        teamModeOff: false,
      }),
    ).toEqual({
      ok: true,
      body: { name: "main", workspaceDir: process.cwd(), teamModeOff: false },
    });
    expect(
      createSessionOperation.validate({
        name: "main",
        workspaceDir: process.cwd(),
        teamModeOff: "false",
      }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
  });

  it("accepts an empty listSkills body and a string agentName", () => {
    expect(listSkillsOperation.validate(undefined)).toEqual({ ok: true, body: {} });
    expect(
      listSkillsOperation.validate({ agentName: "main" }),
    ).toEqual({ ok: true, body: { agentName: "main" } });
  });

  it("rejects non-string agentName on listSkills", () => {
    expect(
      listSkillsOperation.validate({ agentName: 42 }),
    ).toMatchObject({ ok: false, code: "invalid_body" });
  });

  it("preserves shared record and non-empty-string validator boundaries", () => {
    assert.deepEqual(listSessionsOperation.validate({ name: "main" }), {
      ok: true,
      body: { name: "main" },
    });
    assert.deepEqual(listSessionsOperation.validate(null), {
      ok: false,
      code: "invalid_body",
      message: "listSessions body must be an object",
    });
    assert.deepEqual(listSessionsOperation.validate({ name: "  " }), {
      ok: false,
      code: "invalid_body",
      message: "listSessions body requires a non-empty name",
    });

    assert.deepEqual(getSessionOperation.validate({ id: "session-1" }), {
      ok: true,
      body: { id: "session-1" },
    });
    assert.deepEqual(getSessionOperation.validate({ id: "" }), {
      ok: false,
      code: "invalid_body",
      message: "getSession body requires a non-empty id",
    });
  });

  it("preserves shared conversation and provider validator boundaries", () => {
    assert.deepEqual(getSessionRewindPreviewOperation.validate({ id: "s", userMessageId: "m" }), {
      ok: true,
      body: { id: "s", userMessageId: "m" },
    });
    assert.deepEqual(getSessionRewindPreviewOperation.validate({ id: "s" }), {
      ok: false,
      code: "invalid_body",
      message: "getSessionRewindPreview body requires a non-empty userMessageId",
    });

    // A create needs its endpoint and its key.
    assert.deepEqual(createUserModelProviderOperation.validate({ providerId: "p" }), {
      ok: false,
      code: "invalid_body",
      message: "createUserModelProvider requires a non-empty baseUrl",
    });
    assert.deepEqual(
      createUserModelProviderOperation.validate({ baseUrl: "https://example.test", apiKey: "sk" }),
      { ok: true, body: { baseUrl: "https://example.test", apiKey: "sk" } },
    );
    assert.deepEqual(createUserModelProviderOperation.validate([]), {
      ok: false,
      code: "invalid_body",
      message: "createUserModelProvider body must be an object",
    });
  });
});
