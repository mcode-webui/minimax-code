import { describe, expect, it } from "vitest";

import { WebuiErrorCode } from "../../src/shared/envelope.js";
import { forkSessionOperation } from "../../src/server/operation/operations.js";

const validBody = {
  id: "session-1",
  clientRequestId: "request-1",
  useSuggestedTitle: true,
  createIsolatedWorktree: false,
};

function expectInvalid(body: unknown): void {
  const result = forkSessionOperation.validate(body);
  expect(result).toMatchObject({
    ok: false,
    code: WebuiErrorCode.invalidBody,
  });
}

describe("forkSessionOperation validation", () => {
  it("preserves a trimmed assistantMessageId for a message-level fork", () => {
    const result = forkSessionOperation.validate({
      ...validBody,
      id: " session-1 ",
      assistantMessageId: " assistant-7 ",
    });

    expect(result).toEqual({
      ok: true,
      body: {
        ...validBody,
        id: "session-1",
        assistantMessageId: "assistant-7",
      },
    });
  });

  it("keeps assistantMessageId absent for a session-level fork", () => {
    const result = forkSessionOperation.validate(validBody);

    expect(result).toEqual({ ok: true, body: validBody });
    if (result.ok) expect(result.body).not.toHaveProperty("assistantMessageId");
  });

  it("rejects a blank assistantMessageId", () => {
    expectInvalid({ ...validBody, assistantMessageId: "   " });
  });

  it("rejects an assistantMessageId with the wrong type", () => {
    expectInvalid({ ...validBody, assistantMessageId: 123 });
  });

  it("retains the required-field validation for the fork envelope", () => {
    const invalidBodies = [
      { ...validBody, id: undefined },
      { ...validBody, clientRequestId: undefined },
      { ...validBody, useSuggestedTitle: undefined },
      { ...validBody, useSuggestedTitle: "yes" },
      { ...validBody, createIsolatedWorktree: undefined },
      { ...validBody, createIsolatedWorktree: "no" },
    ];

    for (const body of invalidBodies) expectInvalid(body);
  });
});
