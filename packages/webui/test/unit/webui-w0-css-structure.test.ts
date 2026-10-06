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
  it("leaves both controls unfilled until hover, 24px apart", () => {
    // Measured off the desktop dialog's *dark* capture: both glyphs sit bare on
    // the panel with no tile at all, their ink centres 24px apart at the same
    // height. The 26×26 `#f1f1ef` tile measured earlier came from the *light*
    // capture, which had the pointer parked on ⋯ — that was a hover state read
    // as a rest state, which is exactly why ⋯ rendered permanently selected
    // next to a transparent ×.
    const actions = winning(".webui-memory-manager-header-actions").body;
    expect(declaration(actions, "gap")).toBe("var(--spacing_4)");

    const button = winning(
      ".webui-memory-manager-header-actions .webui-settings-icon-button",
    ).body;
    expect(declaration(button, "width")).toBe("20px");
    expect(declaration(button, "height")).toBe("20px");
    expect(declaration(button, "border-radius")).toBe("6px");
    expect(declaration(button, "background")).toBe("transparent");

    const hover = winning(
      ".webui-memory-manager-header-actions .webui-settings-icon-button:hover",
    ).body;
    expect(declaration(hover, "background")).toBe(
      "var(--bg_interaction_tertiary_hover)",
    );

    // Asserted across every rest-state rule rather than against the one
    // selector this bug arrived on: any non-hover fill on these controls reads
    // as "selected", and `:first-child` is only the shape it happened to take.
    // `tertiary_selected` is deliberately absent — in the light theme it is the
    // same `--opacity_black_1_4` as `tertiary_hover`, so a selected fill would
    // be indistinguishable from a hover.
    const restFills = shellRules
      .filter(isCascading)
      .filter((rule) => rule.selector.includes(".webui-settings-icon-button"))
      .filter((rule) => !/:hover|:focus-visible|:active/u.test(rule.selector))
      .map((rule) => declaration(rule.body, "background"))
      .filter((value) => value !== undefined && value !== "transparent");
    expect(restFills).toEqual([]);
  });

  it("pulls the header out to the surface padding so × lines up with the editor", () => {
    // `.webui-personalization-header` indents its children by 16px, while the
    // editor is a *sibling* of that header and therefore starts at the surface's
    // own padding — so the buttons sat 16px further in than the text below them.
    // Measured on the desktop: × ink ends 11px short of the editor's right
    // border. The negative margin cancels the header's inset without moving the
    // title, which shares the same row.
    const header = winning(
      ".webui-memory-manager-surface .webui-personalization-header",
    ).body;
    expect(declaration(header, "margin-right")).toBe(
      "calc(-1 * var(--spacing_16))",
    );
  });

  it("draws the character count as a full-width band below the editor", () => {
    // It used to be absolutely positioned in the editor's bottom-right corner,
    // which matched the desktop horizontally but laid the digits *over* the last
    // row of text with the textarea's own background showing through. The
    // desktop draws a band: full width, its own background, its own line.
    const count = winning(
      ".webui-memory-manager-editor .webui-personalization-meta",
    ).body;
    expect(declaration(count, "width")).toBe("100%");
    expect(declaration(count, "background")).toBe(
      "var(--bg_interaction_secondary_default)",
    );
    // In flow it is the only child of a `space-between` row, which collapses to
    // left alignment — hence `margin-left: auto` rather than a bare stretch.
    expect(declaration(count, "margin-left")).toBe("auto");

    // The offsets only exist to pin an out-of-flow element; leaving them behind
    // is inert, so they are asserted absent rather than merely unset.
    expect(declaration(count, "position")).toBeUndefined();
    expect(declaration(count, "right")).toBeUndefined();
    expect(declaration(count, "bottom")).toBeUndefined();
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
