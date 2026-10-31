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

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

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

/**
 * The right inset of a computed `inset()` clip, in pixels.
 *
 * A clip of `inset(0px 88px 0px 0px)` hides the rightmost 88px of the
 * element, so the element's visible right edge sits that far in from its
 * layout box. Zero when the element is not clipped.
 */
function clipRightInset(clipPath) {
  const match = /^inset\((.*)\)$/u.exec(String(clipPath).trim());
  if (!match) return 0;
  const parts = match[1].split(/\s+/u);
  if (parts.length < 2) return 0;
  return Number.parseFloat(parts[1]) || 0;
}

/**
 * The state of the pin glyph in a row's action button, read from the glyph's
 * own class.
 *
 * The filled pin is the pinned state and the outline the unpinned one, and
 * the class is what says which: the hand-drawn glyph said it through the id
 * of the clip path it carried, and the tabler glyph says it through its
 * class.
 */
async function pinGlyphState(page, sessionId) {
  const className = await rowOf(page, sessionId)
    .locator('[data-webui-rail-action="pin"] svg')
    .first()
    .getAttribute("class");
  if (!className) return "none";
  if (className.includes("tabler-icon-pin-filled")) return "pinned";
  return className.includes("tabler-icon-pin") ? "unpinned" : "none";
}

async function pinButtonLabel(page, sessionId) {
  return rowOf(page, sessionId).locator('[data-webui-rail-action="pin"]').first().getAttribute("aria-label");
}

test("a pinned session row has one pin action and no duplicate pin marker", async ({ page }) => {
  await seedPins(page, { sessions: { A: true } });
  await openApp(page, "#session=A");

  const row = rowOf(page, "A");
  await row.hover();
  await expect(row.locator('[data-webui-pin-mark="true"]')).toHaveCount(0);
  await expect(row.locator('[data-webui-rail-action="pin"][aria-label^="取消置顶"]')).toHaveCount(1);
});

test("a running session title keeps its space before hover actions", async ({ page }) => {
  await openApp(page, "#session=A");
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "watchEvents",
  ))).toBe(true);
  await page.evaluate(() => window.__fixture.emitEvent({
    type: "session.start",
    payload: { sessionId: "A", turnId: "rail-hover-layout" },
    timestamp: 1_700_000_000_300,
    source: "synthetic",
  }));

  const row = rowOf(page, "A");
  const metadata = row.locator(".webui-rail-session-meta");
  const label = row.locator(".webui-project-session-card > span:first-child");
  const actions = row.locator(".webui-session-row-actions");
  await expect(metadata.locator(".webui-rail-spinner")).toBeVisible();
  const before = await metadata.boundingBox();
  const labelBeforeHover = await label.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { clipPath: style.clipPath, boundsRight: bounds.right };
  });
  const metadataBeforeHover = await metadata.boundingBox();
  await row.hover();
  await page.waitForTimeout(150);
  const after = await metadata.boundingBox();
  const labelLayout = await label.evaluate((element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      clipPath: style.clipPath,
      boundsRight: bounds.right,
      transitionProperty: style.transitionProperty,
      transitionDuration: style.transitionDuration,
    };
  });
  const actionsBounds = await actions.boundingBox();
  const metaDisplay = await metadata.evaluate((element) => getComputedStyle(element).display);
  const actionStyle = await actions.evaluate((element) => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, transitionProperty: style.transitionProperty };
  });

  expect(before).not.toBeNull();
  expect(after).toBeNull();
  // The space for the hover actions is kept by clipping the title's first
  // span, not by padding it: the span is clipped from the right on hover, so
  // the title's visible edge stops short of the actions. Clipping rather than
  // padding keeps the row's own layout from moving while it answers a hover.
  const clipBefore = clipRightInset(labelBeforeHover.clipPath);
  const clipAfter = clipRightInset(labelLayout.clipPath);
  const contentRightBefore = labelBeforeHover.boundsRight - clipBefore;
  const contentRightAfter = labelLayout.boundsRight - clipAfter;
  expect(clipBefore).toBe(0);
  expect(contentRightBefore).toBeLessThanOrEqual(metadataBeforeHover.x);
  expect(clipAfter).toBe(88);
  expect(contentRightAfter).toBeLessThanOrEqual(actionsBounds.x);
  expect(actionsBounds.x - contentRightAfter).toBeLessThanOrEqual(8);
  expect(labelLayout.transitionProperty).toContain("clip-path");
  expect(metaDisplay).toBe("none");
  expect(actionStyle.opacity).toBe("1");
  expect(actionStyle.transitionProperty).toContain("opacity");
});

