import { describe, expect, it } from "vitest";
import { projectSessionStream } from "../../src/server/projections/index.js";
import {
  initialWebuiStreamState,
  reduceWebuiStreamFrame,
} from "../../src/client/projection/stream-state.js";

describe("WebUI projected transport frames", () => {
  it("writes a projection on session frames and consumes it in the reducer", async () => {
    const source = projectSessionStream([
      {
        eventJson: JSON.stringify({
          type: "permission.ask",
          timestamp: 1,
          source: "fixture",
          payload: { sessionId: "s1", requestId: "p1" },
        }),
      },
      { dataJson: "[DONE]" },
    ]);
    const frames = [];
    for await (const frame of source) frames.push(frame);
    expect(frames[0]?.projection).toMatchObject({
      sessions: { s1: { permissions: [{ requestId: "p1" }] } },
    });
    const state = reduceWebuiStreamFrame(initialWebuiStreamState, frames[0]!);
    expect(state.projection).toEqual(frames[0]!.projection);
  });

  it("keeps the projection snapshot on the terminal frame", async () => {
    const frames = [];
    for await (const frame of projectSessionStream([
      { dataJson: "[DONE]" },
    ])) frames.push(frame);
    expect(frames[0]?.projection).toEqual({
      sessions: {},
      compactionBySession: {},
    });
  });
});
