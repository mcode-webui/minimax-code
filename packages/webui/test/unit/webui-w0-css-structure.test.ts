// W0 safety net — the shell stylesheet's structure.
//
// `webui-design-tokens.test.ts` guards the token surface and the compiled
// stylesheet's `var()` closure. This file guards the layer those assertions do
// not reach: the structural declarations and the at-rules that W5 is allowed to
// touch when it deduplicates the two stacked generations of the same selector.
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
import { readFileSync } from "node:fs";
import { SKELETON_CONTENT_MAX_WIDTH_PX } from "../../src/client/components/TranscriptSkeletons.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.resolve(here, "../../src/client/styles");

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

beforeAll(() => {
  shellCss = readFileSync(path.join(stylesDir, "shell.css"), "utf8");
  indexCss = readFileSync(path.join(stylesDir, "index.css"), "utf8");
  transcriptCss = readFileSync(
    path.join(stylesDir, "transcript-widgets.css"),
    "utf8",
  );
  shellRules = parseRules(shellCss);
});

describe("W0 · the section save button's three states", () => {
  it("is the desktop's black primary, 76x30, fading to half on disable", () => {
    // Both personalization headers pass `variant: "black"` in the desktop
    // bundle, which is a filled primary — not the light `gray` fill this
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

    // `opacity: .5` is the desktop's `.mavis-button.disabled` value, not the
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
    // Measured off the desktop dialog at 1:1 -- the digits sit 14px left of the
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

    // The shared rule must not reach it. If a future edit puts the shared class
    // back on the element, the scoped rules here stop winning by default and
    // the count drifts to the bottom left again.
    const shared = winning(".webui-personalization-meta").body;
    expect(declaration(shared, "width")).toBe("100%");
  });

  it("sizes the dialog editor by content, 13 to 24 rows", () => {
    // The desktop's `autoSize: {minRows: 13, maxRows: 24}` at `!leading-6`:
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
    // The desktop marks the field `shrink-0`: its height is its content's, not
    // the leftover space in the dialog. `flex: 1` is what pinned it at 239px.
    expect(declaration(editor, "flex")).toBe("none");
    // Prose, not code: the desktop runs it at `!text-sm !leading-6` in the UI
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

    // The focus edge is the app's blue, measured 1:1 off the desktop dialog as a
    // 1px #0077d9. The bundle's `.mavis-textarea:focus{border_heavy}` rule says
    // otherwise, but the control does not draw that, so the pixel wins.
    const focus = winning(
      ".webui-memory-manager-editor .webui-personalization-textarea:focus",
    ).body;
    expect(declaration(focus, "border-color")).toBe("var(--blue_500)");
    expect(declaration(focus, "box-shadow")).toBe("none");
    expect(declaration(focus, "outline")).toBe("none");

    // The shared rule is the `mavis-personalization-editor` half. `resize: none`
    // is global on the desktop (`.mavis-textarea textarea{resize:none!important}`
    // beats even the inline `resize:vertical` one call site passes), so no
    // editor in this dialog can be dragged taller.
    const shared = winning(".webui-personalization-textarea").body;
    expect(declaration(shared, "resize")).toBe("none");
    expect(declaration(shared, "border")).toBe("none");
    expect(declaration(shared, "background")).toBe("var(--bg_grouped_tertiary)");
    expect(declaration(shared, "border-radius")).toBe("var(--radius_16)");
    // The two settings-page editors are height-clamped, not free. The desktop
    // passes `minHeight: 144, maxHeight: 200` in the style object, and
    // `field-sizing: content` with `height: auto` is what makes those two
    // numbers the whole rule -- the field grows with its text and stops at
    // 200px. The dialog overrides both for its own 13-to-24-row range.
    expect(declaration(shared, "height")).toBe("auto");
    expect(declaration(shared, "field-sizing")).toBe("content");
    expect(declaration(shared, "min-height")).toBe("144px");
    expect(declaration(shared, "max-height")).toBe("200px");
  });

  it("separates the dialog's footer with space, not a rule", () => {
    // The desktop's last row is `flex justify-between`: the timestamp on the
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
    expect(imports).toEqual([
      "./tokens.css",
      "./shell.css",
      "./transcript-widgets.css",
      "./plan-mode.css",
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
        "../../src/client/components/TranscriptSkeletons.tsx",
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
    const expanded = winning(".webui-workspace-panel.is-expanded");
    expect(declaration(expanded.body, "position")).toBe("fixed");
    expect(declaration(expanded.body, "inset")).toBe("0");
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

  it("keeps the model picker switch on its 40x20 track", () => {
    // The base rule sizes the track with `flex: 0 0 40px`, which is the width
    // in a row container. The model detail column is `flex-direction: column`,
    // so that basis lands on the main axis and turns the 20px track into a
    // 40px circle. The column-scoped override is what keeps it a pill; the base
    // rule stays untouched for the settings switches.
    const base = winning(".webui-toggle-switch");
    expect(declaration(base.body, "width")).toBe("40px");
    expect(declaration(base.body, "height")).toBe("20px");
    expect(declaration(base.body, "flex")).toBe("0 0 40px");

    const inColumn = winning(
      ".webui-model-detail-row .webui-toggle-switch",
    );
    expect(declaration(inColumn.body, "flex")).toBe("0 0 auto");
    expect(declaration(inColumn.body, "align-self")).toBe("flex-start");
  });

  it("hides the scrollbar on both model picker panels without losing scroll", () => {
    // Both columns overflow; a visible bar cuts into the menu's rounded frame.
    // The rules only remove the bar — `overflow-y: auto` stays on both, so the
    // content still scrolls.
    for (const selector of [
      ".webui-model-menu-list",
      ".webui-model-menu-detail",
    ]) {
      const body = winning(selector).body;
      expect(declaration(body, "overflow-y")).toBe("auto");
    }

    const hidden = winning(
      ".webui-model-menu-list, .webui-model-menu-detail",
    );
    expect(declaration(hidden.body, "scrollbar-width")).toBe("none");

    const webkit = shellRules.filter(
      (rule) =>
        rule.selector.includes("::-webkit-scrollbar") &&
        rule.selector.includes(".webui-model-menu-list"),
    );
    expect(webkit).toHaveLength(1);
    expect(webkit[0]?.selector).toContain(".webui-model-menu-detail");
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
    // Squaring the seam made the flyout a right-angle panel. Both menus now
    // keep the base 14px radius, so the seam rules must stay gone.
    const squaring = shellRules.filter((rule) =>
      rule.selector.includes("[data-webui-open-submenu]"),
    );
    expect(squaring).toEqual([]);

    const menu = winning(
      ".webui-composer-menu, .webui-composer-permission-menu, .webui-composer-mention-menu",
    );
    expect(declaration(menu.body, "border-radius")).toBe("14px");
  });
});

describe("W0 · at-rules and animations W5/W6 must not remove", () => {
  it("keeps every reduced-motion override and its animation-disabling body", () => {
    const reducedMotion = shellRules.filter((rule) =>
      rule.context.some((entry) => entry.includes("prefers-reduced-motion")),
    );

    // Seven blocks in shell.css, eight rules inside them (the settings block
    // disables two selectors). Deleting one of these is the failure mode this
    // assertion exists for: the base rule would keep animating for a user who
    // asked for reduced motion. The exact list is the point -- adding an
    // animated rule without registering its override here is the same defect,
    // in the other direction.
    expect(reducedMotion).toHaveLength(8);
    for (const rule of reducedMotion)
      expect(rule.body).toMatch(/(?:animation|transition):\s*none/u);

    const selectors = reducedMotion.map((rule) => rule.selector).sort();
    expect(selectors).toEqual([
      ".message-animate-in",
      ".signin-card-collapsing, .signin-day-claimed-animation",
      // Added with the context-usage indicator: the chevron, the hover label,
      // the popover, the bar fill and the quota bar fill all transition in
      // their base rules.
      ".webui-context-usage-chevron, .webui-context-usage-popover, .webui-context-usage-label, .webui-context-usage-bar span, .webui-context-usage-quota-bar span",
      ".webui-message-actions",
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
    ]);
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
      "webui-menu-enter",
      "webui-modal-enter",
      "webui-overlay-enter",
      "webui-panel-enter-right",
      "webui-popover-enter",
      "webui-settings-content-in",
      "webui-settings-search-highlight",
      "webui-signin-claim-spin",
      "webui-user-menu-usage-pulse",
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
      // 40 is `.webui-workspace-panel` inside `@media (max-width: 1080px)`.
      // Above that breakpoint the panel is an in-flow flex sibling and needs no
      // layer; below it the panel is pulled out of flow into a right-docked
      // drawer (`position: absolute; inset: 0 0 0 auto`), so 40 is what lifts
      // it over the transcript and the composer overlay (20). The layers above
      // it stay above the drawer: 45 (`.webui-progress-panel-motion`) and 50
      // (`.webui-workspace-panel-controls`) are siblings of the panel, not
      // children — the controls only render while the panel is closed — and
      // 60 (`.webui-context-usage-popover`) keeps the clearance the note below
      // describes. 45 and 50 in particular are not a band the drawer has to
      // join: they are the collapsed-state affordances, and 40 landing below
      // both leaves that ordering intact.
      // 60 is `.webui-context-usage-popover`: it has to clear the transcript
      // and the composer overlay (20) and the workspace panel controls (50),
      // and it stays under the model/workspace menus (70) and the dialog
      // bands (100+).
      // 140 is `.webui-memory-confirm-mask`, the 删除记忆 confirmation. It is a
      // second modal stacked on the memory manager rather than part of it, so it
      // has to sit above that dialog's own 120 scrim while staying far below the
      // portal-rendered 1400 — it dims one dialog, it does not outrank the whole
      // shell.
      // 1400 is `.webui-message-dialog`, the portal-rendered modal shared by
      // the fork, rewind-preview and goal-clear dialogs. It mounts outside the
      // shell's stacking context, so it cannot join the 100-121 in-shell
      // dialog band and has to clear all of it.
      1, 2, 4, 20, 40, 45, 50, 60, 70, 80, 100, 110, 111, 120, 121, 140, 1400,
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
