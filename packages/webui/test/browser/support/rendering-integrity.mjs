// Rendering-integrity evidence for a migrated surface (ADR 0028 § Rendering
// integrity after extraction).
//
// A migration must not squeeze, deform, reflow or truncate anything, and the
// data must still render. Pixels alone cannot say that: the pixmap baselines
// record a broken render as "no change" once they are re-recorded, and they say
// nothing about whether a label was cut off. So this module measures the
// surface instead and compares the measurement with the one taken before the
// migration — the manifest beside this file — over the states the surface
// enumerates, in both themes.
//
// The assertions are independent of the screenshots in two ways: they run
// whether or not any baseline was captured, and they are about the DOM — an
// element is present, is not zero-sized, lies inside its container and the
// viewport, and neither its text nor its scroll extent is clipped.
//
// A surface whose content extremes are not enumerated is reported as
// `unverified`. It is not a pass and it is not a failure of the surface: it is
// the statement that this suite has no evidence for it, which is what the ADR
// asks the report to say rather than to round up.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";

/** Where the before-migration measurements live, beside this module. */
export const MANIFEST_PATH = fileURLToPath(new URL("./rendering-integrity.json", import.meta.url));

/** Both client themes, by the preference the appearance setting persists. */
export const THEMES = ["light", "dark"];

/**
 * The extremes every surface that can show them enumerates.
 *
 * `empty`, `one`, `maximum` and `longest` are the four the ADR names; a surface
 * that cannot show one of them does not declare it, and the report says which
 * of the four it covers rather than assuming coverage.
 */
export const EXTREMES = ["empty", "one", "maximum", "longest"];

/** Load the recorded measurements, or an empty manifest when none exists yet. */
export function loadManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return { version: 1, states: {} };
  }
}

export function saveManifest(manifest) {
  const states = Object.fromEntries(
    Object.keys(manifest.states)
      .sort()
      .map((key) => [key, manifest.states[key]]),
  );
  writeFileSync(MANIFEST_PATH, `${JSON.stringify({ version: 1, states }, null, 2)}\n`, "utf8");
}

export function manifestKey(surface, state, theme) {
  return `${surface}/${state}/${theme}`;
}

/**
 * Apply a theme before the document loads.
 *
 * The client persists the *preference* in `localStorage` and puts `dark` or
 * `light` on `<html>`; setting the preference before the first paint is what
 * makes the two runs comparable, since a theme applied after load would measure
 * the transition rather than the surface.
 */
export async function useTheme(page, theme) {
  await page.addInitScript((value) => {
    window.localStorage.setItem("webui-theme", value);
  }, theme);
}

/** Resolve the theme the client actually applied, so a silent pin is visible. */
export async function appliedTheme(page) {
  return page.evaluate(() => (document.documentElement.classList.contains("dark") ? "dark" : "light"));
}

/**
 * Measure a surface in the page.
 *
 * Everything here is geometry and text extent — no colours, no pixels — so the
 * same recording can be compared across a migration that is supposed to change
 * nothing visible.
 */
