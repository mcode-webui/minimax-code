// Favourites, end to end against the built client.
//
// The unit suite (`rail-star-favorites.test.ts`) proves the markup carries the
// attributes and the tab/filter arithmetic. It cannot prove the three claims
// that only exist once CSS is applied and the pointer is somewhere specific:
//
//   1. The mark is *visible* and *yellow*. `renderToStaticMarkup` emits an
//      element inside a `display: none` subtree perfectly happily, and a
//      `data-webui-star-mark="true"` in the markup says nothing about the paint
//      colour. A star drawn in the meta's inherited tertiary grey is a star
//      nobody can pick out of a grey rail, and no attribute assertion notices.
//   2. The button's two states are two different *drawings*, not one drawing
//      with a different class. The outline and filled glyphs differ in `fill` and
//      in the presence of `stroke`.
//   3. The favourites tab is a real filter, not a fourth label on the same list.
//      A tab that renders the unchanged session list looks identical to a
//      working one until you count the rows.
//
// Star state lives in localStorage (`LeftRail.tsx`,
// WEBUI_SESSION_OVERLAY_KEYS.stars), the same overlay the app reads at boot, so
// each test seeds it before the app loads rather than clicking through. That is
// also the only way to reach the starred state: the harness transport is
// read-only, and clicking the button writes localStorage which does not
// round-trip back into a fresh render assertion.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

const SESSION_STARS = "mavis-webui-session-stars:v1";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

/** Seeds the favourites overlay before the app boots, the way a returning user has them. */
async function seedStars(page, sessions = {}) {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SESSION_STARS, JSON.stringify(sessions)],
  );
}

function sessionRow(page, sessionId) {
  return page.locator(`[data-webui-session-link="${sessionId}"]`);
}

/**
 * The row element, which holds both the link and the hover-only action strip.
 *
 * Not the link: `.webui-session-row-actions` is a *sibling* of the `<a>`, so
 * anything located under `[data-webui-session-link]` cannot see the star button
 * at all. `>` keeps this on the immediate row rather than any ancestor.
 */
function rowOf(page, sessionId) {
  return page.locator(`div:has(> [data-webui-session-link="${sessionId}"])`);
}

function starMark(page, sessionId) {
  return sessionRow(page, sessionId).locator('[data-webui-star-mark="true"]');
}

/**
 * The star button, found by the glyph it contains.
 *
 * Not by position: the strip holds pin, star, archive and more, and the star is
 * the second of those today. Locating by `:has(svg[data-webui-star])` means a
 * future action inserted before it cannot silently retarget this at the pin.
 */
function starButton(page, sessionId) {
  return rowOf(page, sessionId).locator(".webui-rail-action:has(svg[data-webui-star])");
}

async function starButtonState(page, sessionId) {
  return starButton(page, sessionId).locator("svg[data-webui-star]").getAttribute("data-webui-star");
}

async function starButtonLabel(page, sessionId) {
  return starButton(page, sessionId).getAttribute("aria-label");
}

function viewTab(page, view) {
  return page.locator(`[data-webui-rail-view="${view}"]`);
}

test("a starred row shows its star without being hovered", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  // No hover anywhere in this test, on purpose. That is the whole claim: the
  // mark is standing, not an affordance that appears when the pointer arrives.
  // Wrong when: the mark is emitted but hidden, or lives inside the hover-only
  // action strip, in which case the row claims nothing until you point at it.
  await expect(starMark(page, "A")).toBeVisible();
  await expect(starMark(page, "A").locator("svg")).toBeVisible();
});

test("the mark is still there while the row is hovered", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");
  await expect(starMark(page, "A")).toBeVisible();

  await rowOf(page, "A").hover();
  // The strip is `opacity: 0` until now. Asserting it is actually shown makes
  // the next line mean something: without this the hover could be a no-op and
  // the mark would pass for the wrong reason.
  await expect(rowOf(page, "A").locator(".webui-session-row-actions")).toHaveCSS("opacity", "1");

  // Wrong when: the mark was rendered inside that strip to begin with. It is
  // then a second hover affordance rather than a standing one.
  await expect(starMark(page, "A")).toBeVisible();
});

