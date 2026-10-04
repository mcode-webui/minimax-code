// Pin affordance, end to end against the built client.
//
// The unit suite (`rail-pin-affordance.test.ts`) proves the markup carries the
// two things a pinned row has to say. It cannot prove either of the claims that
// only exist once CSS is applied:
//
//   1. The mark is *visible*. `renderToStaticMarkup` happily emits an element
//      inside a `display: none` subtree, so "the attribute is in the markup"
//      and "the user can see the pin" are different statements. Playwright's
//      visibility check is the one that distinguishes them.
//   2. The pin glyph actually renders as the slashed variant. The two states
//      are two different 20x20 path strings; a clip path that resolves against
//      the wrong element, or an id collision between two pinned rows, clips
//      the slash away and leaves a plain pin on screen.
//
// Pin state lives in localStorage (`LeftRail.tsx`, the same overlay keys the
// app reads at boot), so each test seeds it before the app loads rather than
// clicking through the menu. Seeding is the only way to reach the pinned state
// in a fixture whose transport is read-only.

import { expect, test } from "@playwright/test";

import { assertHarnessServer, openApp } from "./harness.mjs";

const SESSION_PINS = "mavis-webui-session-pins:v1";
const PROJECT_PINS = "mavis-webui-project-pins:v1";
const WORKSPACE = "/synthetic/workspace";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

/** Seeds the pin overlays before the app boots, the way a returning user has them. */
async function seedPins(page, { sessions = {}, projects = {} } = {}) {
  await page.addInitScript(
    ([sessionKey, sessionValue, projectKey, projectValue]) => {
      window.localStorage.setItem(sessionKey, sessionValue);
      window.localStorage.setItem(projectKey, projectValue);
    },
    [SESSION_PINS, JSON.stringify(sessions), PROJECT_PINS, JSON.stringify(projects)],
  );
}

function sessionRow(page, sessionId) {
  return page.locator(`[data-webui-session-link="${sessionId}"]`);
}

/**
 * The row element, which holds both the link and the hover-only action strip.
 *
 * Not the link: `.webui-session-row-actions` is a *sibling* of the `<a>`, so
 * anything located under `[data-webui-session-link]` cannot see the pin button
 * at all. `>` keeps this on the immediate row rather than any ancestor.
 */
function rowOf(page, sessionId) {
  return page.locator(`div:has(> [data-webui-session-link="${sessionId}"])`);
}

function pinMark(page, sessionId) {
  return sessionRow(page, sessionId).locator('[data-webui-pin-mark="true"]');
}

/**
 * The state of the pin glyph in a row's action button, read from the clip path
 * the glyph actually references.
 *
 * Off the `<g clip-path>` reference rather than off a `clipPath` type selector:
 * the question is whether the slash's clip resolves to *this* row's own path
 * definition, and the reference is what the browser resolves.
 */