async function measure(page, surface, state) {
  // The root is resolved by the caller as a Playwright locator, so a surface can
  // be named by role or test id — the selectors are the surface's own business,
  // not this module's.
  const root = state.root ?? surface.root(page);
  return root.evaluate((rootNode, spec) => {
      const intersection = (a, b) => {
        const left = Math.max(a.left, b.left);
        const top = Math.max(a.top, b.top);
        const right = Math.min(a.right, b.right);
        const bottom = Math.min(a.bottom, b.bottom);
        return Math.max(0, right - left) * Math.max(0, bottom - top);
      };

      if (!rootNode) return { missing: true };
      const rootBox = rootNode.getBoundingClientRect();
      const container = spec.containerSelector
        ? document.querySelector(spec.containerSelector)
        : null;
      const containerBox = container ? container.getBoundingClientRect() : null;

      // An element is clipped when what it must show is cut off by a box that
      // refuses to show it: an ellipsis over text that does not fit, or content
      // larger than a box that hides its overflow. A form control is not
      // clipped — its value scrolls inside it by design — and an element with an
      // explicit scroll boundary is not clipped either, because scrolling is the
      // contract it states.
      const clipped = (node) => {
        const tag = node.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
        const style = getComputedStyle(node);
        const truncatesX = node.scrollWidth > node.clientWidth + 1;
        const truncatesY = node.scrollHeight > node.clientHeight + 1;
        if (style.textOverflow === "ellipsis" && truncatesX) return true;
        const scrolls = [style.overflowX, style.overflowY].some(
          (overflow) => overflow === "auto" || overflow === "scroll",
        );
        if (scrolls) return false;
        const hides = (overflow) => overflow === "hidden" || overflow === "clip";
        return (hides(style.overflowX) && truncatesX) || (hides(style.overflowY) && truncatesY);
      };

      const items = spec.itemSelector ? [...rootNode.querySelectorAll(spec.itemSelector)] : [];
      const itemBoxes = items.map((node) => node.getBoundingClientRect());
      // Which items are outside, not just how many: a count sends the reader
      // back to the browser to find out what the gate already knew.
      const outsideItems = items
        .map((node, index) => ({ node, box: itemBoxes[index] }))
        .filter(
          ({ box }) =>
            box.left < rootBox.left - 1 ||
            box.right > rootBox.right + 1 ||
            box.top < rootBox.top - 1 ||
            box.bottom > rootBox.bottom + 1,
        )
        .slice(0, 8)
        .map(
          ({ node, box }) =>
            `${node.tagName.toLowerCase()}.${String(node.className ?? "").split(" ").filter(Boolean).slice(0, 2).join(".")} @${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      const itemHeights = itemBoxes.map((box) => Math.round(box.height));

      const texts = spec.textSelector
        ? [...rootNode.querySelectorAll(spec.textSelector)].filter(
            // A control carries its text in a value, not in its content, so it
            // is not a label: it is measured through the items and the clip rule
            // instead of being counted here.
            (node) => !["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName),
          )
        : [];
      let clippedTexts = 0;
      let emptyTexts = 0;
      for (const node of texts) {
        const text = (node.textContent ?? "").trim();
        if (text.length === 0) {
          // Only a label is required to carry text. A button whose content is an
          // icon and a spacer span are legitimately empty, and calling them a
          // failure would make the check report a rule it does not have.
          if (node.tagName === "LABEL") emptyTexts += 1;
          continue;
        }
        if (clipped(node)) clippedTexts += 1;
      }

      return {
        missing: false,
        root: {
          width: Math.round(rootBox.width),
          height: Math.round(rootBox.height),
          // A surface may be taller than the viewport — a transcript scrolls with
          // its page — but it may not escape sideways, and it must be on screen.
          insideViewport:
            rootBox.left >= -1 &&
            rootBox.right <= window.innerWidth + 1 &&
            rootBox.bottom > 0 &&
            rootBox.top < window.innerHeight,
          insideContainer: containerBox
            ? intersection(rootBox, containerBox) >= 0.99 * rootBox.width * rootBox.height
            : true,
          clipped: clipped(rootNode),
        },
        items: {
          count: items.length,
          minHeight: itemHeights.length ? Math.min(...itemHeights) : 0,
          maxHeight: itemHeights.length ? Math.max(...itemHeights) : 0,
          zeroSized: itemBoxes.filter((box) => box.width <= 0 || box.height <= 0).length,
          outsideRootItems: outsideItems,
          outsideRoot: itemBoxes.filter(
            (box) =>
              box.left < rootBox.left - 1 ||
              box.right > rootBox.right + 1 ||
              box.top < rootBox.top - 1 ||
              box.bottom > rootBox.bottom + 1,
          ).length,
        },
        texts: {
          count: texts.length,
          clipped: clippedTexts,
          empty: emptyTexts,
        },
      };
    }, {
      itemSelector: state.items ?? surface.items ?? null,
      textSelector: state.texts ?? surface.texts ?? null,
      containerSelector: state.container ?? surface.container ?? null,
    });
}

/**
 * The measured facts for one state, with the checks that need no recording
 * applied first.
 *
 * `surface.root(page)` returns the locator of the surface container; a state may
 * override `items`, `texts` and `container` when it shows a different shape
 * from its siblings (an empty collection, for instance, has no rows).
 *
 * These are the assertions that hold of the surface itself: it exists, it is
 * sized, it is where its container says it is, nothing it shows is cut off, and
 * it renders as many items as the state asked for. A recorded comparison cannot
 * establish any of that for a surface that was already broken when it was
 * recorded.
 */
export async function captureSurface(page, surface, state) {
  const facts = await measure(page, surface, state);
  expect(facts.missing, `${surface.id}/${state.id}: the surface did not render (${surface.root})`).toBe(false);
  expect(facts.root.width, `${surface.id}/${state.id}: the surface has no width`).toBeGreaterThan(0);
  expect(facts.root.height, `${surface.id}/${state.id}: the surface has no height`).toBeGreaterThan(0);
  expect(facts.root.insideViewport, `${surface.id}/${state.id}: the surface leaves the viewport`).toBe(true);
  expect(facts.root.insideContainer, `${surface.id}/${state.id}: the surface leaves its container`).toBe(
    true,
  );
  expect(facts.root.clipped, `${surface.id}/${state.id}: the surface clips its own content`).toBe(false);
  expect(facts.items.zeroSized, `${surface.id}/${state.id}: an item rendered with no size`).toBe(0);
  expect(
    facts.items.outsideRoot,
    `${surface.id}/${state.id}: an item sits outside its surface — ${(facts.items.outsideRootItems ?? []).join(" | ")}`,
  ).toBe(0);
  // Text extent is recorded rather than required to be perfect on the first
  // recording: a rail row ellipsizes a long title by design, and treating the
  // design's own truncation as a defect at record time would leave no honest
  // baseline. What the recording catches is a *change* — one more clipped label
  // after a migration is a regression the comparison reports.
  if (typeof state.expectItems === "number") {
    expect(facts.items.count, `${surface.id}/${state.id}: the surface did not render every item`).toBe(
      state.expectItems,
    );
  }
  if (typeof state.expectTexts === "number") {
    expect(facts.texts.count, `${surface.id}/${state.id}: the surface did not render every label`).toBe(
      state.expectTexts,
    );
  }
  return facts;
}

/** Compare one recording with the one taken before the migration. */
export function compareWithRecorded(recorded, measured) {
  const differences = [];
  const walk = (before, after, prefix) => {
    if (before === after) return;
    if (typeof before === "object" && before !== null && typeof after === "object" && after !== null) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        walk(before[key], after[key], `${prefix}.${key}`);
      }
      return;
    }
    differences.push({ fact: prefix.replace(/^\./u, ""), before, after });
  };
  walk(recorded, measured, "");
  return differences;
}

/**
 * What the suite knows about one surface: which extremes are enumerated, which
 * are declared but missing, and which measured states matched the recording.
 *
 * The distinction the ADR asks for lives here: `unverified` is not a pass.
 */
export function summariseSurface(surface, verifiedStates) {
  const declared = surface.extremes ?? [];
  const covered = declared.filter((extreme) =>
    surface.states.some((state) => state.extreme === extreme && verifiedStates.has(state.id)),
  );
  return {
    surface: surface.id,
    declared,
    covered,
    missing: declared.filter((extreme) => !covered.includes(extreme)),
    verified: verifiedStates.size,
    unverified: declared.length !== covered.length,
  };
}
