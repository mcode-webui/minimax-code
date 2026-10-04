// The composer's thinking trigger (roadmap H, 模型与用量).
//
// The suite drives the PRODUCT functions in `projection/thinking-control.ts`.
// Almost every assertion here is about the three-valued verdict rather than
// about a boolean, because collapsing the third value into `false` is the
// mistake this module exists to make impossible: it renders an unstated state
// as a confidently-off one.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  brainHoverLabel,
  brainTone,
  isThinkingOn,
  resolveEffortCurrent,
  thinkingControlShape,
} from "../../src/client/projection/thinking-control.js";
import { ThinkingTrigger } from "../../src/client/components/ThinkingTrigger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const componentPath = path.resolve(
  here,
  "../../src/client/components/ThinkingTrigger.tsx",
);

const BINARY = ["off", "on"];
const DEPTH = ["low", "medium", "high"];

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

describe("thinking control — the third verdict is not 'off'", () => {
  it("returns null for the engine's default, which nothing here can verify", () => {
    // The wire says "" means "no override, the engine picks", and the engine
    // never reports back which level it chose. `false` here would paint a
    // grey brain next to the word "Default" and assert a state this process
    // does not know.
    expect(isThinkingOn(BINARY, "")).toBeNull();
    expect(isThinkingOn(BINARY, undefined)).toBeNull();
    expect(isThinkingOn(BINARY, "   ")).toBeNull();
  });

  it("returns null for a record the model does not offer", () => {
    // A cross-model leftover, not a state: the record does not describe this
    // model, so it cannot say anything about it.
    expect(isThinkingOn(BINARY, "high")).toBeNull();
    expect(isThinkingOn(DEPTH, "on")).toBeNull();
  });

  it("returns true only for a recorded on or a recorded depth", () => {
    expect(isThinkingOn(BINARY, "on")).toBe(true);
    // A depth is a request FOR thinking; treating it as off would grey the
    // control while the engine is visibly reasoning.
    expect(isThinkingOn(DEPTH, "medium")).toBe(true);
  });

  it("returns false only for an explicit off", () => {
    expect(isThinkingOn(BINARY, "off")).toBe(false);
  });

  it("maps the verdict to three distinct tones, never collapsing unstated", () => {
    expect(brainTone(true)).toBe("on");
    expect(brainTone(false)).toBe("off");
    // This is the assertion that would fail if someone wrote
    // `thinkingOn ? "on" : "off"`.
    expect(brainTone(null)).toBe("unstated");
    expect(new Set([brainTone(true), brainTone(false), brainTone(null)]).size).toBe(3);
  });
});

describe("thinking control — what the control highlights", () => {
  it("highlights nothing while previewing another model", () => {
    // The record belongs to the active model; highlighting it against another
    // model is a lie about which model the setting is for.
    expect(resolveEffortCurrent(BINARY, "on", true)).toBeNull();
  });

  it("maps the engine default to 'default'", () => {
    expect(resolveEffortCurrent(DEPTH, "", false)).toBe("default");
    expect(resolveEffortCurrent(DEPTH, undefined, false)).toBe("default");
  });

  it("highlights a recorded option the target offers", () => {
    expect(resolveEffortCurrent(DEPTH, "high", false)).toBe("high");
  });

  it("highlights NOTHING for a stale recorded level", () => {
    // Not "default": falling back would silently pretend the engine default is
    // picked, which is the anti-stale rule the row badge already applies.
    expect(resolveEffortCurrent(DEPTH, "on", false)).toBeNull();
  });

  it("holds for the switch form, which never builds an option list", () => {
    // Gating the switch's checked state on a rendered list made every recorded
    // "on" read as off.
    expect(resolveEffortCurrent(BINARY, "on", false)).toBe("on");
  });
});

describe("thinking control — the hover title carries the truth", () => {
  it("says the engine decides when the state is unstated", () => {
    expect(brainHoverLabel("unstated", undefined)).toBe("思考由引擎决定");
  });

  it("appends the level when the model has one", () => {
    expect(brainHoverLabel("on", "high")).toBe("已开启思考 · high");
  });

  it("keeps a state's claim and the level as two readable halves", () => {
    // One collapsed tooltip would make the control that names a level
    // indistinguishable from the one that only says whether thinking is on.
    expect(brainHoverLabel("off", "low")).toBe("已关闭思考 · low");
  });
});

