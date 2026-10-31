/**
 * The provider read and the header rows.
 *
 * The runtime's capability declares this read as untyped rows, so
 * `server/projections/model-provider.ts` is the seam that makes the wire
 * contract's `WebuiModelProviderView` true. These cases use rows shaped like the
 * ones `toProviderRecord` produces.
 */
import { describe, expect, it } from "vitest";

import {
  toWebuiModelProviderModelEntry,
  toWebuiModelProviderView,
} from "../../src/server/projections/model-provider.js";
import { projectProviderHeaders } from "../../src/client/features/models/projection/usage-settings.js";

/** A row shaped like `toProviderRecord`'s output. */
const runtimeRow = (overrides: Record<string, unknown> = {}) => ({
  providerId: "p1",
  name: "mine",
  source: "custom",
  kind: "custom",
  enabled: true,
  baseUrl: "https://example.test/v1",
  apiFormat: "openai-completions",
  hasApiKey: true,
  maskedApiKey: "sk-****abcd",
  headerNames: ["X-A", "X-B"],
  configRevision: "rev-9",
  models: [
    {
      providerId: "p1",
      modelId: "m1",
      modelConfigId: "m1",
      displayName: "Model One",
      enabled: true,
      selected: true,
      thinking: { effort: "high" },
      status: { state: "ready", lastTestedAt: 7 },
    },
  ],
  ...overrides,
});

describe("the provider read", () => {
  it("carries configRevision and names-only headerNames", () => {
    const view = toWebuiModelProviderView(runtimeRow());
    // The two fields the editor and the candidate write depend on, under their
    // real names: the browser used to read `revision` and `headers`.
    expect(view.configRevision).toBe("rev-9");
    expect(view.headerNames).toEqual(["X-A", "X-B"]);
  });

  it("exposes no raw credential value", () => {
    const view = toWebuiModelProviderView(runtimeRow());
    expect(view.maskedApiKey).toBe("sk-****abcd");
    expect(view.hasApiKey).toBe(true);
    // The read has no place for saved header *values*; the runtime never sends
    // them and the projection does not invent a field for them.
    expect(Object.keys(view)).not.toContain("headers");
  });

  it("does not forward a field the read contract does not declare", () => {
    const view = toWebuiModelProviderView(
      runtimeRow({ futureField: { nested: [1] } }) as Record<string, unknown>,
    );
    expect(Object.keys(view)).not.toContain("futureField");
  });

  it("omits configRevision when the runtime did not send one", () => {
    // Absent, not empty: the discovery control is hidden rather than sending a
    // blank expected revision.
    const view = toWebuiModelProviderView(
      runtimeRow({ configRevision: undefined }) as Record<string, unknown>,
    );
    expect(view.configRevision).toBeUndefined();
  });

  it("keeps a model row whose identity field is missing rather than dropping it", () => {
    const entry = toWebuiModelProviderModelEntry({ displayName: "orphan" });
    expect(entry.modelId).toBe("");
    expect(entry.displayName).toBe("orphan");
  });

  it("keeps the fields a model write re-sends", () => {
    const [entry] = toWebuiModelProviderView(runtimeRow()).models;
    expect(entry?.enabled).toBe(true);
    expect(entry?.selected).toBe(true);
    expect(entry?.thinking).toEqual({ effort: "high" });
    expect(entry?.status).toEqual({ state: "ready", lastTestedAt: 7 });
  });
});

describe("the header rows the editor builds from the read", () => {
  it("keeps an unchanged saved row's stored value", () => {
    // What the panel builds from `headerNames`: a blank value with the saved name.
    const rows = [
      { id: "p1-0", name: "X-A", value: "", persistedName: "X-A" },
      { id: "p1-1", name: "X-B", value: "", persistedName: "X-B" },
    ];
    expect(projectProviderHeaders(rows, ["X-A", "X-B"])).toEqual({});
  });

  it("replaces a saved value and removes a dropped name", () => {
    const rows = [
      { id: "p1-0", name: "X-A", value: "new-value", persistedName: "X-A" },
      { id: "p1-1", name: "X-C", value: "added" },
    ];
    expect(projectProviderHeaders(rows, ["X-A", "X-B"])).toEqual({
      headers: { "X-A": "new-value", "X-C": "added" },
      removeHeaders: ["X-B"],
    });
  });

  it("refuses a renamed row with no value", () => {
    const rows = [{ id: "p1-0", name: "X-Renamed", value: "", persistedName: "X-A" }];
    expect(projectProviderHeaders(rows, ["X-A"])).toEqual({ error: "missing-value" });
  });
});
