// Body validation for the two `AGENTS.md` operations.
//
// Only the wire contract lives here. The storage contract — the 32KiB cap, the
// delete-on-empty write, the atomic replace — is in `profile-files.test.ts`,
// next to the implementation that owns it.

import { describe, expect, it } from "vitest";

import { WebuiErrorCode } from "../../src/shared/envelope.js";
import {
  getGlobalInstructionsOperation,
  setGlobalInstructionsOperation,
  type WebuiOperation,
} from "../../src/server/operation/operations.js";

// Shared by the read and the write operation, so pin only the contract the
// helper actually uses. Their body types differ, and a generic `Body` is what
// lets both through: `Record<string, never>` carries an index signature but no
// declared `content`, so it is not assignable to the write body type.
function expectInvalid<Body>(operation: WebuiOperation<Body>, body: unknown): void {
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

  // Empty content deletes the file (see `writeGlobalInstructions`), so it is a
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
