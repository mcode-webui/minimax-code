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

import { resolveEffortOptions } from "../../src/client/components/ModelPicker.js";
import type { WebuiModelPickerEntry } from "../../src/client/contracts.js";

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

const FLYOUT_SOURCE = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/client/components/ModelSettingsFlyout.tsx",
  ),
  "utf8",
);

describe("who answers 'is thinking on'", () => {
  const flyoutSource = FLYOUT_SOURCE;

  it("routes the fly-out toggle through the shared resolver", () => {
    // The fly-out had its own local copy of the question, answered from the
    // recorded effort alone — a field a two-state model never writes. So the
    // toolbar brain and the fly-out switch disagreed about the same model, and
    // both were wrong. One resolver, so a third control cannot re-derive it.
    const code = flyoutSource
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).toContain("resolveThinkingVerdict(");
    // The old re-derivation, in the shape it had: an effort-only answer.
    expect(code).not.toContain('model.thinking?.effort === "on"');
  });
});

describe("what the fly-out calls the thinking control", () => {
  it("branches the label on the control's shape, not on the row", () => {
    // A switch has no level to sit at, so calling it 「推理等级」 promised a
    // scale the control cannot express — and contradicted the toolbar brain
    // beside the send button, which was already calling the same thing 思考.
    expect(FLYOUT_SOURCE).toContain('const effortLabel = isBinary ? "思考" : "推理等级";');
  });

  it("uses that one label for the visible text and both accessible names", () => {
    // Three strings for one control is three places to drift. The ToggleSwitch
    // prop reaches aria-label, so leaving it hardcoded would have left the
    // switch announcing 「推理等级」 while the row beside it read 思考.
    expect(FLYOUT_SOURCE).toContain(
      '<span className="webui-model-detail-label">{effortLabel}</span>',
    );
    expect(FLYOUT_SOURCE).toContain("label={effortLabel}");
    expect(FLYOUT_SOURCE).toContain("aria-label={effortLabel}");
    // And no literal survives anywhere the control renders it.
    expect(FLYOUT_SOURCE).not.toContain('label="推理等级"');
    expect(FLYOUT_SOURCE).not.toContain('aria-label="推理等级"');
  });
});