test("the pin button offers the unpin glyph on a pinned row", async ({ page }) => {
  await seedPins(page, { sessions: { A: true } });
  await openApp(page, "#session=A");

  // Wrong when: the label says 取消置顶 and the drawing does not change, which
  // is the state this whole change started from.
  expect(await pinGlyphState(page, "A")).toBe("pinned");
  expect(await pinButtonLabel(page, "A")).toBe("取消置顶：Synthetic session A");
});

test("the pin button offers the pin glyph on a row that is not pinned", async ({ page }) => {
  await seedPins(page, { sessions: { A: true } });
  await openApp(page, "#session=A");

  expect(await pinGlyphState(page, "B")).toBe("unpinned");
  expect(await pinButtonLabel(page, "B")).toBe("置顶：Synthetic session B");
});

test("two pinned rows each draw their own pin glyph", async ({ page }) => {
  // A and the child C. A shared clipPath id would make the second row's slash
  // clip against the first row's element -- visually identical here because the
  // two definitions match, which is exactly why it needs asserting on ids. The
  // tabler glyph carries no such id, so the rule that is left is the one that
  // still holds: each row has an element of its own.
  await seedPins(page, { sessions: { A: true, B: true } });
  await openApp(page, "#session=A");

  const glyphs = page.locator('[data-webui-rail-action="pin"] svg[class*="tabler-icon-pin"]');
  await expect(glyphs).toHaveCount(2);
  // Two separate elements, not one element counted twice.
  expect(await glyphs.evaluateAll((nodes) => new Set(nodes).size)).toBe(2);
});

test("a pinned project row keeps the folder icon without an extra pin glyph", async ({ page }) => {
  await seedPins(page, { projects: { [WORKSPACE]: true } });
  await openApp(page, "#session=A");

  const projectRow = page.locator(`[data-webui-project-link="${WORKSPACE}"]`);
  await expect(projectRow.locator("svg").first()).toBeVisible();
  await expect(projectRow.locator('[data-webui-project-pin-mark="true"]')).toHaveCount(0);
});

test("section chevrons follow their labels and project folders match pinned session icon size and color", async ({ page }) => {
  await seedPins(page, { sessions: { A: true } });
  await openApp(page, "#session=A");

  const headers = page.locator('[data-webui-rail-section-header="true"]');
  await expect(headers).toHaveCount(2);
  for (const header of await headers.all()) {
    const alignment = await header.evaluate((element) => {
      const label = element.querySelector("span").getBoundingClientRect();
      const icon = element.querySelector("svg").getBoundingClientRect();
      return {
        gap: Math.round(icon.left - label.right),
        marginLeft: getComputedStyle(element.querySelector("svg")).marginLeft,
      };
    });
    expect(alignment.gap).toBe(8);
    expect(alignment.marginLeft).toBe("0px");
  }

  const iconStyles = await page.evaluate(() => {
    const pinned = document.querySelector(".webui-pinned-session-card > svg");
    const folder = document.querySelector(".webui-project-card > .webui-project-folder-icon");
    const pinnedStyle = getComputedStyle(pinned);
    const folderStyle = getComputedStyle(folder);
    return {
      pinnedSize: [pinnedStyle.width, pinnedStyle.height],
      folderSize: [folderStyle.width, folderStyle.height],
      pinnedColor: pinnedStyle.color,
      folderColor: folderStyle.color,
    };
  });
  expect(iconStyles.folderSize).toEqual(iconStyles.pinnedSize);
  expect(iconStyles.folderColor).toBe(iconStyles.pinnedColor);
});

