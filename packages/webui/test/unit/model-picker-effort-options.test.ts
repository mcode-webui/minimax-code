/**
 * `resolveEffortOptions` — which control shape a model's thinking supports.
 *
 * The binary case is the one that was silently broken: a `switchable` model
 * whose variant list never reached the client produced NO control at all, and
 * a model with no thinking control is indistinguishable from a model whose
 * thinking control failed to render. Both look like "the feature is missing".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveEffortOptions,
  thinkingDraftPatch,
  variantForEffort,
} from "../../src/client/features/models/projection/thinking-control.public.js";
import type { WebuiModelPickerEntry } from "../../src/client/features/models/contracts/model-view.js";
import type { WebuiModelEntry } from "../../src/shared/contracts/models.js";

function entry(over: Partial<WebuiModelPickerEntry> = {}): WebuiModelPickerEntry {
  return { providerId: "minimax_api", modelId: "MiniMax-M3", ...over };
}

/** M3 as the runtime projects it: switchable, with a normalised variant list. */
const SWITCHABLE = entry({
  thinkingConfig: { mode: "switchable", default_value: "true" },
  supportedVariants: ["thinking", ""],
});

describe("effort options — the binary case", () => {
  it("gives a switchable model a two-state control", () => {
    expect(resolveEffortOptions(SWITCHABLE)).toEqual(["off", "on"]);
  });

  it("still reads the switch off the variant list when there is one", () => {
    // `default_value` is the safety net, not the only path: a model can be
    // switchable with variants normalised differently by an older runtime.
    const { default_value, ...config } = SWITCHABLE.thinkingConfig!;
    expect(resolveEffortOptions({ ...SWITCHABLE, thinkingConfig: config })).toEqual([
      "off",
      "on",
    ]);
  });

  it("recognises the un-normalised none-thinking name", () => {
    // `normalizeSupportedVariants` maps none-thinking to "", but a runtime that
    // has not normalised it must not cost the user the control.
    expect(
      resolveEffortOptions({
        ...SWITCHABLE,
        supportedVariants: ["none-thinking", "thinking"],
      }),
    ).toEqual(["off", "on"]);
  });

  it("survives the variant list not arriving at all", () => {
    // The failure this exists for: the brain icon disappeared entirely, with
    // no error anywhere, because one field was missing from the payload.
    const { supportedVariants, ...without } = SWITCHABLE;
    expect(resolveEffortOptions(without)).toEqual(["off", "on"]);
  });

  it("gives a depth-scale model its levels, never a switch", () => {
    expect(
      resolveEffortOptions(entry({ effortOptions: ["default", "low", "high"] })),
    ).toEqual(["default", "low", "high"]);
  });

  it("gives a model with no thinking contract nothing", () => {
    expect(resolveEffortOptions(entry())).toEqual([]);
    expect(resolveEffortOptions(entry({ thinkingConfig: { mode: "forced_on" } }))).toEqual([]);
  });
});

const PANEL_SOURCE = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/client/features/models/ui/ModelPanel.tsx",
  ),
  "utf8",
);

describe("who answers 'is thinking on'", () => {
  it("routes the panel's control through the shared scale", () => {
    // The panel reads the level through the scale module, which is the one
    // place that knows a switch's state lives in the VARIANT. A local copy of
    // the question — answered from the recorded effort alone, a field a
    // two-state model never writes — is how the toolbar brain and the fly-out
    // switch came to disagree about the same model, and both were wrong.
    const code = PANEL_SOURCE
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).toContain("currentEffortValue(");
    expect(code).toContain("effortScaleFor(");
    // The old re-derivation, in the shape it had: an effort-only answer.
    expect(code).not.toContain('model.thinking?.effort === "on"');
  });
});

describe("what the panel calls the thinking control", () => {
  it("names the level with the shared label, in the interface's language", () => {
    // One label, from the one table that knows it: a level word the interface
    // cannot translate is shown as it arrived, but a level word translated
    // twice is two translations to disagree.
    expect(PANEL_SOURCE).toContain("effortLabel(");
    expect(PANEL_SOURCE).not.toContain("推理等级");
  });
});

describe("what selecting an effort writes onto a draft", () => {
  // The cascade's fly-out and the composer's trigger each spelled these three
  // branches out; the copies were identical. The shapes are the contract's, not
  // the control's, so they are pinned here once.
  const LEVELS = entry({ effortOptions: ["default", "low", "high", "max"] });

  it("carries a binary model's state in the wire variant", () => {
    expect(thinkingDraftPatch(SWITCHABLE, "on")).toEqual({ variant: "thinking" });
    expect(thinkingDraftPatch(SWITCHABLE, "off")).toEqual({ variant: "" });
  });

  it("carries a level in thinkingEffort, with no variant", () => {
    expect(thinkingDraftPatch(LEVELS, "high")).toEqual({ thinkingEffort: "high" });
    expect(variantForEffort(LEVELS, "high")).toBeUndefined();
  });

  it("asks for no override on `default`, which is not the same as off", () => {
    // `null` means "the engine picks"; `variant: ""` means "off". Collapsing
    // them would make the brain claim a state the user did not choose.
    expect(thinkingDraftPatch(SWITCHABLE, "default")).toEqual({
      thinkingEffort: null,
    });
    expect(thinkingDraftPatch(LEVELS, "default")).toEqual({
      thinkingEffort: null,
    });
  });

  it("writes nothing for a model whose options are empty", () => {
    const none = entry();
    expect(thinkingDraftPatch(none, "on")).toEqual({});
    expect(thinkingDraftPatch(none, "off")).toEqual({});
  });
});

describe("the wire DTO the runtime sends", () => {
  it("declares the variant list the picker reads", () => {
    // Typed as the wire DTO, not as the picker's view type: if
    // `WebuiModelEntry` stopped declaring `supportedVariants`, the read below
    // would fall back to the index signature's `unknown` and this file would
    // not compile. That is how the field went missing from the contract while
    // the client kept reading it — nothing failed, because an index signature
    // accepts whatever the runtime sends.
    const model: WebuiModelEntry = {
      providerId: "minimax_api",
      modelId: "MiniMax-M3",
      thinkingConfig: { mode: "switchable", default_value: "true" },
      supportedVariants: ["thinking", ""],
    };
    const declared: readonly string[] = model.supportedVariants ?? [];
    expect(declared).toEqual(["thinking", ""]);
    expect(resolveEffortOptions(model)).toEqual(["off", "on"]);
  });
});