test("a row that is not starred shows no mark", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  // The other half. A rail that marks every row passes the test above.
  await expect(starMark(page, "A")).toBeVisible();
  await expect(starMark(page, "B")).toHaveCount(0);
});

test("the star button offers the filled glyph on a starred row", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  // Wrong when: the label says 取消收藏 and the drawing does not change, which is
  // the state this whole change started from.
  expect(await starButtonState(page, "A")).toBe("filled");
  expect(await starButtonLabel(page, "A")).toBe("取消收藏：绿川椒 Demo 订货小程序");
});

test("the star button offers the outline glyph on a row that is not starred", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  expect(await starButtonState(page, "B")).toBe("outline");
  expect(await starButtonLabel(page, "B")).toBe("收藏：灵动岛卡住问题");
});

test("the two glyphs are different drawings, not one drawing relabelled", async ({ page }) => {
  // Only A. Seeding B as well would make the outline half of this test assert
  // against a row that is legitimately filled, and it would pass or fail for a
  // reason that has nothing to do with the drawing.
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  await rowOf(page, "A").hover();
  const filled = await starButton(page, "A").locator("svg[data-webui-star] path").evaluate((node) => ({
    fill: node.getAttribute("fill"),
    stroke: node.getAttribute("stroke"),
  }));

  await rowOf(page, "B").hover();
  const outline = await starButton(page, "B").locator("svg[data-webui-star] path").evaluate((node) => ({
    fill: node.getAttribute("fill"),
    stroke: node.getAttribute("stroke"),
  }));

  // A filled star with no outline and an outlined star with no paint. If both
  // paths carried the same fill, the attribute assertions above would still
  // pass while the rail draws two identical glyphs that differ only by a
  // variable nobody can see.
  expect(filled).toEqual({ fill: "currentColor", stroke: null });
  expect(outline).toEqual({ fill: "none", stroke: "currentColor" });
});

test("a starred mark and a starred button are both actually yellow", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  // The claim no attribute can carry: the paint is the project's yellow token
  // and not the tertiary grey the session meta inherits. Read as a resolved
  // rgb() and compared against the token's own value, so a hardcoded hex that
  // merely looks yellow would still fail if the theme moved.
  const token = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(--text_status_banana)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  // A transparent/unresolved var() would collapse to the inherited colour and
  // make the comparison below pass for the wrong reason.
  expect(token).not.toBe("rgba(0, 0, 0, 0)");

  expect(await starMark(page, "A").evaluate((node) => getComputedStyle(node).color)).toBe(token);

  await rowOf(page, "A").hover();
  expect(await starButton(page, "A").evaluate((node) => getComputedStyle(node).color)).toBe(token);
});

test("a starred button stays yellow with the pointer resting on it", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  // The claim the stylesheet's own comment makes: the star "reads the same
  // whether the pointer is on it or not". Hovering the *row* is not the test of
  // that -- the earlier case passes while the button's own :hover rule silently
  // repaints the glyph in the tertiary grey, because `.webui-rail-action:hover`
  // and `.webui-rail-action:has([data-webui-star="filled"])` are both
  // (0,2,0) and the later one wins.
  //
  // Row first, then the button: the strip is `pointer-events: none` until the
  // row is hovered, so a direct hover on the button is intercepted by the
  // session link and times out rather than testing anything.
  await rowOf(page, "A").hover();
  await expect(rowOf(page, "A").locator(".webui-session-row-actions")).toHaveCSS("opacity", "1");
  await starButton(page, "A").hover();
  // Now the pointer really is on the button, which is the only state in which
  // the button's own :hover rule applies.
  await expect(starButton(page, "A").locator("svg[data-webui-star='filled']")).toHaveCount(1);

  const token = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(--text_status_banana)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(await starButton(page, "A").evaluate((node) => getComputedStyle(node).color)).toBe(token);
});

