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
  chipLevelLabel,
  isThinkingOn,
  resolveThinkingVerdict,
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

describe("thinking control — the level the model chip names", () => {
  it("names the level for a depth scale", () => {
    // "High" is a POSITION on a scale, which is exactly what the brain's
    // blue/grey cannot express — so the chip says it in words, beside the
    // model it belongs to.
    expect(chipLevelLabel(DEPTH, "high")).toBe("high");
    expect(chipLevelLabel(DEPTH, "low")).toBe("low");
    // A level that is genuinely on offer. The real depth models name theirs
    // `max`, which is also the case that catches an implementation reading a
    // label off the record without checking it against the list.
    expect(chipLevelLabel(["default", "max"], "max")).toBe("max");
  });

  it("names NOTHING for a binary model", () => {
    // The brain's colour already answers "on" here. A word in the chip
    // restating it would say the same thing twice, two controls apart.
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

describe("thinking control — the verdict reads the field that carries it", () => {
  it("reads the VARIANT for a two-state model, which is where its state lives", () => {
    // The regression this whole block exists for. A two-state model has no depth
    // to record, so an on/off commit writes the variant and deliberately leaves
    // `thinking.effort` empty. Reading the effort therefore read a field the
    // toggle never writes, and the brain sat in `unstated` for the whole life of
    // the session — pressing it committed a change that could never come back.
    expect(resolveThinkingVerdict(BINARY, { variant: "thinking" })).toBe(true);
    expect(resolveThinkingVerdict(BINARY, { variant: "" })).toBe(false);
    // With a recorded effort present too, the variant is still the answer: it is
    // the field the switch writes, and the effort is a leftover.
    expect(resolveThinkingVerdict(BINARY, { variant: "thinking", thinkingEffort: "" })).toBe(
      true,
    );
    expect(resolveThinkingVerdict(BINARY, { variant: "", thinkingEffort: "high" })).toBe(false);
  });

  it("keeps a present variant two-valued, never 'the engine decides'", () => {
    // The runtime always reports a variant for a selected model — falling back to
    // the model's declared default — so an unstated verdict here would mean the
    // field went missing, and painting that as "engine decides" would name a
    // state nobody chose.
    expect(brainTone(resolveThinkingVerdict(BINARY, { variant: "" }))).toBe("off");
    expect(brainTone(resolveThinkingVerdict(BINARY, { variant: "thinking" }))).toBe("on");
  });

  it("falls back to the effort only for a model that reports no variant", () => {
    // A provider whose switch is carried as an effort rather than a variant.
    expect(resolveThinkingVerdict(BINARY, { thinkingEffort: "on" })).toBe(true);
    expect(resolveThinkingVerdict(BINARY, { thinkingEffort: "off" })).toBe(false);
    expect(resolveThinkingVerdict(BINARY, {})).toBeNull();
    // A cross-model leftover still reads as unstated rather than as "on".
    expect(resolveThinkingVerdict(BINARY, { thinkingEffort: "high" })).toBeNull();
    expect(resolveThinkingVerdict(BINARY, { thinkingEffort: null })).toBeNull();
  });
});

describe("thinking control — the hover title names the action", () => {
  it("offers the press that turns thinking off, once it is on", () => {
    expect(brainHoverLabel("on")).toBe("关闭思考");
  });

  it("offers the press that turns thinking on", () => {
    expect(brainHoverLabel("off")).toBe("开启思考");
  });

  it("offers that same press from the unstated state", () => {
    // The neutral colour already declines to claim a state, so the title has
    // the same job in all three cases: say what the click does. Unstated is a
    // state the toggle acts on, not a third position to sit on.
    expect(brainHoverLabel("unstated")).toBe("开启思考");
  });

  it("states the action alone, never the state beside it", () => {
    // The old title read 「已开启思考 · 点击关闭」 — two clauses for one job, the
    // second of which is the one worth reading, and a leading 「已」 that made it
    // answer a question the glyph's colour and aria-pressed had already
    // answered twice.
    for (const tone of ["on", "off", "unstated"] as const) {
      const label = brainHoverLabel(tone);
      expect(label).not.toContain("已");
      expect(label).not.toContain("·");
      expect(label).not.toContain("点击");
    }
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

  it("goes blue from the VARIANT, with no recorded effort at all", () => {
    // What the user reported: M3's brain never turned blue and pressing it did
    // nothing. The commit wrote the variant; the brain read the effort, which
    // for a switchable model stays empty forever. The variant alone has to
    // drive both the colour and the next press.
    const on = render({
      options: BINARY, recorded: undefined, variant: "thinking",
      preview: false, onChange: () => undefined,
    });
    expect(on).toContain('data-webui-thinking-tone="on"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('title="关闭思考"');

    const off = render({
      options: BINARY, recorded: undefined, variant: "",
      preview: false, onChange: () => undefined,
    });
    expect(off).toContain('data-webui-thinking-tone="off"');
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('title="开启思考"');
  });

  it("names no level in the title, because a switch has none", () => {
    // The title used to end in "· default": the recorded effort read as a
    // position on a scale, on a control whose two states the same sentence had
    // already named. The depth level is named on the model chip instead.
    const html = render({
      options: BINARY, recorded: "", preview: false, onChange: () => undefined,
    });
    expect(html).toContain('aria-label="开启思考"');
    expect(html).not.toContain("· default");
  });

  it("keeps the switch operable when the state is unstated", () => {
    // An unstated record is the state a session STARTS in, because the user
    // has not touched thinking yet. Disabling here made the control dead
    // exactly when it was first needed: a control that cannot be used until
    // something else has already used it is not a switch. The engine's default
    // is a state the toggle acts on, not a state that locks it.
    const html = render({ options: BINARY, recorded: "", preview: false, onChange: () => undefined });
    expect(html).not.toContain("disabled");
    expect(html).toContain('data-webui-thinking-tone="unstated"');
    // Still not claiming thinking is ON — it is offering to turn it on.
    expect(html).toContain('aria-pressed="false"');
  });

  it("tells an unstated switch what pressing it does", () => {
    // 「思考由引擎决定」 is a state with no invitation in it, which reads as an
    // answer rather than a control. On the one control whose whole job is to
    // be clicked, the title has to name the action.
    const html = render({ options: BINARY, recorded: "", preview: false, onChange: () => undefined });
    expect(html).toContain('title="开启思考"');
    expect(html).not.toContain("思考由引擎决定");
  });

  it("commits an explicit on from the unstated state", () => {
    // The click is what makes the state stated. Unstated is not a third option
    // the user can be stuck on — it resolves to a real one the moment they
    // touch the control. `renderToStaticMarkup` cannot run a click, so the
    // handler's own contract is asserted from the source: the switch must
    // commit "on" for anything that is not already on.
    const source = readFileSync(componentPath, "utf8");
    expect(source).toContain('onClick={() => onChange(on === true ? "off" : "on")}');
    // And no gate may still hang the toggle on a stated record. Stripped of
    // comments first: the file explains the old rule at length, and prose
    // about `on === null` is not the code disabling on it.
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("on === null");
  });

  it("titles a stated state with the press that would reverse it", () => {
    // `renderToStaticMarkup` cannot click, so what this pins is the half of the
    // toggle that decides the payload: the title follows the state, and the
    // handler reads the same `on === true` test. The click itself is asserted
    // from the source in the test above.
    const on = render({ options: BINARY, recorded: "on", preview: false, onChange: () => undefined });
    expect(on).toContain('title="关闭思考"');
    const off = render({ options: BINARY, recorded: "off", preview: false, onChange: () => undefined });
    expect(off).toContain('title="开启思考"');
  });

  it("gives a depth-scale model no brain at all", () => {
    // The brain belongs to the two-state model alone. On a depth scale it is
    // not a switch, so there is nothing to press — and a clickable one would
    // have to pick low/medium/high on the user's behalf, precisely the question
    // a binary control cannot ask.
    //
    // It used to render a non-interactive grey glyph to "indicate" the level.
    // That is gone: a control-shaped thing that cannot be controlled is an
    // affordance for a choice the user then has to make somewhere else. The
    // level is on the model chip ("M3.1-Flash-Preview max") and is CHOSEN in the
    // picker's settings fly-out, so it is stated once and editable once.
    const html = render({ options: DEPTH, recorded: "high", preview: false, onChange: () => undefined });
    expect(html).toBe("");
  });

  it("states a depth level on the chip, never in the toolbar", () => {
    // The chip names the level beside the model ("M3.1-Flash-Preview max"), so
    // a level control here would state the same value twice, one slot apart —
    // and with the brain gone from a depth model's toolbar, the chip is the
    // only place it appears. It is CHOSEN in the picker's settings fly-out, so
    // nothing became unreachable by removing the toolbar control.
    const html = render({ options: DEPTH, recorded: "high", preview: false, onChange: () => undefined });
    expect(html).toBe("");
    expect(chipLevelLabel(DEPTH, "high")).toBe("high");
  });

  it("disables the switch while previewing another model", () => {
    // The record belongs to the ACTIVE model, so the control is inert until the
    // pointer is over the row that actually owns it.
    const binary = render({ options: BINARY, recorded: "on", preview: true, onChange: () => undefined });
    expect(binary).toContain("disabled");
  });

  it("carries the state in aria, not only in colour", () => {
    // Colour reinforces; aria decides. A control whose only signal is a hue is
    // invisible to a screen reader and to a colour-blind user alike.
    //
    // The state rides on `aria-pressed`, which is the attribute meant for it,
    // while the name names the press — so a screen reader announces the toggle
    // and its position separately rather than one sentence trying to be both.
    const on = render({ options: BINARY, recorded: "on", preview: false, onChange: () => undefined });
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('aria-label="关闭思考"');

    const off = render({ options: BINARY, recorded: "off", preview: false, onChange: () => undefined });
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('aria-label="开启思考"');
  });
});

describe("thinking trigger — the icon is the whole trigger", () => {
  const source = readFileSync(componentPath, "utf8");

  /** The file with its prose removed, so an assertion about CODE cannot be
   * satisfied or broken by a comment explaining the code. */
  function stripComments(text: string): string {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
  }

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

  it("names the three tone classes in full, or the build purges their colour", () => {
    // The cause of "the brain never turns blue", and it is invisible from the
    // DOM: the component emitted the right class and the stylesheet had no rule
    // for it. Tailwind's `components` layer is purged against the class names it
    // finds as COMPLETE literals in the client sources, so an interpolated
    // `webui-thinking-brain--${tone}` left the scanner with a prefix and dropped
    // all three tone rules from the built stylesheet — a successful build that
    // shipped a control whose only signal was missing.
    //
    // Asserted on the source rather than on a rendered colour because the colour
    // needs the built artifact, and the thing that goes wrong is the class name
    // long before anything is painted.
    for (const tone of ["on", "off", "unstated"]) {
      expect(source).toContain(`webui-thinking-brain--${tone}`);
    }
    // Comments are stripped first: this file explains the interpolated form at
    // length, and prose about it is not the code using it.
    expect(stripComments(source)).not.toContain("webui-thinking-brain--${");
  });

  it("keeps every tone class that shell.css actually styles", () => {
    // The two lists have to agree. A tone added to the projection without a
    // matching rule in the stylesheet paints nothing, and a rule added without a
    // matching tone is dead weight — either way the brain's state is unreadable
    // and only a person in the running app would notice.
    const css = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../src/client/styles/shell.css",
      ),
      "utf8",
    );
    const styled = [...css.matchAll(/\.webui-thinking-brain--([a-z]+)/g)].map((m) => m[1]);
    expect(styled.length).toBeGreaterThan(0);
    for (const tone of styled) expect(source).toContain(`webui-thinking-brain--${tone}`);
  });
});
