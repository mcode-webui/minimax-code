// Safety net — the shell stylesheet's structure.
//
// `webui-design-tokens.test.ts` guards the token surface and the compiled
// stylesheet's `var()` closure. This file guards the layer those assertions do
// not reach: the structural declarations and the at-rules a deduplication may
// touch when it collapses the two stacked generations of the same selector.
//
// Why it matters: `shell.css` defines 39 selectors more than once, and the
// winner is decided by cascade order. A deduplication that keeps the *wrong*
// declaration, or that deletes a `@media (prefers-reduced-motion: reduce)`
// override while keeping the base rule, produces a stylesheet that still parses
// and still contains every class name — the existing assertions would stay
// green. Every value below is copied from the current source, so such an edit
// fails here.
//
// This reads the SOURCE stylesheets, not `dist-webui/client/styles.css`, so it
// does not depend on `pnpm build:styles` having run.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { SKELETON_CONTENT_MAX_WIDTH_PX } from "../../src/client/features/transcript/ui/TranscriptSkeletons.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.resolve(here, "../../src/client/styles");
const clientDir = path.resolve(here, "../../src/client");

/**
 * The class names the shared dropdown is given by its call sites.
 *
 * A popup is the shared layer's element: it is `position: fixed` and the
 * placement writes its `top`/`left`. The class a call site adds is the popup's
 * own class, so a rule that places it takes the placement away — and the
 * popup falls back into the page flow, a viewport below the reader.
 *
 * The list is read from the call sites rather than written out here, so a new
 * popup is covered the moment it is written.
 */
function dropdownPopupClasses(): string[] {
  const classes = new Set<string>();
  const files = readdirSync(clientDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".tsx"))
    .map((entry) => path.join(clientDir, entry));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/<WebuiDropdown\b([\s\S]*?)\/>/gu)) {
      const className = match[1].match(/\bclassName="([^"]+)"/u);
      if (className) classes.add(className[1]);
    }
  }
  return [...classes];
}

interface CssRule {
  readonly selector: string;
  readonly body: string;
  /** At-rule preludes this rule is nested inside, outermost first. */
  readonly context: readonly string[];
}

