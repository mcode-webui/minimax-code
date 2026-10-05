// Rail search, end to end against the built client.
//
// The unit suite already defines what a query matches
// (`session-rail-search.test.ts`: label substring, case-insensitive, falling
// back to the agent name only when there is no title, then the workspace
// directory, then the id). What it cannot show is that the rail *uses* that
// function -- `WebuiProjectList` takes the query as a prop, and a prop that is
// passed and then ignored leaves every unit test green.
//
// So this file re-states the same contract as observable DOM, and each test
// names the way it is wrong.
//
// The fixture had to grow a project record first, which is the gap the review
// found rather than a failure. `WebuiProjectList` builds its rows from
// `listVisibleProjects`, not from the session list: with an empty answer there
// is no project row, no session row, and no search box, so the feature was
// unreachable in a browser. `[]` is a valid server answer and a useless
// fixture.
//
// The search box is also behind a toggle rather than always visible, so every
// test opens it the way a user does. Writing to a hidden input would test a
// state the app cannot reach.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

function searchBox(page) {
  return page.locator('[data-webui-rail-search-input="true"]');
}

function sessionRow(page, sessionId) {
  return page.locator(`[data-webui-session-link="${sessionId}"]`);
}

function projectRow(page) {
  return page.locator('[data-webui-project-link="/synthetic/workspace"]');
}

/** The session ids currently rendered in the rail, in DOM order. */
async function visibleSessionIds(page) {
  return page.locator("[data-webui-session-link]").evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-webui-session-link")),
  );
}

async function search(page, query) {
  // Deliberately not `fill` on a hidden input: the user has to open the box
  // first, and a spec that skips that step is testing a state the UI cannot
  // reach.
  await page.locator('[data-webui-search="true"]').click();
  await searchBox(page).fill(query);
}

test("the rail renders its sessions under a project", async ({ page }) => {
  await openApp(page, "#session=A");

  // Wrong when: `listVisibleProjects` answers `[]` and the rail renders nothing
  // at all -- which is exactly how this fixture was written until now, and why
  // the review found a gap here instead of a failure. This assertion is the one
  // that would have caught it.
  await expect(projectRow(page)).toBeVisible();
  await expect(sessionRow(page, "A")).toBeVisible();
  await expect(sessionRow(page, "B")).toBeVisible();
});

test("the rail orders sessions newest first", async ({ page }) => {
  await openApp(page, "#session=A");

  // B carries the later `updatedAt` in the fixture. The order is asserted, not
  // just the membership, because a rail that renders both rows in any order
  // would satisfy a set comparison and quietly stop being predictable to look
  // at. (The view-sorting unit test already fell into a version of this: a
  // fixture whose two timestamps moved together made every ordering pass.)
  expect(await visibleSessionIds(page)).toEqual(["B", "A"]);
});

test("a title substring narrows the rail to the one session", async ({ page }) => {
  await openApp(page, "#session=A");
  await search(page, "绿川椒");

  // Wrong when: the rail keeps both rows, which is what a passed-but-ignored
  // query prop looks like from outside.
  await expect(sessionRow(page, "A")).toBeVisible();
  await expect(sessionRow(page, "B")).toHaveCount(0);
  expect(await visibleSessionIds(page)).toEqual(["A"]);
});

test("the query ignores case", async ({ page }) => {
  await openApp(page, "#session=A");
  // "Demo" is inside A's title; searching it upper-case exercises the
  // lower-casing on the *title* path. Searching the agent name instead would
  // not: `sessionLabel` prefers the title, so the agent name is only consulted
  // when there is no title, and the assertion would be wrong about what the
  // contract is.
  await search(page, "DEMO");

  await expect(sessionRow(page, "A")).toBeVisible();
  await expect(sessionRow(page, "B")).toHaveCount(0);
});

test("a query matching nothing leaves no rows behind", async ({ page }) => {
  await openApp(page, "#session=A");
  await search(page, "不存在的会话名");

  // Wrong when: stale rows stay on screen, which reads as "the search found
  // something" rather than "the search found nothing".
  expect(await visibleSessionIds(page)).toEqual([]);
  // And the project row goes with them. `filterWebuiProjectsByQuery` keeps a
  // project only while it holds a matching session or the query names the row
  // itself; without that pairing the rail fills with empty project rows that
  // look like unfiltered results.
  await expect(projectRow(page)).toHaveCount(0);
});

test("clearing the query brings every row back", async ({ page }) => {
  await openApp(page, "#session=A");
  await search(page, "绿川椒");
  await expect(sessionRow(page, "B")).toHaveCount(0);

  await searchBox(page).fill("");

  // Wrong when: a filter that only ever narrows turns the rail into a one-way
  // door and the user has to reload to see their other sessions.
  await expect(sessionRow(page, "A")).toBeVisible();
  await expect(sessionRow(page, "B")).toBeVisible();
  await expect(projectRow(page)).toBeVisible();
});

test("a workspace path finds every session in that workspace", async ({ page }) => {
  await openApp(page, "#session=A");
  // Both fixture sessions live in one workspace, so the path matches both --
  // and the project row survives on the name/path clause rather than on
  // sessions, which is the branch `matchesWebuiProjectQuery` exists for.
  await search(page, "synthetic/workspace");

  await expect(sessionRow(page, "A")).toBeVisible();
  await expect(sessionRow(page, "B")).toBeVisible();
  await expect(projectRow(page)).toBeVisible();
});