describe("thinking trigger — what it renders", () => {
  function render(props: Parameters<typeof ThinkingTrigger>[0]): string {
    return renderToStaticMarkup(createElement(ThinkingTrigger, props));
  }

  it("renders nothing at all for a model with no thinking options", () => {
    const html = render({ options: [], recorded: undefined, preview: false, onChange: () => undefined });
    expect(html).toBe("");
  });

  it("makes a two-state brain a real switch", () => {
    const html = render({ options: BINARY, recorded: "on", preview: false, onChange: () => undefined });
    expect(html).toContain("<button");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-webui-thinking-tone="on"');
  });

  it("disables the switch when the state is unstated", () => {
    // The engine picked; there is nothing to toggle FROM, so offering a toggle
    // would guess which way.
    const html = render({ options: BINARY, recorded: "", preview: false, onChange: () => undefined });
    expect(html).toContain("disabled");
    expect(html).toContain('data-webui-thinking-tone="unstated"');
  });

  it("makes a depth-scale brain decoration, not a button", () => {
    // A clickable brain on a depth scale would have to pick one of
    // low/medium/high on the user's behalf — precisely the question a binary
    // control cannot ask. The LEVEL control beside it IS a button, so the
    // assertion is on the brain's own element rather than on the absence of any
    // button: what must not exist is a switch-shaped brain.
    const html = render({ options: DEPTH, recorded: "high", preview: false, onChange: () => undefined });
    expect(html).toContain("<span");
    expect(html).toContain('data-webui-thinking-indicator="on"');
    // The switch form's marker is specifically absent.
    expect(html).not.toContain("data-webui-thinking-trigger");
    // And the real control is present, because "not a button" is a claim about
    // the brain, not a claim that a depth scale cannot be set.
    expect(html).toContain('data-webui-thinking-level="true"');
  });

  it("puts the level control on screen for a depth scale", () => {
    const html = render({ options: DEPTH, recorded: "high", preview: false, onChange: () => undefined });
    expect(html).toContain("high");
  });

  it("labels an unstated level with the same 'default' the option list uses", () => {
    // `resolveEffortOptions` prepends the literal "default" to every option
    // list, so that is the vocabulary the picker already speaks. The trigger
    // using a different word for the same state would make two surfaces
    // disagree about what the engine default is called.
    const html = render({ options: DEPTH, recorded: "", preview: false, onChange: () => undefined });
    expect(html).toContain("default");
    expect(html).toContain("推理等级");
  });

  it("disables both shapes while previewing another model", () => {
    const binary = render({ options: BINARY, recorded: "on", preview: true, onChange: () => undefined });
    expect(binary).toContain("disabled");
    const depth = render({ options: DEPTH, recorded: "high", preview: true, onChange: () => undefined });
    expect(depth).toContain("disabled");
  });

  it("carries the state in aria, not only in colour", () => {
    // Colour reinforces; the accessible name decides. A control whose only
    // signal is a hue is invisible to a screen reader and to a colour-blind
    // user alike.
    const html = render({ options: BINARY, recorded: "on", preview: false, onChange: () => undefined });
    expect(html).toContain("已开启思考");
  });
});

describe("thinking trigger — the icon is the whole trigger", () => {
  const source = readFileSync(componentPath, "utf8");

  it("carries no text label beside the brain", () => {
    // 「开启」 in a label said what the brain beside it already said, two
    // controls apart in the same toolbar. The name is for assistive tech; the
    // visible trigger is the icon alone.
    expect(source).not.toMatch(/<span[^>]*>\s*开启\s*<\/span>/u);
  });

  it("hides the decorative brain from assistive technology", () => {
    // On a depth scale the brain is not a control, so announcing it as one
    // would put a focusable-sounding thing in the tab order that does nothing.
    expect(source).toContain('aria-hidden="true"');
  });
});