function normalizeSelector(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * A brace-matching scanner rather than a full CSS parser: enough to answer
 * "what is the winning declaration for this selector", which is all the
 * cascade checks below need. Comments are skipped so a commented-out rule is
 * never mistaken for a live one.
 */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const context: string[] = [];
  let buffer = "";
  let index = 0;

  while (index < css.length) {
    const char = css[index];
    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end < 0 ? css.length : end + 2;
      continue;
    }
    if (char === "{") {
      const prelude = normalizeSelector(buffer);
      buffer = "";
      if (prelude.startsWith("@")) {
        context.push(prelude);
        index += 1;
        continue;
      }
      let depth = 1;
      let cursor = index + 1;
      while (cursor < css.length && depth > 0) {
        const inner = css[cursor];
        if (inner === "/" && css[cursor + 1] === "*") {
          const end = css.indexOf("*/", cursor + 2);
          cursor = end < 0 ? css.length : end + 2;
          continue;
        }
        if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        if (depth === 0) break;
        cursor += 1;
      }
      rules.push({
        selector: prelude,
        body: css.slice(index + 1, cursor),
        context: [...context],
      });
      index = cursor + 1;
      continue;
    }
    if (char === "}") {
      context.pop();
      buffer = "";
      index += 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  return rules;
}

function declaration(body: string, property: string): string | undefined {
  const match = body.match(
    new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`, "u"),
  );
  return match ? normalizeSelector(match[1]) : undefined;
}

let shellRules: CssRule[];
let transcriptCss: string;
let shellCss: string;
let indexCss: string;

/**
 * A rule that participates in the file's normal cascade: inside the
 * `@layer components` wrapper, but not inside a conditional at-rule. Rules
 * nested in `@media` are a separate concern and are asserted separately.
 */
function isCascading(rule: CssRule): boolean {
  return (
    rule.context.includes("@layer components") &&
    !rule.context.some(
      (entry) =>
        entry.startsWith("@media") ||
        entry.startsWith("@supports") ||
        entry.startsWith("@keyframes"),
    )
  );
}

/** The rule that wins for a selector: the last cascading one. */
function winning(selector: string, rules: CssRule[] = shellRules): CssRule {
  const matches = rules.filter(
    (rule) => rule.selector === selector && isCascading(rule),
  );
  expect(
    matches.length,
    `no cascading rule found for ${selector}`,
  ).toBeGreaterThan(0);
  return matches[matches.length - 1];
}

function declarationsFor(selector: string, rules: CssRule[] = shellRules): string {
  return rules
    .filter((rule) => rule.selector === selector && isCascading(rule))
    .map((rule) => rule.body)
    .join("\n");
}

/** The selectors a rule targets: a rule may group several of them. */
function targetsOf(rule: CssRule): readonly string[] {
  return rule.selector.split(",").map((part) => part.trim());
}

/** Whether a rule targets the selector, naming it alone or in a group. */
function targets(rule: CssRule, selector: string): boolean {
  return targetsOf(rule).includes(selector);
}

/**
 * The value the cascade gives a property for a selector.
 *
 * A rule may group several selectors, and the declaration a reader cares
 * about may live in the grouped rule rather than in a rule that names the
 * selector on its own — a stylesheet that collapses three scroll areas into
 * one rule keeps the behaviour and loses the single-selector lookup. So the
 * lookup considers every rule that targets the selector, and among those the
 * last one that actually declares the property.
 */
function winningDeclaration(
  selector: string,
  property: string,
  rules: CssRule[] = shellRules,
): string | undefined {
  const declaring = rules.filter(
    (rule) =>
      targets(rule, selector) &&
      isCascading(rule) &&
      declaration(rule.body, property) !== undefined,
  );
  if (declaring.length === 0) return undefined;
  return declaration(declaring[declaring.length - 1]!.body, property);
}

/** Every declaration that reaches a selector, grouped rules included. */
function declarationsForTargeting(
  selector: string,
  rules: CssRule[] = shellRules,
): string {
  return rules
    .filter((rule) => targets(rule, selector) && isCascading(rule))
    .map((rule) => rule.body)
    .join("\n");
}

beforeAll(() => {
  indexCss = readFileSync(path.join(stylesDir, "index.css"), "utf8");
  // The rules under test are the shell's own population: the feature
  // rules moved out of `shell.css` into their own business files, so reading
  // that file alone would now assert over the shared remainder only. The
  // sources are that file plus the business files carved out of it — taken from
  // the entry's import list so this stays in step with the next move — and
  // deliberately *not* the two files that were already independent of it
  // (`tokens.css`, the single token authority and the pre-existing
  // `transcript-widgets.css` / `plan-mode.css`), which would add rules the
  // assertions below never counted.
  const carved = new Set([
    "tokens.css",
    "transcript-widgets.css",
    "plan-mode.css",
  ]);
  const sources = [...indexCss.matchAll(/@import\s+"([^"]+\.css)"/gu)]
    .map((match) => match[1])
    .filter(
      (specifier) =>
        !specifier.startsWith("katex/") &&
        !carved.has(specifier.replace(/^.*\//u, "")),
    )
    .map((specifier) => path.resolve(stylesDir, specifier));
  shellCss = sources.map((source) => readFileSync(source, "utf8")).join("\n");
  transcriptCss = readFileSync(
    path.resolve(stylesDir, "../features/transcript/ui/transcript-widgets.css"),
    "utf8",
  );
  shellRules = parseRules(shellCss);
});

describe("W0 · the section save button's three states", () => {
  it("is the desktop's black primary, 76x30, fading to half on disable", () => {
    // Both personalization headers pass `variant: "black"`, a filled primary
    // — not the light `gray` fill this
    // button used to draw. `black` has no disabled override of its own, so the
    // generic rule is the whole disabled state: the fill and the label stay put
    // and the control goes half-transparent.
    const black = winning(".webui-mavis-button-black").body;
    expect(declaration(black, "background")).toBe(
      "var(--bg_interaction_primary_default)",
    );
    expect(declaration(black, "color")).toBe(
      "var(--text_label_primary_default)",
    );

    const geometry = winning(".webui-section-save-button").body;
    expect(declaration(geometry, "width")).toBe("76px");
    expect(declaration(geometry, "min-width")).toBe("76px");
    expect(declaration(geometry, "height")).toBe("30px");
    expect(declaration(geometry, "padding")).toBe("0");
    expect(declaration(geometry, "text-align")).toBe("center");
    expect(declaration(geometry, "line-height")).toBe("var(--line_height_20)");

    // `opacity: .5` is the `.mavis-button.disabled` value, not the
    // shared `.6`. The shared rule also pins `cursor: default` and wins the
    // cascade unless this button restates it, so the cursor is asserted too.
    const disabled = winning(".webui-section-save-button:disabled").body;
    expect(declaration(disabled, "opacity")).toBe(".5");
    expect(declaration(disabled, "cursor")).toBe("not-allowed");
    // A black variant has no disabled fill to override, so none is declared
    // here. One appearing would be a leftover from the grey version.
    expect(declaration(disabled, "background")).toBeUndefined();
    expect(declaration(disabled, "color")).toBeUndefined();

    // The live state's hover lifts the fill to 80% black. There is deliberately
    // no hover on the disabled state — a control that cannot act must not look
    // like one that can.
    const hover = winning(".webui-section-save-button:not(:disabled):hover").body;
    expect(declaration(hover, "background")).toBe(
      "var(--bg_interaction_primary_hover)",
    );
    expect(declaration(hover, "color")).toBeUndefined();

    // The dark theme fades the whole control instead of restating the fill.
    const dark = winning(".dark .webui-section-save-button:not(:disabled):hover")
      .body;
    expect(declaration(dark, "opacity")).toBe(".8");
  });
});

describe("W0 · the memory manager's header controls", () => {
  it("sizes the controls off the bundle: 26px, 8px apart, tertiary fill", () => {
    // Transcribed, not measured. The dialog's title row states all of it:
    // `size-[26px]`, `rounded-lg`, `gap-2`, and a rest fill of
    // `bg-bg_interaction_tertiary_default` that the hover rule replaces.
    //
    // That token is `--opacity_black_1_0` in the light theme, so the rest fill
    // is declared rather than left off: it is transparent here, and it is not
    // transparent in a theme that raises it. An earlier pass dropped the boxes
    // to 20px on a 4px gap from a dark capture whose two ink centres measured
    // 24px apart -- but a centre distance cannot pin a box size without knowing
    // the glyph inset, and the bundle states the box outright.
    const actions = winning(".webui-memory-manager-header-actions").body;
    expect(declaration(actions, "gap")).toBe("var(--spacing_8)");

    const button = winning(
      ".webui-memory-manager-header-actions .webui-settings-icon-button",
    ).body;
    expect(declaration(button, "width")).toBe("26px");
    expect(declaration(button, "height")).toBe("26px");
    expect(declaration(button, "border-radius")).toBe("var(--radius_8)");
    expect(declaration(button, "background")).toBe(
      "var(--bg_interaction_tertiary_default)",
    );

    const hover = winning(
      ".webui-memory-manager-header-actions .webui-settings-icon-button:hover",
    ).body;
    expect(declaration(hover, "background")).toBe(
      "var(--bg_interaction_tertiary_hover)",
    );

    // `tertiary_selected` is deliberately absent -- in the light theme it is the
    // same `--opacity_black_1_4` as `tertiary_hover`, so a selected fill would
    // be indistinguishable from a hover.
    const restFills = shellRules
      .filter(isCascading)
      .filter((rule) => rule.selector.includes(".webui-settings-icon-button"))
      .filter((rule) => !/:hover|:focus-visible|:active/u.test(rule.selector))
      .map((rule) => declaration(rule.body, "background"))
      .filter((value) => value !== undefined && value !== "transparent");
    expect(restFills).toEqual(["var(--bg_interaction_tertiary_default)"]);
  });

  it("lines the controls up with the editor's right border", () => {
    // `.webui-personalization-header` indents its children by 16px, while the
    // editor is a *sibling* of that header and starts at the surface's own
    // padding -- so the controls sat inboard of the text below them.
    //
    // Zeroing the header's right padding, not a negative margin. The header is a
    // stretched flex item, so its box and padding do not resolve the way a
    // block's would: `margin-right: -16px` still left the controls ~19px short
    // of the border when measured off a capture.
    const header = winning(
      ".webui-memory-manager-surface .webui-personalization-header",
    ).body;
    expect(declaration(header, "padding-right")).toBe("0");
    expect(declaration(header, "margin-right")).toBeUndefined();
  });

  it("parks the character count inside the editor, 14px off both edges", () => {
    // 1:1 off the dialog -- the digits sit 14px left of the
    // border and 14px above it, inside the field.
    //
    // On its own class, and the assertion is deliberately narrow. The count used
    // to ride on `.webui-personalization-meta`, whose shared rule carries
    // `width: 100%` for the 「path · size」 row. A scoped override only wins the
    // properties it declares, so the width survived: `position: absolute` +
    // `width: 100%` + `right: 14px` put the box's left edge at -14px, and
    // `space-between` then aligned the digits to it -- bottom left, inside 12px
    // of the shared padding, on top of the text. The fix was the class, not the
    // offsets; `width` below is what has to stay unset for that to hold.
    const count = winning(".webui-memory-manager-count").body;
    expect(declaration(count, "position")).toBe("absolute");
    expect(declaration(count, "right")).toBe("0");
    expect(declaration(count, "bottom")).toBe("0");
    // The whole reserved band, painted: it has to read as the count's row
    // rather than as a gap the summary text shows through.
    expect(declaration(count, "left")).toBe("0");
    expect(declaration(count, "height")).toBe("28px");
    expect(declaration(count, "background")).toBe("var(--bg_grouped_secondary)");
    expect(declaration(count, "justify-content")).toBe("flex-end");
    expect(declaration(count, "padding")).toBe("0 14px");
    expect(declaration(count, "color")).toBe("var(--text_default_tertiary)");
    // The band's bottom corners, paired with the editor's radius below. The band
    // paints after the textarea -- it is positioned, the textarea is not -- so an
    // opaque square band covered the editor's 12px corner curve and the corner
    // read as a right angle. Concentric with the editor's border box, because
    // `.webui-memory-manager-editor` has no padding or border and the textarea
    // has no margin: `right/bottom/left: 0` lands on the same box, so the outer
    // radius matches as-is with no 1px inset arithmetic.
    expect(declaration(count, "border-radius")).toBe(
      "0 0 var(--radius_12) var(--radius_12)",
    );

    // The shared rule must not reach it. If a future edit puts the shared class
    // back on the element, the scoped rules here stop winning by default and
    // the count drifts to the bottom left again.
    const shared = winning(".webui-personalization-meta").body;
    expect(declaration(shared, "width")).toBe("100%");
  });

  it("sizes the dialog editor by content, 13 to 24 rows", () => {
    // The dialog's `autoSize: {minRows: 13, maxRows: 24}` at `!leading-6`:
    // 24px between baselines, and a 593px box for content long enough to cap
    // out, which is 24 rows. 13 rows + 8px top padding + the 28px the count
    // needs is the floor; 24 rows is the ceiling.
    const editor = winning(
      ".webui-memory-manager-editor .webui-personalization-textarea",
    ).body;
    expect(declaration(editor, "field-sizing")).toBe("content");
    // Load-bearing, and invisible when wrong: `field-sizing` only takes effect
    // when height is `auto`, the shared rule still declares `height: 300px`, and
    // without this the property was silently inert -- 348px box, text scrolling
    // under the count, nothing reported anywhere.
    expect(declaration(editor, "height")).toBe("auto");
    expect(declaration(editor, "min-height")).toBe("348px");
    expect(declaration(editor, "max-height")).toBe("612px");
    // The field is `shrink-0`: its height is its content's, not
    // the leftover space in the dialog. `flex: 1` is what pinned it at 239px.
    expect(declaration(editor, "flex")).toBe("none");
    // Prose, not code: it runs at `!text-sm !leading-6` in the UI
    // face. 12px monospace is also why a "13 row" floor was not 312px here.
    expect(declaration(editor, "font-family")).toBe("inherit");
    expect(declaration(editor, "font-size")).toBe("var(--size_14)");
    expect(declaration(editor, "line-height")).toBe("24px");
    // The count's row is reserved so the last line cannot scroll under it.
    expect(declaration(editor, "padding")).toBe("var(--spacing_8) 0 28px");
  });

  it("keeps the dialog editor bordered while the settings-page editors are not", () => {
    // Three editors, two looks, and the split is on which class the call site
    // carries. The dialog uses the base `.mavis-textarea`, which keeps a border
    // and takes `!rounded-xl` from the call site. 关于你 and 自定义指令 both add
    // `mavis-personalization-editor`, which zeroes the border and fills with
    // `--bg_grouped_tertiary` at 16px.
    const dialog = winning(
      ".webui-memory-manager-editor .webui-personalization-textarea",
    ).body;
    expect(declaration(dialog, "border")).toBe("1px solid var(--border_default)");
    expect(declaration(dialog, "border-radius")).toBe("var(--radius_12)");
    expect(declaration(dialog, "background")).toBe("transparent");

    // Hover and focus restate only `border-color`; the focus must not add a glow
    // on top of it.
    const hover = winning(
      ".webui-memory-manager-editor .webui-personalization-textarea:hover",
    ).body;
    expect(declaration(hover, "border-color")).toBe("var(--border_heavy)");
    expect(declaration(hover, "box-shadow")).toBe("none");

    // The focus ring is an outline outside the box, and the border goes back to
    // its resting colour. Drawing the blue as the border instead costs the
    // content 1px and leaves the text sitting against the ring; `outline` paints
    // on the border edge without taking layout, so the content box is the same
    // focused and unfocused. The blue itself is the app's `blue_500`, measured
    // 1:1 off the dialog, not the `border_heavy` the tokens name.
    const focus = winning(
      ".webui-memory-manager-editor .webui-personalization-textarea:focus",
    ).body;
    expect(declaration(focus, "outline")).toBe("1px solid var(--blue_500)");
    expect(declaration(focus, "border-color")).toBe("var(--border_default)");
    expect(declaration(focus, "box-shadow")).toBe("none");
    // The ring must not be drawn as the border: that is the 1px it would cost
    // the content, and the reason this is asserted as a pair.
    expect(declaration(focus, "border-color")).not.toBe("var(--blue_500)");

    // The shared rule is the `mavis-personalization-editor` half. `resize: none`
    // is global (`.mavis-textarea textarea{resize:none!important}`
    // beats even the inline `resize:vertical` one call site passes), so no
    // editor in this dialog can be dragged taller.
    const shared = winning(".webui-personalization-textarea").body;
    expect(declaration(shared, "resize")).toBe("none");
    expect(declaration(shared, "border")).toBe("none");
    expect(declaration(shared, "background")).toBe("var(--bg_grouped_tertiary)");
    expect(declaration(shared, "border-radius")).toBe("var(--radius_16)");
    // The two settings-page editors are height-clamped, not free. Their style
    // object passes `minHeight: 144, maxHeight: 200`, and
    // `field-sizing: content` with `height: auto` is what makes those two
    // numbers the whole rule -- the field grows with its text and stops at
    // 200px. The dialog overrides both for its own 13-to-24-row range.
    expect(declaration(shared, "height")).toBe("auto");
    expect(declaration(shared, "field-sizing")).toBe("content");
    expect(declaration(shared, "min-height")).toBe("144px");
    expect(declaration(shared, "max-height")).toBe("200px");
  });

  it("separates the dialog's footer with space, not a rule", () => {
    // The last row is `flex justify-between`: the timestamp on the
    // left, 取消/保存 on the right, 20px from the editor above and 16px between
    // the two buttons. There is no divider -- the gap is the divider.
    const footer = winning(".webui-memory-manager-footer").body;
    expect(declaration(footer, "gap")).toBe("var(--spacing_20)");
    expect(declaration(footer, "border-top")).toBeUndefined();
    expect(declaration(footer, "padding-top")).toBeUndefined();

    const actions = winning(".webui-memory-manager-actions").body;
    expect(declaration(actions, "gap")).toBe("var(--spacing_16)");
  });
});

describe("W0 · stylesheet composition", () => {
  it("layers the stylesheets in the documented order", () => {
    const imports = [...indexCss.matchAll(/@import\s+"([^"]+)"/gu)].map(
      (match) => match[1],
    );
    // The shell's rules were split into per-business files; the composition
    // order below is the documented one, and the layered order is what makes
    // the split harmless (every file wraps its rules in `@layer components`).
    expect(imports).toEqual([
      "./tokens.css",
      "./shell.css",
      // The shared dropdown surface: the look, the motion and the shape every
      // floating popup in the client shares.
      "./dropdown.css",
      "../features/plugins/ui/plugins.css",
      "../features/settings/ui/settings.css",
      "../features/models/ui/models.css",
      "../features/interactions/ui/interactions.css",
      "../features/composer/ui/composer.css",
      "../features/transcript/ui/transcript.css",
      "../features/sessions/ui/sessions.css",
      "../features/workspace/ui/workspace.css",
      "../features/workspace/ui/workspace-progress.css",
      "../features/browser/ui/browser.css",
      "../features/goal/ui/goal.css",
      "../features/account/ui/account.css",
      "../features/transcript/ui/transcript-widgets.css",
      "../features/interactions/ui/plan-mode.css",
      "katex/dist/katex.min.css",
    ]);
  });

  it("emits the three tailwind directives exactly once each", () => {
    for (const directive of ["base", "components", "utilities"])
      expect(indexCss).toContain(`@tailwind ${directive};`);
    expect([...indexCss.matchAll(/@tailwind\s+\w+;/gu)]).toHaveLength(3);
  });

  it("wraps shell.css in the components layer", () => {
    expect(shellCss).toContain("@layer components {");
    // Every rule in the file is inside that layer, so none of them may sit at
    // the top level of the parsed output.
    expect(shellRules.filter((rule) => rule.context.length === 0)).toHaveLength(
      0,
    );
  });
});

describe("W0 · structural declarations W5 must preserve", () => {
  it("keeps the rail at the desktop's fixed width", () => {
    // The shell markup pins the same value via `w-[240px]`, so the two must
    // keep agreeing — a rail that is 240 in CSS but 256 in markup renders at
    // whichever wins, which is how the two drifted apart in the first place.
    expect(declaration(winning(".webui-rail").body, "width")).toBe("240px");
  });

  it("reserves a non-overlapping right gutter while the progress panel floats", () => {
    expect(declarationsFor(".webui-session-layout")).toContain("min-height: 0");
    expect(declaration(winning(".webui-session-layout").body, "position")).toBe(
      "relative",
    );
    expect(declaration(winning(".webui-session-layout").body, "width")).toBe(
      "100%",
    );
    // Must stay wider than the floating progress panel itself, or the panel
    // would sit on top of the transcript instead of beside it.
    expect(
      declaration(winning(".webui-session-has-progress-panel").body, "padding-right"),
    ).toBe("312px");

    const viewport = winning(".webui-session-scroll-viewport");
    expect(declaration(viewport.body, "min-height")).toBe("0");
    expect(declaration(viewport.body, "flex")).toBe("1 1 auto");
    expect(declaration(viewport.body, "overflow-y")).toBe("auto");
    const sessionViewport = winning(
      ".webui-session-layout .webui-session-scroll-viewport",
    );
    expect(declaration(sessionViewport.body, "min-width")).toBe("0");
    expect(declaration(sessionViewport.body, "align-items")).toBe("stretch");

    const progressMotion = winning(".webui-progress-panel-motion");
    expect(declaration(progressMotion.body, "position")).toBe("fixed");
    expect(declaration(progressMotion.body, "overflow")).toBe("hidden");
    const progressPanel = winning(".webui-progress-overview-panel");
    expect(declaration(progressPanel.body, "min-height")).toBe("0");
    const workspaceSectionTitle = winning(".webui-workspace-section-title");
    expect(declaration(workspaceSectionTitle.body, "padding")).toBe("0 var(--spacing_6)");
    expect(declaration(workspaceSectionTitle.body, "font-size")).toBe("var(--size_14)");
    expect(declaration(workspaceSectionTitle.body, "line-height")).toBe("20px");
    expect(declaration(winning(".webui-progress-overview-main").body, "flex")).toBe("0 1 auto");
    const progressCard = winning(".webui-progress-overview-card");
    expect(declaration(progressCard.body, "height")).toBe("auto");
    expect(declaration(progressCard.body, "box-shadow")).toBe("none");
    expect(progressCard.body).toContain(
      "max-height: max(0px, min(560px, calc(100vh - 88px)))",
    );
    expect(progressCard.body).toContain(
      "max-height: max(0px, min(560px, calc(100dvh - 88px)))",
    );
    expect(declarationsFor(".webui-progress-overview-card.has-extended-content")).toHaveLength(0);
    const sectionTitleText = winning(".webui-workspace-section-title > [data-workspace-section-title]");
    expect(declaration(sectionTitleText.body, "flex")).toBe("1 1 auto");
    expect(declaration(sectionTitleText.body, "min-width")).toBe("0");
    expect(declaration(winning(".webui-progress-section").body, "height")).toBe("200px");
    expect(declaration(winning(".webui-progress-section.is-collapsed").body, "height")).toBe("28px");
    expect(declaration(winning(".webui-progress-section.webui-environment-panel").body, "height")).toBe("160px");
    expect(declaration(winning(".webui-progress-section.webui-environment-panel").body, "flex")).toBe("0 0 160px");
    const environmentLoading = winning(".webui-environment-loading");
    expect(declaration(environmentLoading.body, "min-height")).toBe("132px");
    expect(declaration(environmentLoading.body, "box-sizing")).toBe("border-box");
    const progressScroll = winning(
      ".webui-expandable-motion > .webui-progress-scroll",
    );
    expect(declaration(progressScroll.body, "overflow-y")).toBe("auto");
    expect(declaration(progressScroll.body, "overflow-x")).toBe("hidden");
    expect(winningDeclaration(".webui-progress-scroll", "scrollbar-width")).toBe("none");
    expect(winningDeclaration(".webui-subagents-scroll", "scrollbar-width")).toBe("none");
    expect(winningDeclaration(".webui-progress-scroll", "scrollbar-gutter")).toBe("auto");
    expect(winningDeclaration(".webui-subagents-scroll", "scrollbar-gutter")).toBe("auto");
    expect(declarationsForTargeting(".webui-progress-scroll::-webkit-scrollbar")).toContain("display: none");
    expect(declarationsForTargeting(".webui-subagents-scroll::-webkit-scrollbar")).toContain("display: none");
    expect(
      declaration(winning(".webui-progress-section.is-collapsed").body, "flex-basis"),
    ).toBe("28px");

    const scroll = declarationsFor(
      ".webui-session-layout .webui-session-transcript-scroll",
    );
    expect(scroll).toContain("order: 1");
    expect(scroll).toContain("min-height: 0");
    expect(scroll).toContain("min-width: 0");
    expect(scroll).toContain("flex: 0 0 auto");
    expect(scroll).toContain("align-self: stretch");
    expect(scroll).toContain("overflow: visible");

    const emptyTranscript = winning(
      '.webui-session-layout .webui-session-transcript-scroll[data-webui-transcript-empty="true"]',
    );
    expect(declaration(emptyTranscript.body, "flex")).toBe("1 1 auto");

    const emptyMessageList = winning(
      '.webui-session-layout .webui-session-transcript-scroll[data-webui-transcript-empty="true"] .message-list',
    );
    expect(declaration(emptyMessageList.body, "flex")).toBe("1 1 auto");
    expect(declaration(emptyMessageList.body, "align-items")).toBe("center");
    expect(declaration(emptyMessageList.body, "justify-content")).toBe("center");

    const emptyState = winning(".webui-transcript-empty-state");
    expect(declaration(emptyState.body, "display")).toBe("flex");
    expect(declaration(emptyState.body, "align-items")).toBe("center");
    expect(declaration(emptyState.body, "justify-content")).toBe("center");
    expect(declaration(emptyState.body, "text-align")).toBe("center");

    const messageList = winning(".webui-session-layout .message-list");
    // Narrowed 768 → 736 together with the rail so the measure still clears
    // the collapsed rail plus the floating progress panel.
    expect(declaration(messageList.body, "max-width")).toBe("736px");
    expect(declaration(messageList.body, "margin-left")).toBe("auto");
    expect(declaration(messageList.body, "margin-right")).toBe("auto");
    expect(declaration(messageList.body, "min-width")).toBe("0");
  });

  it("keeps the loading skeletons on the message list's measure", () => {
    // The skeletons are the stand-in for the message list while history loads.
    // When `.message-list` was narrowed to 736px the skeletons were left at
    // 768px, so the transcript visibly jumped sideways as content landed — and
    // nothing failed, because the two numbers lived in different files.
    const messageListWidth = declaration(
      winning(".webui-session-layout .message-list").body,
      "max-width",
    );
    expect(messageListWidth).toBe(`${SKELETON_CONTENT_MAX_WIDTH_PX}px`);

    // And the skeletons must actually use that constant, not a literal that
    // can drift again.
    const skeletons = readFileSync(
      new URL(
        "../../src/client/features/transcript/ui/TranscriptSkeletons.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(skeletons).toContain("SKELETON_CONTENT_MAX_WIDTH_PX}px");
    expect(skeletons).not.toMatch(/max-w-\[\d+px\]/u);

    const liveStatus = winning(
      ".webui-session-layout .message-list > .webui-session-stream-status",
    );
    expect(declaration(liveStatus.body, "width")).toBe("100%");
    expect(declaration(liveStatus.body, "min-width")).toBe("0");
    expect(declaration(liveStatus.body, "align-self")).toBe("stretch");

    const message = winning(".webui-session-layout .webui-message");
    expect(declaration(message.body, "min-width")).toBe("0");
    expect(declaration(message.body, "max-width")).toBe("100%");

    const composer = winning(".webui-session-layout .webui-session-composer");
    expect(declaration(composer.body, "display")).toBe("contents");

    const bottomPadding = winning(
      ".webui-session-layout .webui-session-bottom-padding",
    );
    expect(declaration(bottomPadding.body, "height")).toBe(
      "var(--webui-composer-bottom-padding, 168px)",
    );

    const composerContent = winning(
      ".webui-session-layout .webui-session-composer-overlay > *",
    );
    expect(declaration(composerContent.body, "max-width")).toBe("768px");
    expect(declaration(composerContent.body, "margin-left")).toBe("auto");
    expect(declaration(composerContent.body, "margin-right")).toBe("auto");
  });

  it("keeps the workspace beside the session and preserves a right-side explorer", () => {
    const panel = winning(".webui-workspace-panel");
    expect(declaration(panel.body, "position")).toBe("relative");
    expect(declaration(panel.body, "flex")).toBe("0 1 50%");
    expect(declaration(panel.body, "width")).toBe("50%");
    expect(declaration(panel.body, "min-width")).toBe("0");
    // The expanded panel is declared together with the covering one, so the
    // cascade lookup is the one that reads a grouped selector.
    // The panel covers its own container, which the container already pins to
    // the viewport — it is no longer pinned to the viewport itself.
    expect(winningDeclaration(".webui-workspace-panel.is-expanded", "position")).toBe("absolute");
    expect(winningDeclaration(".webui-workspace-panel.is-expanded", "inset")).toBe("0");
    expect(declaration(winning(".webui-workspace-panel-body").body, "display")).toBe("flex");
    expect(declaration(winning(".webui-workspace-file-tree-panel").body, "border-left")).toBe("1px solid var(--border_default)");
  });

  it("indents expanded workspace file-tree children", () => {
    const children = winning(".webui-file-tree-children");
    expect(declaration(children.body, "padding-left")).toBe("var(--spacing_12)");
  });

  it("keeps the markdown and code surfaces scrollable where they were", () => {
    expect(
      declaration(winning(".webui-markdown").body, "overflow-wrap"),
    ).toBe("anywhere");
    expect(declaration(winning(".webui-code-block").body, "overflow")).toBe(
      "hidden",
    );
    expect(declaration(winning(".webui-table-shell").body, "overflow-x")).toBe(
      "auto",
    );
  });

  it("keeps the base toggle switch's 40x20 track, and leaves the picker out of it", () => {
    // The base rule sizes the track with `flex: 0 0 40px`, which is the width
    // in a row container. The model picker's settings column needed a
    // column-scoped override to keep the 20px track from stretching into a
    // 40px circle — and that column is gone: the panel owns the thinking level
    // now, and it owns it with a slider rather than a switch. The base rule
    // stays untouched for the settings switches.
    const base = winning(".webui-toggle-switch");
    expect(declaration(base.body, "width")).toBe("40px");
    expect(declaration(base.body, "height")).toBe("20px");
    expect(declaration(base.body, "flex")).toBe("0 0 40px");

    expect(
      shellRules.filter((rule) => rule.selector.includes(".webui-model-detail-row")),
    ).toHaveLength(0);
  });

  it("hides the scrollbar on the model picker's list without losing scroll", () => {
    // The picker is ONE popup with two states, so it has ONE scrolling list.
    // A visible bar cuts into the popup's rounded frame; the rule only removes
    // the bar — `overflow-y: auto` stays, so the content still scrolls.
    const body = winning(".webui-model-list-groups").body;
    expect(declaration(body, "overflow-y")).toBe("auto");
    expect(declaration(body, "scrollbar-width")).toBe("none");

    const webkit = shellRules.filter(
      (rule) =>
        rule.selector.includes("::-webkit-scrollbar") &&
        rule.selector.includes(".webui-model-list-groups"),
    );
    expect(webkit).toHaveLength(1);
    expect(webkit[0]?.body).toMatch(/display:\s*none/u);
  });

  it("keeps the composer flyout inside the root menu's band", () => {
    // The flyout is pinned with `top: 0`. A `max-height` instead of a second
    // offset let a long skill list grow past the stack and off the viewport,
    // so the trailing rows were unreachable. `top`+`bottom: 0` pins both ends
    // to the stack, whose height is the root menu's.
    const flyout = winning(
      '.webui-composer-menu-stack > .webui-composer-menu[data-webui-composer-submenu]',
    );
    expect(declaration(flyout.body, "position")).toBe("absolute");
    expect(declaration(flyout.body, "top")).toBe("0");
    expect(declaration(flyout.body, "bottom")).toBe("0");
    expect(declaration(flyout.body, "overflow-y")).toBe("auto");
    // The root menu keeps its own placement: nothing in the flyout rule may
    // move it, and it must not be given a max-height shorter than the flyout.
    const root = winning(
      '.webui-composer-menu-stack > .webui-composer-menu[data-webui-composer-menu="root"]',
    );
    expect(declaration(root.body, "position")).toBe("relative");
    expect(declaration(root.body, "inset")).toBe("auto");
  });

  it("rounds both composer menus instead of squaring the touching corners", () => {
    // Squaring the seam made the flyout a right-angle panel. Both menus keep a
    // radius, so the seam rules must stay gone.
    const squaring = shellRules.filter((rule) =>
      rule.selector.includes("[data-webui-open-submenu]"),
    );
    expect(squaring).toEqual([]);

    // The radius is the shared dropdown surface's now — the composer menus are
    // dropdowns, so they declare no radius of their own.
    const menu = winning(".webui-composer-menu, .webui-composer-mention-menu");
    expect(declaration(menu.body, "border-radius")).toBeUndefined();
    const surface = winning(".webui-dropdown-popup");
    expect(declaration(surface.body, "border-radius")).toBe("12px");
  });
});

describe("W0 · at-rules and animations W5/W6 must not remove", () => {
  it("keeps every reduced-motion override and its animation-disabling body", () => {
    const reducedMotion = shellRules.filter((rule) =>
      rule.context.some((entry) => entry.includes("prefers-reduced-motion")),
    );

    // Sixteen rules across the stylesheets the shell imports. Deleting one of
    // these is the failure mode this assertion exists for: the base rule would
    // keep animating for a user who asked for reduced motion. The exact list
    // is the point -- adding an animated rule without registering its override
    // here is the same defect, in the other direction.
    expect(reducedMotion).toHaveLength(16);
    for (const rule of reducedMotion)
      expect(rule.body).toMatch(/(?:animation|transition):\s*none/u);

    const selectors = reducedMotion.map((rule) => rule.selector).sort();
    expect(selectors).toEqual([
      ".message-animate-in",
      ".signin-card-collapsing, .signin-day-claimed-animation",
      // Added with the context-usage indicator: the chevron, the hover label,
      // the bar fill and the quota bar fill all transition in their base rules.
      // The popover is NOT among them any more: its motion is the shared
      // dropdown surface's, and that surface disables its own.
      ".webui-context-usage-chevron, .webui-context-usage-label, .webui-context-usage-bar span, .webui-context-usage-quota-bar span",
      // The shared dropdown surface: it enters and leaves with an animation, so
      // a reader who asked for reduced motion would otherwise watch every
      // popup in the client slide. The fly-out surface is the same sheet: it
      // carries the same motion, so it carries the same override.
      ".webui-dropdown-popup, .webui-dropdown-popup.is-leaving, .webui-dropdown-surface",
      ".webui-environment-skeleton::after",
      ".webui-message-actions",
      // The thinking slider animates its fill, stops and thumb while the user
      // drags it; reduced motion must disable those transitions as a group.
      ".webui-model-effort-fill, .webui-model-effort-dot, .webui-model-effort-thumb",
      // The model menu's list and panel slide in during the transition, so a
      // reader who asked for reduced motion would otherwise watch both move.
      ".webui-model-menu[data-webui-model-transitioning=\"true\"] .webui-model-list, .webui-model-menu[data-webui-model-transitioning=\"true\"] .webui-model-panel",
      // Added with the project-first rail: the section that holds a project's
      // sessions opens and closes by transitioning its height, so a reader who
      // asked for reduced motion would otherwise watch the section slide.
      ".webui-progress-content-enter",
      // Added with the progress section: it and its chevron transition their
      // own state, so a reader who asked for reduced motion would otherwise
      // watch both move.
      ".webui-progress-section, .webui-progress-section-chevron",
      ".webui-project-section-content",
      // Added with the rail activity spinner. It spins forever by design, so a
      // reader who asked for reduced motion would otherwise get an animation
      // that never stops -- stopped but still drawn, so the row still reads as
      // busy.
      ".webui-rail-spinner",
      ".webui-settings-content",
      // Added with the brain trigger's hover bubble, which fades and slides in
      // its base rule.
      ".webui-thinking-label",
      // Renamed from `.webui-settings-toggle span` when the toggle became the
      // shared `.webui-toggle-switch` control.
      ".webui-toggle-switch, .webui-toggle-switch > span",
      // Added with the account menu's daily check-in fly-out, which now enters
      // with the shared surface's motion. It is rendered through a portal, so
      // the shell-wide override in `index.css` — which is scoped to
      // `[data-webui-shell] *` — does not reach it.
      ".webui-user-menu-signin-panel",
    ]);
  });

  it("keeps the shared surface's motion off the content", () => {
    // The shared surface used to enter with `translateY(-4px) scale(.98)`, and
    // that is what a reader saw as the TEXT moving: every label inside the
    // popup was drawn at 98% for the length of the animation and then drawn at
    // 100% again, so the words squashed and straightened themselves. The
    // motion slides, and a slide never changes the content's size.
    const steps = shellRules.filter((rule) =>
      rule.context.some((entry) => entry.startsWith("@keyframes webui-dropdown-")),
    );
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.body).not.toMatch(/scale\(/u);
    }
  });

  it("lets no popup class claim a position of its own", () => {
    // The shared layer owns the placement: the popup is `position: fixed` and
    // the placement writes its `top`/`left`. A popup class that declares a
    // position wins the cascade over that rule, and the popup stops being
    // placed at all — it falls back into the page flow, a viewport below the
    // reader, with the placement's coordinates added to it as an offset. The
    // panel was on screen the whole time, off screen.
    //
    // A class that styles a CHILD of the popup (a submenu, a row) may place
    // that child; the rule checked here is the one that styles the popup
    // element itself.
    const popupClasses = dropdownPopupClasses();
    expect(popupClasses.length).toBeGreaterThan(0);
    for (const className of popupClasses) {
      const own = shellRules.filter((rule) =>
        rule.selector.split(",").map((part) => part.trim()).includes(`.${className}`),
      );
      for (const rule of own) {
        for (const property of ["position", "top", "left", "right", "bottom", "z-index"]) {
          expect(
            declaration(rule.body, property),
            `${className} declares ${property} in "${rule.selector}"`,
          ).toBeUndefined();
        }
      }
    }
  });

  it("keeps every keyframe animation the shell references", () => {
    const names = [
      ...shellCss.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/gu),
    ].map((match) => match[1]);
    const transcriptNames = [
      ...transcriptCss.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/gu),
    ].map((match) => match[1]);

    // NOTE: this enumerates *declared* @keyframes, not the ones actually
    // referenced by an `animation` shorthand. `webui-popover-enter` is declared
    // but currently referenced nowhere — recorded as dead CSS rather than
    // deleted here, since removing it is a visual-affecting cleanup that
    // belongs in its own change.
    expect(names.sort()).toEqual([
      "message-appear",
      "signin-card-collapse",
      "signin-day-claimed",
      "webui-dropdown-in",
      // The shared surface's slide, and the slide for a popup that opened on
      // the other side: one slide cannot be right for a panel that comes down
      // from above its trigger and a panel that comes up from below it.
      "webui-dropdown-in-reverse",
      "webui-dropdown-out",
      "webui-dropdown-out-reverse",
      "webui-menu-enter",
      "webui-modal-enter",
      // The model menu's list and panel each slide in from their own side.
      "webui-model-list-enter",
      "webui-model-panel-enter",
      "webui-overlay-enter",
      "webui-panel-enter-right",
      "webui-popover-enter",
      "webui-progress-content-enter",
      "webui-progress-skeleton",
      "webui-settings-content-in",
      "webui-signin-claim-spin",
      "webui-user-menu-usage-pulse",
      // The workspace panel's own reveal: it grows from the right edge, and
      // the panel that covers it slides the other way.
      "webui-workspace-panel-collapse",
      "webui-workspace-panel-exit",
      "webui-workspace-panel-expand",
    ]);
    expect(transcriptNames).toEqual(["transcript-shimmer"]);
  });

  it("keeps the three !important declarations in place", () => {
    const important = shellRules.filter((rule) =>
      rule.body.includes("!important"),
    );
    expect(important).toHaveLength(3);
    expect(
      important.some((rule) =>
        rule.selector.includes(".webui-xterm-host .xterm-viewport"),
      ),
    ).toBe(true);
  });
});

describe("W0 · stacking order", () => {
  // `.webui-message-dialog`, the portal-rendered modal, is the ceiling: it
  // mounts outside the shell's stacking context, so it is the one layer that
  // cannot be covered by anything declared in this stylesheet. A value above
  // it paints over every dialog and the defect is invisible in review, so it
  // is asserted on its own rather than left to the registry below happening to
  // be complete.
  const TOP_OVERLAY = 1400;

  it("keeps the overlay stacking values declared by the shell", () => {
    const values = [
      ...shellCss.matchAll(/z-index:\s*(-?[0-9]+)/gu),
    ].map((match) => Number(match[1]));
    const unique = [...new Set(values)].sort((left, right) => left - right);

    // The exact set below already rejects an out-of-band value, but only as a
    // set diff. This names the actual defect when it happens.
    expect(unique.filter((value) => value > TOP_OVERLAY)).toEqual([]);

    expect(unique).toEqual([
      // 1 is used by the project/session row action controls.
      // 3 is `.webui-browser-notice`, the bubble the browser panel draws over
      // its own corner — the family is absent, the target changed, the page
      // dropped frames. It is rendered before the panel's stage, and the stage
      // and the input surface over it are `position: relative`/`absolute` with
      // `z-index: auto` and an opaque background, so a value of its own is
      // what keeps the bubble visible. It stays in the low band with the
      // pinned headers (1 and 2) because the browser panel is an in-flow
      // region of the shell rather than an overlay: nothing it draws may
      // cover the goal overlay at 20 or the workspace drawer at 40.
      // 5 is `.webui-workspace-panel-resize-handle`, the eight-pixel strip on
      // the panel's left edge that drags its width. It is the panel's own
      // child, so it needs a layer of its own to sit above the panel's
      // content. It stays in the low band with the pinned headers (1 and 2)
      // and the browser notice (3): the panel is an in-flow region of the
      // shell, so nothing it draws may cover the goal overlay at 20 or the
      // workspace drawer at 40. It is an edge affordance rather than an
      // overlay — eight pixels wide, transparent, and on the panel's border.
      // 40 is `.webui-workspace-panel` inside `@media (max-width: 1080px)`.
      // Above that breakpoint the panel is an in-flow flex sibling and needs no
      // layer; below it the panel is pulled out of flow into a right-docked
      // drawer (`position: absolute; inset: 0 0 0 auto`), so 40 is what lifts
      // it over the transcript and the composer overlay (20). The layers above
      // it stay above the drawer: 45 (`.webui-progress-panel-motion`) and 50
      // (`.webui-workspace-panel-controls`) are siblings of the panel, not
      // children — the controls only render while the panel is closed — and
      // 60 (`.webui-session-composer-overlay` and the hover bubbles) keeps
      // the clearance the note below describes. 45 and 50 in particular are
      // not a band the drawer has to join: they are the collapsed-state
      // affordances, and 40 landing below both leaves that ordering intact.
      // 60 is the composer's own overlay and the band the hover bubbles sit
      // in (`.webui-context-usage-label`, `.webui-thinking-label`,
      // `.webui-settings-info-hint-bubble`): they have to clear the transcript
      // and the workspace panel controls (50), and they stay under the menus
      // (70) and the dialog bands (100+). The context-usage POPOVER is not
      // among them any more — it is a dropdown, portalled to the document root
      // and layered by the shared surface at 120.
      // 80 is gone: it was the composer's own menu band, and the composer
      // menus, the command palette and the mention list are dropdowns now —
      // placed and layered by the shared surface at 120.
      // 121 is the band just above the 120 dialog scrim: the context menu's
      // submenu.
      // 130 is `.webui-account-usage-cell-tip`, the account page's calendar
      // tooltip. It is rendered through a portal so it is not clipped by the
      // calendar's scroll container, which means it is compared against
      // everything else at the root of the document: it has to clear the
      // settings dialog's own 120 scrim — the account page draws the calendar
      // inside that dialog — while staying far below the portal-rendered
      // 1400, which is the shell's ceiling.
      // 140 is `.webui-memory-confirm-mask`, the 删除记忆 confirmation. It is a
      // second modal stacked on the memory manager rather than part of it, so it
      // has to sit above that dialog's own 120 scrim while staying far below the
      // portal-rendered 1400 — it dims one dialog, it does not outrank the whole
      // shell.
      // 1400 is `.webui-message-dialog`, the portal-rendered modal shared by
      // the fork, rewind-preview and goal-clear dialogs. It mounts outside the
      // shell's stacking context, so it cannot join the 100-121 in-shell
      // dialog band and has to clear all of it.
      // 4 is gone: it was the workspace panel's add-menu anchor, and the add
      // menu became the launcher's tiles. The launcher is a tab's content
      // rather than an overlay, so it needs no layer of its own.
      1, 2, 3, 5, 20, 40, 45, 50, 60, 70, 100, 110, 111, 120, 121, 130, 140, 1400,
    ]);
  });
});

/**
 * Specificity as a sortable triple. Only the selector forms this file's
 * rules use are counted: ids, class/attribute/pseudo-class, and
 * type/pseudo-element. `winning()` above answers "which of the *same*
 * selector wins by order"; this answers the other half, "which of two
 * *different* selectors that both match wins at all" — the question a
 * dedup pass cannot see.
 */
function specificity(selector: string): [number, number, number] {
  const scope = selector.replace(/:(hover|active|focus|before|after|not)\b/gu, "");
  const ids = scope.match(/#[-\w]+/gu)?.length ?? 0;
  const classes =
    scope.match(/\.[-\w]+|\[[^\]]*\]|::?[-\w]+/gu)?.length ?? 0;
  const types = scope.match(/(?:^|[\s>+~,])([a-z][-\w]*)/giu)?.length ?? 0;
  return [ids, classes, types];
}

/** The cascade order for two selectors: positive when `a` outranks `b`. */
function compareSpecificity(
  a: readonly number[],
  b: readonly number[],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe("W0 · C-2 code gutter outranks the markdown list rules", () => {
  // The gutter is an `<ol class="webui-code-gutter">` rendered inside the
  // transcript, so `.webui-markdown ol` (`list-style-type: decimal`,
  // `margin: 0 0 0 1.8em`) matches it too. Both live in `@layer components`,
  // so the winner is decided by specificity, not by order. When the gutter's
  // own rule was the less specific of the two it lost, and a real browser
  // rendered every fence as `1. 1` / `2. 2` with the gutter pushed 1.8em
  // right. The C-2 markup tests cannot see this: they assert the rendered
  // HTML, never the cascade.
  let gutter: CssRule;
  let items: CssRule;
  let orderedList: CssRule;

  beforeAll(() => {
    gutter = winning(".webui-markdown .webui-code-gutter");
    items = winning(".webui-markdown .webui-code-gutter li");
    orderedList = winning(".webui-markdown ol");
  });

  it("binds the gutter rule tighter than the markdown ordered-list rule", () => {
    expect(specificity(gutter.selector)).toEqual([0, 2, 0]);
    expect(
      compareSpecificity(
        specificity(gutter.selector),
        specificity(orderedList.selector),
      ),
    ).toBeGreaterThan(0);
  });

  it("keeps the gutter marker-free and flush to the block's own padding", () => {
    expect(declaration(gutter.body, "list-style")).toBe("none");
    expect(declaration(gutter.body, "margin")).toBe("0");
  });

  it("gives the gutter items their own spacing without the list indent", () => {
    expect(specificity(items.selector)).toEqual([0, 2, 1]);
    expect(declaration(items.body, "margin")).toBeUndefined();
    expect(declaration(items.body, "padding")).toBeDefined();
  });
});
