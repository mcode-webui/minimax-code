// The catalogue as a session's OWN answer.
//
// Two facts the picker needs and the catalogue did not have:
//
//   * a session's catalogue must not be another session's — the composer used to
//     read the catalogue that happened to be SHOWN and gate it on a scope it
//     kept of its own, and when those two disagreed the list came out empty:
//     the chip fell back to the literal "Model" and the trigger went inert
//     until a reload;
//   * a catalogue must not empty itself while it reloads — a read replaces its
//     entry with a loading state, and a list that blanks for the length of a
//     round trip is a list the user cannot click.
import { describe, expect, it, vi } from "vitest";

import { createWebuiModelsWorkflows } from "../../src/client/features/models/application/models-workflows.js";

const noStatusRefresh = async (): Promise<void> => {};

/** A port whose second read waits for the test to let it through. */
function gatedPort() {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let call = 0;
  const listModels = vi.fn(async (args?: { sessionId?: string }) => {
    call += 1;
    if (call === 1) {
      return [{ providerId: "p", modelId: "m", sessionId: args?.sessionId }];
    }
    await gate;
    return [{ providerId: "p", modelId: "m2", sessionId: args?.sessionId }];
  });
  return {
    listModels,
    release: () => release?.(),
  };
}

describe("models catalogue — a session's own answer", () => {
  it("reads the catalogue of the session asked for, not the one on show", async () => {
    const listModels = vi.fn(async (args?: { sessionId?: string }) => [
      { providerId: "p", modelId: `m-${args?.sessionId ?? "home"}` },
    ]);
    const w = createWebuiModelsWorkflows({
      port: { listModels },
      refreshApiKeyStatus: noStatusRefresh,
    });

    await w.loadModels("A");
    await w.acquireModels("B");
    // The selection moved to B…
    w.selectCatalogue("B");
    // …and B's answer is B's, while A's is still A's.
    expect(w.readModelsFor("B").value?.[0]?.modelId).toBe("m-B");
    expect(w.readModelsFor("A").value?.[0]?.modelId).toBe("m-A");

    w.dispose();
  });

  it("has no answer for a session nobody read yet", async () => {
    const listModels = vi.fn(async () => [{ providerId: "p", modelId: "m" }]);
    const w = createWebuiModelsWorkflows({
      port: { listModels },
      refreshApiKeyStatus: noStatusRefresh,
    });

    await w.loadModels("A");
    const unknown = w.readModelsFor("B");
    expect(unknown.status).toBe("idle");
    expect(unknown.value).toBeUndefined();

    w.dispose();
  });
});

describe("models catalogue — the last good answer stands in", () => {
  it("keeps the models on screen while the next read is in flight", async () => {
    const port = gatedPort();
    const w = createWebuiModelsWorkflows({
      port: { listModels: port.listModels },
      refreshApiKeyStatus: noStatusRefresh,
    });

    await w.loadModels("A");
    expect(w.readModelsFor("A").value?.[0]?.modelId).toBe("m");

    const pending = w.loadModels("A");
    // The read is running: the state says so…
    expect(w.readModelsFor("A").status).toBe("loading");
    // …and the value it carries is the last answer, not nothing. A list that
    // empties itself mid-reload is a list the user cannot click.
    expect(w.readModelsFor("A").value?.[0]?.modelId).toBe("m");

    port.release();
    await pending;
    expect(w.readModelsFor("A").value?.[0]?.modelId).toBe("m2");

    w.dispose();
  });

  it("keeps the shown catalogue's value too, not only the per-session one", async () => {
    const port = gatedPort();
    const w = createWebuiModelsWorkflows({
      port: { listModels: port.listModels },
      refreshApiKeyStatus: noStatusRefresh,
    });

    await w.loadModels("A");
    const pending = w.loadModels("A");

    expect(w.getSnapshot().models.status).toBe("loading");
    expect(w.getSnapshot().models.value?.[0]?.modelId).toBe("m");

    port.release();
    await pending;
    expect(w.getSnapshot().models.value?.[0]?.modelId).toBe("m2");

    w.dispose();
  });

  it("does not carry an answer across a session", async () => {
    // The retained answer belongs to the key it was read for. A session's
    // models are never another session's.
    const listModels = vi.fn(async (args?: { sessionId?: string }) => [
      { providerId: "p", modelId: `m-${args?.sessionId ?? "home"}` },
    ]);
    const w = createWebuiModelsWorkflows({
      port: { listModels },
      refreshApiKeyStatus: noStatusRefresh,
    });

    await w.loadModels("A");
    expect(w.readModelsFor("B").value).toBeUndefined();

    w.dispose();
  });

  it("drops a released session's answer with the session", async () => {
    const listModels = vi.fn(async () => [{ providerId: "p", modelId: "m" }]);
    const w = createWebuiModelsWorkflows({
      port: { listModels },
      refreshApiKeyStatus: noStatusRefresh,
    });

    await w.loadModels("A");
    expect(w.readModelsFor("A").value).toHaveLength(1);

    w.releaseSession("A");
    expect(w.readModelsFor("A").value).toBeUndefined();

    w.dispose();
  });
});
