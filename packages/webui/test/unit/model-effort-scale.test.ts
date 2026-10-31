// The thinking scale as the panel reads it.
//
// The scale's SHAPE is the model's own, and this suite pins the reading of it:
// the stops, the position of the current level, and the two shapes a model can
// have — a depth scale and a switch.
import { describe, expect, it } from "vitest";

import {
  currentEffortValue,
  effortResetOption,
  effortScaleFor,
  effortStopIndex,
  effortStopRatio,
  isBinaryEffort,
} from "../../src/client/features/models/projection/effort-scale.js";
import type { WebuiModelPickerEntry } from "../../src/client/features/models/contracts/model-view.js";

function entry(overrides: Partial<WebuiModelPickerEntry>): WebuiModelPickerEntry {
  return { providerId: "minimax", modelId: "M3", ...overrides };
}

describe("effort scale — the stops a model offers", () => {
  it("is the model's own depth list, with the default in front", () => {
    const scale = effortScaleFor(entry({ effortOptions: ["low", "medium", "high"] }));

    expect(scale.stops.map((stop) => stop.value)).toEqual([
      "default",
      "low",
      "medium",
      "high",
    ]);
    expect(scale.stops.map((stop) => stop.label)).toEqual([
      "默认",
      "低",
      "中",
      "高",
    ]);
    expect(scale.disabled).toBe(false);
  });

  it("is a switch's two positions, and nothing else", () => {
    // A switch cannot express "the engine decides": its state is the variant,
    // and a stop that wrote an effort would move nothing.
    const scale = effortScaleFor(entry({ effortOptions: ["off", "on"] }));

    expect(scale.stops.map((stop) => stop.value)).toEqual(["off", "on"]);
    expect(scale.stops.map((stop) => stop.label)).toEqual(["关闭", "开启"]);
    expect(isBinaryEffort(entry({ effortOptions: ["off", "on"] }))).toBe(true);
  });

  it("drops the default from a switch that lists it beside its two states", () => {
    const scale = effortScaleFor(entry({ effortOptions: ["default", "off", "on"] }));

    expect(scale.stops.map((stop) => stop.value)).toEqual(["off", "on"]);
  });

  it("is empty and disabled for a model with no thinking", () => {
    const scale = effortScaleFor(entry({}));

    expect(scale.stops).toEqual([]);
    expect(scale.disabled).toBe(true);
  });

  it("is empty and disabled when there is no model at all", () => {
    expect(effortScaleFor(undefined).disabled).toBe(true);
  });
});

describe("effort scale — the stop the reset goes back to", () => {
  it("is the default for a depth scale", () => {
    // "No override, the engine decides" is a real position, not the absence of
    // one — and it is a position the scale carries.
    expect(effortResetOption(entry({ effortOptions: ["low", "medium"] }))).toBe(
      "default",
    );
  });

  it("is the position the runtime declares for a switch", () => {
    // A switch has no "engine decides" to go back to: its state is the
    // variant, and committing the default stop to it would move nothing.
    expect(
      effortResetOption(
        entry({
          effortOptions: ["off", "on"],
          thinkingConfig: { mode: "switchable", default_value: "true" },
        }),
      ),
    ).toBe("on");
    expect(
      effortResetOption(
        entry({
          effortOptions: ["off", "on"],
          thinkingConfig: { mode: "switchable", default_value: "false" },
        }),
      ),
    ).toBe("off");
  });
});

describe("effort scale — where the level sits", () => {
  it("rests on the default when the model has recorded no level", () => {
    expect(currentEffortValue(entry({ effortOptions: ["low", "medium"] }), {})).toBe(
      "default",
    );
  });

  it("rests on the recorded depth", () => {
    expect(
      currentEffortValue(
        entry({ effortOptions: ["low", "medium"], thinking: { effort: "medium" } }),
        {},
      ),
    ).toBe("medium");
  });

  it("prefers the draft over the model's own record", () => {
    // A draft is what the user is in the middle of choosing; the model's
    // record is what the runtime said last.
    expect(
      currentEffortValue(
        entry({ effortOptions: ["low", "medium"], thinking: { effort: "low" } }),
        { thinkingEffort: "medium" },
      ),
    ).toBe("medium");
  });

  it("rests on the default for a level the model does not offer", () => {
    // A cross-model leftover is not a level. The only position that does not
    // claim a level the model cannot honour is the default stop.
    expect(
      currentEffortValue(
        entry({ effortOptions: ["low", "medium"], thinking: { effort: "turbo" } }),
        {},
      ),
    ).toBe("default");
  });

  it("reads a switch's state from the VARIANT, which is where it lives", () => {
    const model = entry({ effortOptions: ["off", "on"] });

    expect(currentEffortValue({ ...model, variant: "thinking" }, {})).toBe("on");
    expect(currentEffortValue({ ...model, variant: "" }, {})).toBe("off");
    // The draft's variant wins over the model's own.
    expect(
      currentEffortValue({ ...model, variant: "" }, { variant: "thinking" }),
    ).toBe("on");
  });

  it("falls back to the runtime's own default for a switch that states none", () => {
    expect(
      currentEffortValue(
        entry({
          effortOptions: ["off", "on"],
          thinkingConfig: { mode: "switchable", default_value: "true" },
        }),
        {},
      ),
    ).toBe("on");
    expect(
      currentEffortValue(
        entry({
          effortOptions: ["off", "on"],
          thinkingConfig: { mode: "switchable", default_value: "false" },
        }),
        {},
      ),
    ).toBe("off");
  });
});

describe("effort scale — the position on the rail", () => {
  it("finds the stop a level sits on", () => {
    const scale = effortScaleFor(entry({ effortOptions: ["low", "medium", "high"] }));

    expect(effortStopIndex(scale, "default")).toBe(0);
    expect(effortStopIndex(scale, "medium")).toBe(2);
    expect(effortStopIndex(scale, "high")).toBe(3);
  });

  it("rests on the first stop for a level the scale does not carry", () => {
    const scale = effortScaleFor(entry({ effortOptions: ["low", "medium"] }));

    expect(effortStopIndex(scale, "turbo")).toBe(0);
    expect(effortStopIndex(scale, "default")).toBe(0);
  });

  it("has no position for an empty scale", () => {
    expect(effortStopIndex(effortScaleFor(entry({})), "default")).toBe(-1);
  });

  it("spreads the stops evenly along the rail", () => {
    // A fraction of the travel, not a percentage: the stops sit inside the
    // track by the thumb's radius, so the rail's ends are not the stops.
    expect(effortStopRatio(0, 4)).toBe(0);
    expect(effortStopRatio(1, 4)).toBeCloseTo(0.3333, 3);
    expect(effortStopRatio(2, 4)).toBeCloseTo(0.6667, 3);
    expect(effortStopRatio(3, 4)).toBe(1);
  });

  it("rests a single stop in the middle", () => {
    // A rail with one position is a position, not a range.
    expect(effortStopRatio(0, 1)).toBe(0.5);
  });
});
