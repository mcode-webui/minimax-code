// The frame stream's request shape.
//
// The image stream is keyed by the **target** rather than by the run, so two
// tabs get their own pictures and the person and the Agent can work on
// different pages at the same time. That is a change to an existing
// operation's request shape, not a second operation beside it.
//
// A client that still sends the old shape is refused with an explicit error
// rather than being answered with the run's selection: a stream that
// silently answers with the wrong page is worse than one that says the
// request is out of date.

import { describe, expect, it } from "vitest";

import { watchBrowserFramesOperation } from "../../src/server/operation/browser.js";

const TARGET = {
  surface: "isolated-chromium",
  browserId: "browser-1",
  targetId: "tab-1",
  generation: 1,
};

describe("the frame stream's request", () => {
  it("accepts a request that names a target", () => {
    const result = watchBrowserFramesOperation.validate({
      surface: "isolated-chromium",
      target: TARGET,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a request that still carries a run id", () => {
    const result = watchBrowserFramesOperation.validate({
      surface: "isolated-chromium",
      runId: "run-1",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("keyed by a target");
  });

  it("refuses a request with no target at all", () => {
    const result = watchBrowserFramesOperation.validate({
      surface: "isolated-chromium",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("requires a target");
  });

  it("refuses a request whose target is incomplete", () => {
    const result = watchBrowserFramesOperation.validate({
      surface: "isolated-chromium",
      target: { surface: "isolated-chromium", targetId: "tab-1" },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("complete target identity");
  });

  it("refuses a request for a surface it does not know", () => {
    const result = watchBrowserFramesOperation.validate({
      surface: "netscape",
      target: TARGET,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("known browser surface");
  });
});