test("repeatedly collapsing the pinned section keeps the session page mounted", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const pinnedProjects = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`/synthetic/project-${index}`, true]),
  );
  await seedPins(page, { sessions: { A: true }, projects: pinnedProjects });
  await configureFixture(page, () => {
    window.__fixture.setProjects([
      {
        projectId: 1,
        projectKind: "workspace",
        workspaceDir: "/synthetic/workspace",
        pinned: false,
        hidden: false,
        orderIndex: 0,
        recentAtMs: 1_700_000_000_001,
        latestActivityAtMs: 1_700_000_000_001,
        sessionCount: 2,
      },
      ...Array.from({ length: 80 }, (_, index) => ({
        projectId: index + 2,
        projectKind: "workspace",
        workspaceDir: `/synthetic/project-${index}`,
        pinned: false,
        hidden: false,
        orderIndex: index + 1,
        recentAtMs: 1_700_000_000_000 - index,
        latestActivityAtMs: 1_700_000_000_000 - index,
        sessionCount: 0,
      })),
    ]);
  });
  await openApp(page, "#session=A");

  const pinnedHeader = page.locator('[data-webui-rail-section-id="pinned"]');
  for (let index = 0; index < 20; index += 1) {
    await pinnedHeader.click();
  }

  await expect(page.locator('[data-webui-session-link="A"]')).toBeVisible();
  await expect(page.getByPlaceholder("输入消息…（输入 / 唤起命令）")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("a child row becomes visible once its parent is expanded", async ({ page }) => {
  await openApp(page, "#session=A");

  // Closed first: the child row stays mounted for its collapse transition but
  // is hidden and inert until its parent is expanded.
  await expect(sessionRow(page, "C")).toBeHidden();

  await page.locator(".webui-session-disclosure").first().click();

  // This is the row shape the unit suite cannot reach. `childrenExpanded` is
  // internal `useState` with no prop, so this opens it through the real control.
  await expect(sessionRow(page, "C")).toBeVisible();
});

test("left rail expanders share the pinned animation and parent rows keep their filled disclosure", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openApp(page, "#session=A");

  const pinnedContent = page.locator('[data-webui-pinned-section="true"]').locator("xpath=..");
  const projectContent = page.locator('[data-webui-project-sessions="/synthetic/workspace"]').locator("xpath=..");
  const childDisclosure = page.locator(".webui-session-disclosure").first();
  const childContent = page.locator('[data-webui-project-child-sessions="A"]').locator("xpath=..");

  const pinnedTransition = await pinnedContent.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.transitionProperty, style.transitionDuration, style.transitionTimingFunction];
  });
  const projectTransition = await projectContent.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.transitionProperty, style.transitionDuration, style.transitionTimingFunction];
  });
  expect(projectTransition).toEqual(pinnedTransition);
  expect(await childContent.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.transitionProperty, style.transitionDuration, style.transitionTimingFunction];
  })).toEqual(pinnedTransition);

  // The parent row's disclosure is the filled caret; the project row's is the
  // outline chevron. The hand-drawn glyph said so through the path it drew,
  // and the tabler glyph says it through its class and its fill.
  const disclosure = childDisclosure.locator("svg").first();
  expect(await disclosure.getAttribute("class")).toContain("tabler-icon-caret-right-filled");
  expect(await disclosure.getAttribute("fill")).toBe("currentColor");

  await childDisclosure.click();
  await expect(childContent).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator('[data-webui-session-link="C"]')).toBeVisible();

  await childDisclosure.click();
  await expect(childContent).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator('[data-webui-session-link="C"]')).toBeHidden();
});

test("projects show six rows initially and reveal the next batch with 更多", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setProjects(Array.from({ length: 8 }, (_, index) => ({
      projectId: index + 1,
      projectKind: "workspace",
      workspaceDir: `/synthetic/project-${index}`,
      pinned: false,
      hidden: false,
      orderIndex: index,
      recentAtMs: 1_700_000_000_000 - index,
      latestActivityAtMs: 1_700_000_000_000 - index,
      sessionCount: 0,
    })));
  });
  await openApp(page, "#session=A");

  const projectRows = page.locator('[data-webui-projects-section] [data-webui-project-link]');
  await expect(projectRows).toHaveCount(6);
  const more = page.locator('[data-webui-projects-section]').getByRole("button", { name: "显示更多项目" });
  await expect(more).toHaveText("更多");
  await more.click();
  await expect(projectRows).toHaveCount(8);
  await expect(more).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});