test("an unstarred button is not yellow", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  // The negative of the claim above, in the same render: a rule that coloured
  // every star button rather than only the filled one would satisfy the previous
  // test on a rail where "favourite" and "not yet a favourite" look identical.
  await rowOf(page, "B").hover();
  const color = await starButton(page, "B").evaluate((node) => getComputedStyle(node).color);
  const token = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(--text_status_banana)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(color).not.toBe(token);
});

test("all four view tabs render and none of them is disabled", async ({ page }) => {
  await openApp(page, "#session=A");

  for (const view of ["projects", "running", "unread", "stars"]) {
    await expect(viewTab(page, view)).toBeVisible();
    await expect(viewTab(page, view)).toBeEnabled();
  }
  // And the count is four, not "at least these four": a fifth tab that does
  // nothing would be the same operable-but-unbound shape the shell unit test
  // guards, and it would slip past a per-name loop.
  await expect(page.locator("[data-webui-rail-view]")).toHaveCount(4);
  await expect(viewTab(page, "projects")).toHaveAttribute("aria-selected", "true");
});

test("the favourites tab lists the starred sessions and nothing else", async ({ page }) => {
  await seedStars(page, { B: true });
  await openApp(page, "#session=A");

  // Before switching: B is on the rail, but as an ordinary row. Counting here
  // gives the switch something to change, so the assertion below cannot pass
  // against a tab that quietly renders the same list.
  await expect(sessionRow(page, "A")).toBeVisible();
  await expect(sessionRow(page, "B")).toBeVisible();

  await viewTab(page, "stars").click();
  await expect(viewTab(page, "stars")).toHaveAttribute("aria-selected", "true");

  await expect(sessionRow(page, "B")).toBeVisible();
  await expect(sessionRow(page, "A")).toHaveCount(0);
  // The count badge agrees with the rows, rather than being derived from the
  // storage map where a star on a session this page has not paged in would put
  // a number on a tab that no row accounts for.
  await expect(page.locator('[data-webui-rail-view-count="stars"]')).toHaveText("1");
});

test("the favourites tab keeps its standing marks", async ({ page }) => {
  await seedStars(page, { B: true });
  await openApp(page, "#session=A");
  await viewTab(page, "stars").click();

  // The mark is not redundant here: the favourites view is a flat list, so it
  // is the only thing telling the reader that this row is one of the favourites
  // rather than merely the row the list happens to contain.
  await expect(starMark(page, "B")).toBeVisible();
});

test("an empty favourites view says so instead of showing everything", async ({ page }) => {
  await openApp(page, "#session=A");
  await viewTab(page, "stars").click();

  // The failure this catches: a filter that ignores `starred` and falls through
  // to "no filter", which shows the full list and reads as a working tab right
  // up until the user stars nothing and wonders why their rail came back.
  await expect(page.getByText("没有收藏的会话")).toBeVisible();
  await expect(sessionRow(page, "A")).toHaveCount(0);
});

test("switching back to projects restores the full list", async ({ page }) => {
  await seedStars(page, { B: true });
  await openApp(page, "#session=A");

  await viewTab(page, "stars").click();
  await expect(sessionRow(page, "A")).toHaveCount(0);

  await viewTab(page, "projects").click();
  // The views are filters over one list, not separate lists that consumed each
  // other. A tab that cleared the page on the way out would leave an empty rail.
  await expect(sessionRow(page, "A")).toBeVisible();
  await expect(sessionRow(page, "B")).toBeVisible();
});

