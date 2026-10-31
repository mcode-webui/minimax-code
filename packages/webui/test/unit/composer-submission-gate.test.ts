// The composer's submission gate. The rule lived inline in the component, where
// the property that matters — that the button and Enter accept exactly the same
// submissions — could only be checked by rendering the whole composer. Here it
// is a read with a matrix.

import { describe, expect, it } from "vitest";

import { readWebuiComposerSubmitGate } from "../../src/client/features/composer/projection/submission-gate.js";

const DESTINATION = { canCompose: true, canQueue: false };
const base = {
  draft: "hello",
  attachmentCount: 0,
  commandRunning: false,
  goalSubmitting: false,
} as const;

describe("the composer's submission gate", () => {
  it("accepts a draft when the substrate can send", () => {
    const gate = readWebuiComposerSubmitGate({ ...base, ...DESTINATION });
    expect(gate.sendable).toBe(true);
    expect(gate.submitBlocked).toBe(false);
  });

  it("accepts a queue-only destination: the queue is a destination too", () => {
    const gate = readWebuiComposerSubmitGate({ ...base, canCompose: false, canQueue: true });
    expect(gate.sendable).toBe(true);
    expect(gate.submitBlocked).toBe(false);
  });

  it("refuses when no destination is published, even with a draft", () => {
    const gate = readWebuiComposerSubmitGate({ ...base, canCompose: false, canQueue: false });
    expect(gate.sendable).toBe(false);
    expect(gate.submitBlocked).toBe(true);
  });

  it("refuses an empty submission: no draft and nothing staged", () => {
    const gate = readWebuiComposerSubmitGate({ ...base, ...DESTINATION, draft: "" });
    expect(gate.sendable).toBe(false);
    expect(gate.submitBlocked).toBe(true);
  });

  it("accepts an attachment-only submission", () => {
    const gate = readWebuiComposerSubmitGate({ ...base, ...DESTINATION, draft: "", attachmentCount: 2 });
    expect(gate.sendable).toBe(true);
    expect(gate.submitBlocked).toBe(false);
  });

  it("counts any non-empty draft; the component hands it an already-trimmed one", () => {
    // `draft` here is the composer's derived `messageDraft` (trimmed text plus
    // non-empty url references), so a whitespace-only editor draft arrives as
    // "". The read only answers "is there text", never "is it worth sending".
    const gate = readWebuiComposerSubmitGate({ ...base, ...DESTINATION, draft: "   " });
    expect(gate.submitBlocked).toBe(false);
    expect(
      readWebuiComposerSubmitGate({ ...base, ...DESTINATION, draft: "" }).submitBlocked,
    ).toBe(true);
  });

  it("blocks a second submission while a command runs", () => {
    const gate = readWebuiComposerSubmitGate({ ...base, ...DESTINATION, commandRunning: true });
    expect(gate.sendable).toBe(true);
    expect(gate.submitBlocked).toBe(true);
  });

  it("blocks a second submission while a goal submit is in flight", () => {
    const gate = readWebuiComposerSubmitGate({ ...base, ...DESTINATION, goalSubmitting: true });
    expect(gate.sendable).toBe(true);
    expect(gate.submitBlocked).toBe(true);
  });

  it("keeps the draft out of the gate: refusing never consumes the input", () => {
    // The gate is a pure read of "may a submit start"; it has no way to clear
    // the draft, which is what makes refusal and queue failure safe to show.
    const refused = readWebuiComposerSubmitGate({ ...base, canCompose: false, canQueue: false });
    expect(refused.submitBlocked).toBe(true);
    const stillThere = readWebuiComposerSubmitGate({ ...base, ...DESTINATION });
    expect(stillThere.submitBlocked).toBe(false);
  });
});