async function pinGlyphState(page, sessionId) {
  const url = await rowOf(page, sessionId)
    .locator(".webui-rail-action g[clip-path]")
    .first()
    .getAttribute("clip-path");
  const id = url?.match(/#(.+)\)/u)?.[1] ?? "";
  return id.includes("unpinned") ? "unpinned" : id.includes("pinned") ? "pinned" : "none";
}

async function pinButtonLabel(page, sessionId) {
  return rowOf(page, sessionId).locator(".webui-rail-action").first().getAttribute("aria-label");
}

test("the mark is still there while the row is hovered", async ({ page }) => {
  await seedPins(page, { sessions: { A: true } });
  await openApp(page, "#session=A");
  await expect(pinMark(page, "A")).toBeVisible();

  await rowOf(page, "A").hover();
  // The strip is `opacity: 0` until now, and `position: absolute` over the
  // row's right-hand end. Asserting it is actually shown makes the next line
  // mean something: without this, the hover could be a no-op and the mark
  // would pass for the wrong reason.
  await expect(rowOf(page, "A").locator(".webui-session-row-actions")).toHaveCSS("opacity", "1");

  // Wrong when: the mark was rendered inside that strip to begin with. It is
  // then a second hover affordance, not a standing one -- the row says nothing
  // until the pointer arrives, which is the state this change started from.
  await expect(pinMark(page, "A")).toBeVisible();
});

test("a pinned row shows its pin without being hovered", async ({ page }) => {
  await seedPins(page, { sessions: { A: true } });
  await openApp(page, "#session=A");
  await assertHarnessServer(page);

  // No hover anywhere in this test, on purpose. That is the whole claim: the
  // mark is standing, not an affordance that appears when the pointer arrives.
  // Wrong when: the mark is emitted but hidden, or lives inside the hover-only
  // action strip, in which case the row claims nothing until you point at it.
  await expect(pinMark(page, "A")).toBeVisible();
  await expect(pinMark(page, "A").locator("svg")).toBeVisible();
});

test("a row that is not pinned shows no mark", async ({ page }) => {
  await seedPins(page, { sessions: { A: true } });
  await openApp(page, "#session=A");

  // The other half. A rail that marks every row passes the test above.
  await expect(pinMark(page, "A")).toBeVisible();
  await expect(pinMark(page, "B")).toHaveCount(0);
});

test("the pin button offers the unpin glyph on a pinned row", async ({ page }) => {
  await seedPins(page, { sessions: { A: true } });
  await openApp(page, "#session=A");

  // Wrong when: the label says 取消置顶 and the drawing does not change, which
  // is the state this whole change started from.
  expect(await pinGlyphState(page, "A")).toBe("pinned");
  expect(await pinButtonLabel(page, "A")).toBe("取消置顶：绿川椒 Demo 订货小程序");
});

test("the pin button offers the pin glyph on a row that is not pinned", async ({ page }) => {
  await seedPins(page, { sessions: { A: true } });
  await openApp(page, "#session=A");

  expect(await pinGlyphState(page, "B")).toBe("unpinned");
  expect(await pinButtonLabel(page, "B")).toBe("置顶：灵动岛卡住问题");
});

test("two pinned rows each get their own clip path", async ({ page }) => {
  // A and the child C. A shared clipPath id would make the second row's slash
  // clip against the first row's element -- visually identical here because the
  // two definitions match, which is exactly why it needs asserting on ids.
  await seedPins(page, { sessions: { A: true, B: true } });
  await openApp(page, "#session=A");

  // `url(#...)` reduced to the bare id on both sides: the attribute carries the
  // function wrapper, the definition does not.
  const ids = await page
    .locator(".webui-rail-action g[clip-path]")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.getAttribute("clip-path") ?? "").replace(/^url\(#(.*)\)$/u, "$1")),
    );
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  // And each reference resolves to a path definition that actually exists in
  // the document. Two identical ids would satisfy the uniqueness check above
  // while both glyphs clip against the first row's element.
  const defined = await page.evaluate(() =>
    [...document.querySelectorAll("clipPath")].map((node) => node.id),
  );
  for (const id of ids) {
    expect(defined, `no clipPath defines ${id}`).toContain(id);
  }
});

test("a pinned project shows its pin next to the folder", async ({ page }) => {
  await seedPins(page, { projects: { [WORKSPACE]: true } });
  await openApp(page, "#session=A");

  const projectRow = page.locator(`[data-webui-project-link="${WORKSPACE}"]`);
  await expect(projectRow.locator('[data-webui-project-pin-mark="true"]')).toBeVisible();
  // And the negative, in the same render: a project mark that ignores its flag
  // would pass the assertion above on a rail that draws one unconditionally.
  await expect(
    page.locator('[data-webui-project-pin-mark="true"]'),
  ).toHaveCount(1);
});

test("a pinned child row shows its mark once the parent is expanded", async ({ page }) => {
  await seedPins(page, { sessions: { C: true } });
  await openApp(page, "#session=A");

  // Closed first: the child row does not exist yet, so a mark assertion before
  // the click would be asserting on an absent element.
  await expect(sessionRow(page, "C")).toHaveCount(0);

  await page.locator(".webui-session-disclosure").first().click();

  // This is the row shape the unit suite cannot reach. Child rows render only
  // when `childrenExpanded` is set, and that is internal `useState` with no
  // prop -- a node-environment `renderToStaticMarkup` has no way to open. So the
  // unit test asserts the call site in the source and this one opens it for
  // real.
  await expect(sessionRow(page, "C")).toBeVisible();
  await expect(pinMark(page, "C")).toBeVisible();
  // The parent's own state is untouched by the child's.
  await expect(pinMark(page, "A")).toHaveCount(0);
});