test("a star on a session this page has not paged in does not inflate the count", async ({ page }) => {
  // C is a child of A: it exists in the session tree but is not one of the page's
  // sessions, so a star on it is a real, stored favourite with no row behind it.
  await seedStars(page, { C: true });
  await openApp(page, "#session=A");

  await viewTab(page, "stars").click();

  // Derived from the page, not from the storage map. Counting the map would put
  // a "1" on a tab whose only body is the empty state, which is the same
  // number-claims-a-row-that-is-not-there bug the other two views already avoid.
  await expect(page.locator('[data-webui-rail-view-count="stars"]')).toHaveText("0");
  await expect(page.getByText("没有收藏的会话")).toBeVisible();

  // And the favourite is not silently dropped either: expand the parent and the
  // starred child is there, still carrying its mark.
  await viewTab(page, "projects").click();
  await page.locator(".webui-session-disclosure").first().click();
  await expect(sessionRow(page, "C")).toBeVisible();
  await expect(starMark(page, "C")).toBeVisible();
});

test("a starred child row shows its mark once the parent is expanded", async ({ page }) => {
  await seedStars(page, { C: true });
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
  await expect(starMark(page, "C")).toBeVisible();
  // The parent's own state is untouched by the child's.
  await expect(starMark(page, "A")).toHaveCount(0);

  // ⚠️ Read this before adding star to a child row's context menu.
  //
  // `filterWebuiRailViewSessions` filters `page.sessions`, and a child is not
  // in `page.sessions` -- it only ever appears in the tree. So the moment
  // `openSessionMenu`'s `isChild` branch grows a star item, a starred child
  // becomes unreachable in TWO ways at once: it still cannot be starred (no
  // menu item today), and if it were, it would carry a mark, sit in localStorage
  // and still never appear in 收藏 or count toward its badge.
  //
  // The fixture is already staged for exactly that: C is deliberately outside
  // `sessions`, so the test above can star it and the count test can prove the
  // badge reads 0. Whoever wires child starring has to decide whether the
  // favourites view also walks the tree, and that decision belongs with the
  // feature, not with this spec.
});

test("the context menu offers unstar on a starred row", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  // The menu is the reachable path for a user who cannot hover the row strip --
  // keyboard, or a pointer parked elsewhere. It has to exist and carry the same
  // two labels as the button, or the affordance is hover-only after all.
  //
  // Right-click the link, not the row: the `onContextMenu` handler is on the
  // `<a>`, so a right-click aimed at the row's padding opens nothing and this
  // would fail for a reason that has nothing to do with favourites.
  //
  // Aimed at the label rather than the link's centre: the hover action strip is
  // `position: absolute` over the row's right-hand end and, at `opacity: 0`,
  // still takes the hit. Clicking dead centre lands on the star button and
  // Playwright refuses the click as intercepted.
  await sessionRow(page, "A").click({ button: "right", position: { x: 40, y: 16 } });
  await expect(page.locator('[data-webui-context-menu="true"]')).toBeVisible();
  // By class, not by role: the menu items are plain buttons inside a `role="menu"`
  // container, so `getByRole("menuitem")` matches nothing here.
  const item = page.locator(".webui-context-menu-item", { hasText: /^(收藏|取消收藏)$/u });
  await expect(item).toHaveCount(1);
  await expect(item).toBeEnabled();
  expect(await item.textContent()).toBe("取消收藏");
});

test("the context menu offers star on a row that is not starred", async ({ page }) => {
  await seedStars(page, { A: true });
  await openApp(page, "#session=A");

  // The other half of the pair. A menu that only ever said 取消收藏 would pass
  // the test above on a rail where starring through the menu is impossible.
  await sessionRow(page, "B").click({ button: "right", position: { x: 40, y: 16 } });
  const item = page.locator(".webui-context-menu-item", { hasText: /^(收藏|取消收藏)$/u });
  await expect(item).toHaveCount(1);
  await expect(item).toBeEnabled();
  expect(await item.textContent()).toBe("收藏");
});
