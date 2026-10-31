// The model's thinking contract, as the controls read it.
//
// The suite drives the PRODUCT functions in
// `projection/thinking-control.public.ts`. The assertions are about the
// mapping between the wire and the interface: which shape a model's thinking
// has, which word names a level, and what a choice writes onto the wire.
import { describe, expect, it } from "vitest";

import {
  chipLevelLabel,
  effortLabel,
  resolveEffortOptions,
  thinkingControlShape,
  thinkingDraftPatch,
  variantForEffort,
} from "../../src/client/features/models/projection/thinking-control.public.js";
import type { WebuiModelPickerEntry } from "../../src/client/features/models/contracts/model-view.js";

const BINARY = ["off", "on"];
const DEPTH = ["low", "medium", "high"];

function entry(overrides: Partial<WebuiModelPickerEntry>): WebuiModelPickerEntry {
  return { providerId: "minimax", modelId: "M3", ...overrides };
}

describe("thinking control — which shape renders", () => {
  it("gives a two-state model a switch, in either order", () => {
    expect(thinkingControlShape(BINARY)).toBe("switch");
    expect(thinkingControlShape(["on", "off"])).toBe("switch");
  });

  it("gives a depth scale a radio group", () => {
    // A switch cannot express "medium", so anything that is not exactly the
    // off/on pair is a scale.
    expect(thinkingControlShape(DEPTH)).toBe("radiogroup");
    expect(thinkingControlShape(["default", "low", "high"])).toBe("radiogroup");
  });

  it("renders NO control for an empty option list", () => {
    // A no-op control is worse than none: it invites a click that changes
    // nothing, and it is a control the user cannot make sense of.
    expect(thinkingControlShape([])).toBeNull();
  });
});

describe("thinking control — the level the model chip names", () => {
  it("names the level for a depth scale, in the interface's language", () => {
    // The chip is Chinese, so the word on it is Chinese: a chip that says
    // "high" next to 「模型」 is two languages in one control.
    expect(chipLevelLabel(DEPTH, "high")).toBe("高");
    expect(chipLevelLabel(DEPTH, "low")).toBe("低");
    expect(chipLevelLabel(DEPTH, "medium")).toBe("中");
    // A level that is genuinely on offer. The real depth models name theirs
    // `max`, which is also the case that catches an implementation reading a
    // label off the record without checking it against the list.
    expect(chipLevelLabel(["default", "max"], "max")).toBe("最高");
  });

  it("names NOTHING for a binary model", () => {
    // A switch has no position on a scale. The word would say the same thing
    // the switch says, two controls apart.
    expect(chipLevelLabel(BINARY, "on")).toBe("");
    expect(chipLevelLabel(BINARY, "off")).toBe("");
    expect(chipLevelLabel([], undefined)).toBe("");
  });

  it("names nothing for an absent or stale record", () => {
    // The engine's default has no level to print, and a level the model does
    // not offer is a cross-model leftover — printing either would put a word
    // in the chip that nothing can honour.
    expect(chipLevelLabel(DEPTH, "")).toBe("");
    expect(chipLevelLabel(DEPTH, undefined)).toBe("");
    expect(chipLevelLabel(DEPTH, "turbo")).toBe("");
  });
});

describe("thinking control — the level's label", () => {
  it("translates the levels the wire carries", () => {
    expect(effortLabel("default")).toBe("默认");
    expect(effortLabel("off")).toBe("关闭");
    expect(effortLabel("on")).toBe("开启");
    expect(effortLabel("minimal")).toBe("极简");
    expect(effortLabel("low")).toBe("低");
    expect(effortLabel("medium")).toBe("中");
    expect(effortLabel("high")).toBe("高");
    expect(effortLabel("max")).toBe("最高");
  });

  it("shows a level it cannot translate as it arrived", () => {
    // A name we cannot translate is still better than a wrong one: the runtime's
    // levels are its own, and inventing a Chinese word for one would be a
    // claim the interface cannot back.
    expect(effortLabel("turbo")).toBe("turbo");
  });
});

describe("thinking control — what a choice writes onto the wire", () => {
  it("writes a depth level as the effort", () => {
    const model = entry({ effortOptions: DEPTH });
    expect(thinkingDraftPatch(model, "high")).toEqual({ thinkingEffort: "high" });
  });

  it("writes the default as an explicit null, which is not 'off'", () => {
    // null means "no override, the engine picks". "off" would be a different
    // claim, and the two are different requests.
    const model = entry({ effortOptions: DEPTH });
    expect(thinkingDraftPatch(model, "default")).toEqual({ thinkingEffort: null });
  });

  it("writes a switch as the VARIANT, and leaves the effort alone", () => {
    // A two-state model has no depth to record, so the state lives in the
    // variant — the field the switch actually writes.
    const model = entry({ effortOptions: BINARY });
    expect(thinkingDraftPatch(model, "on")).toEqual({ variant: "thinking" });
    expect(thinkingDraftPatch(model, "off")).toEqual({ variant: "" });
  });

  it("derives the variant only for a model that offers the off/on pair", () => {
    const depth = entry({ effortOptions: DEPTH });
    expect(variantForEffort(depth, "high")).toBeUndefined();
    const binary = entry({ effortOptions: BINARY });
    expect(variantForEffort(binary, "on")).toBe("thinking");
    expect(variantForEffort(binary, "off")).toBe("");
  });
});

describe("thinking control — the option list a model offers", () => {
  it("puts the default in front of an explicit depth list", () => {
    expect(resolveEffortOptions(entry({ effortOptions: DEPTH }))).toEqual([
      "default",
      "low",
      "medium",
      "high",
    ]);
  });

  it("does not put the default in front twice", () => {
    expect(
      resolveEffortOptions(entry({ effortOptions: ["default", "max"] })),
    ).toEqual(["default", "max"]);
  });

  it("treats a switchable model as a two-state toggle", () => {
    expect(
      resolveEffortOptions(
        entry({
          thinkingConfig: { mode: "switchable" },
          supportedVariants: ["", "thinking"],
        }),
      ),
    ).toEqual(["off", "on"]);
  });

  it("offers nothing for a model with no thinking at all", () => {
    expect(resolveEffortOptions(entry({}))).toEqual([]);
  });
});
