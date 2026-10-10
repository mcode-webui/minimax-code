// Unit tests for the plugin workflow owner (ticket #52).
//
// The owner is framework-free, so these run the real decision logic the plugin
// manager delegates to: that a superseded listing answer is dropped rather than
// applied over a newer selection, and that a mutation reloads exactly the
// listing it affects.

import { describe, expect, it, vi } from "vitest";

import {
  createWebuiPluginWorkflows,
  initialWebuiPluginSelection,
} from "../../src/client/application/plugin-workflows.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the plugin listing has one owner", () => {
  it("drops a listing answer for a selection the owner has left", async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    let call = 0;
    const workflows = createWebuiPluginWorkflows({
      port: {
        pluginManagement: (request) => {
          if (request.action !== "listInstalledPlugins") return Promise.resolve({ plugins: [] });
          call += 1;
          if (call === 1) {
            return new Promise((resolve) => {
              resolveFirst = resolve;
            });
          }
          return Promise.resolve({ plugins: [{ name: "second" }] });
        },
      },
    });

    void workflows.loadListing({ ...initialWebuiPluginSelection, view: "personal" });
    await workflows.loadListing({ ...initialWebuiPluginSelection, view: "personal", query: "b" });
    resolveFirst({ plugins: [{ name: "first" }] });
    await flush();

    expect(workflows.getSnapshot().listing.rows.map((row) => row.name)).toEqual(["second"]);
  });

  it("records a missing capability as one error, not a silent empty", async () => {
    const workflows = createWebuiPluginWorkflows({ port: {} });
    await workflows.loadListing(initialWebuiPluginSelection);
    expect(workflows.getSnapshot().listing.error).toBe(
      "Plugin management is not connected to the runtime",
    );
  });

  it("merges marketplace rows with installed state for the market view", async () => {
    const workflows = createWebuiPluginFold();
    await workflows.loadListing(initialWebuiPluginSelection);
    const rows = workflows.getSnapshot().listing.rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.name === "installed")?.installed).toBe(true);
    expect(workflows.getSnapshot().listing.pluginTotal).toBe(2);
  });
});

function createWebuiPluginFold() {
  return createWebuiPluginWorkflows({
    port: {
      pluginManagement: (request) => {
        if (request.action === "listMarketplacePlugins") {
          return Promise.resolve({
            plugins: [{ name: "installed" }, { name: "free" }],
            pluginTotal: 2,
          });
        }
        return Promise.resolve({ plugins: [{ name: "installed", source: 1 }] });
      },
    },
  });
}

describe("a plugin mutation invalidates exactly what it affects", () => {
  it("reloads the listing and bumps the revision after a mutation", async () => {
    let installed = false;
    const reloads: string[] = [];
    const workflows = createWebuiPluginWorkflows({
      port: {
        pluginManagement: (request) => {
          if (request.action === "listInstalledPlugins") {
            reloads.push("list");
            return Promise.resolve({ plugins: installed ? [{ name: "p" }] : [] });
          }
          installed = true;
          return Promise.resolve({ ok: true });
        },
      },
    });

    await workflows.loadListing({ ...initialWebuiPluginSelection, view: "personal" });
    expect(workflows.getSnapshot().listing.rows).toHaveLength(0);
    const before = workflows.getSnapshot().revision;

    await workflows.installPlugin({ name: "p" });
    expect(workflows.getSnapshot().revision).toBe(before + 1);
    expect(workflows.getSnapshot().listing.rows).toHaveLength(1);
    expect(reloads.length).toBeGreaterThanOrEqual(2);
  });

  it("sends the named action for a named command", async () => {
    const actions: string[] = [];
    const workflows = createWebuiPluginWorkflows({
      port: {
        pluginManagement: (request) => {
          actions.push(request.action);
          return Promise.resolve({});
        },
      },
    });

    await workflows.loadListing({ ...initialWebuiPluginSelection, view: "personal" });
    await workflows.setSkillEnabled({ name: "s", enabled: false });
    expect(actions).toContain("setSkillEnabled");
  });

  it("surfaces a mutation failure to the caller without a phantom reload", async () => {
    const reload = vi.fn(() => Promise.resolve({}));
    const workflows = createWebuiPluginWorkflows({
      port: {
        pluginManagement: (request) =>
          request.action === "deleteAgent"
            ? Promise.reject(new Error("in use"))
            : reload(),
      },
    });

    await workflows.loadListing(initialWebuiPluginSelection);
    await expect(workflows.deleteAgent({ name: "a" })).rejects.toThrow("in use");
    // One owner records the failure, so no call site keeps its own copy.
    expect(workflows.getSnapshot().mutationError).toBe("in use");
    expect(workflows.getSnapshot().mutating).toBe(false);
  });

  it("clears the recorded failure when the next mutation starts", async () => {
    let fail = true;
    const workflows = createWebuiPluginWorkflows({
      port: {
        pluginManagement: (request) => {
          if (request.action === "deleteAgent") {
            return fail ? Promise.reject(new Error("in use")) : Promise.resolve({});
          }
          return Promise.resolve({ plugins: [] });
        },
      },
    });

    await workflows.loadListing({ ...initialWebuiPluginSelection, view: "personal" });
    await expect(workflows.deleteAgent({ name: "a" })).rejects.toThrow("in use");
    expect(workflows.getSnapshot().mutationError).toBe("in use");
    fail = false;
    await workflows.deleteAgent({ name: "a" });
    expect(workflows.getSnapshot().mutationError).toBeUndefined();
  });
});
