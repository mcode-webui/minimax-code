// The shared select, mounted, and what happens to it when the world changes.
//
// The select's decisions are exercised without a document in the unit suite,
// but a decision is not a behaviour: what matters is what the mounted control
// does when the list it offers changes under it — when the hosts it names are
// gone, and when there is nothing left to name.
//
// The surface used here is a real one: the SSH project's host picker, whose
// options are the saved hosts. The list behind it is the fixture's, so a case
// can change the hosts while the picker is open, and the picker has to follow
// what is still there.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

/**
 * Where the evidence run writes its screenshots.
 *
 * The repository keeps no screenshots: the evidence belongs outside the
 * checkout, so the directory is named by the environment and the capture is
 * skipped when it is not set.
 */
const evidenceDir = process.env.WEBUI_AUDIT_EVIDENCE_DIR;

/** The saved hosts the fixture answers with. */
function hosts(aliases) {
  return aliases.map((alias) => ({
    alias,
    displayName: alias,
    endpoint: { kind: "manual", host: "127.0.0.1", port: 22 },
    enabled: true,
    status: "ready",
  }));
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  await page.addInitScript((value) => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listSshConnections", value.connections);
      window.__fixture.setResponse("listSshProjects", []);
    });
  }, { connections: hosts(["alpha", "beta"]) });
});

/** Opens the SSH tab of the connection settings. */
async function openSshSettings(page) {
  await openApp(page, "#session=A");
  await page.getByTestId("sidebar-user-menu-trigger").click();
  await page.getByTestId("user-menu-settings").click();
  await expect(page.locator('[role="dialog"][aria-label="设置"]')).toBeVisible();
  await page.locator('.webui-settings-nav [data-menu-key="connection"]').click();
  await page.getByTestId("connection-section-ssh").click();
  await expect(page.getByTestId("ssh-connections-section")).toBeVisible();
}

/** Opens the project form for a saved host: the picker under 「远程主机」. */
async function openProjectForm(page, alias) {
  await page.locator(`[data-webui-ssh-new-project="${alias}"]`).click();
  const dialog = page.getByTestId("ssh-create-project-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-webui-ssh-project-name="true"]').fill("远程项目");
  return dialog;
}

/** The host picker: a shared select menu under its field's label. */
const hostPicker = (page) => page.locator('[data-webui-ssh-project-host="true"]');

/** The popup. It is portalled to the document body, so the page addresses it. */
const hostOptions = (page) => page.getByRole("listbox");

/** What the trigger names, and whether it names anything. */
function namedOption(page) {
  return page.evaluate(() => {
    const trigger = document.querySelector('[data-webui-ssh-project-host="true"]');
    if (!(trigger instanceof HTMLElement)) throw new Error("the picker is not mounted");
    const id = trigger.getAttribute("aria-activedescendant");
    const option = id ? document.getElementById(id) : null;
    return {
      expanded: trigger.getAttribute("aria-expanded"),
      disabled: trigger.hasAttribute("disabled"),
      named: option ? { id, text: option.textContent } : null,
    };
  });
}

/**
 * Reloads the host list from the fixture, the way the panel does after a
 * change: the save is refused, so the form stays open, and the list behind
 * it is read again.
 */
async function reloadHosts(page, aliases) {
  await page.evaluate((value) => {
    window.__fixture.setResponse("listSshConnections", value);
    window.__fixture.setResponse("saveSshProject", { success: false, error: "没有权限保存项目。" });
  }, hosts(aliases));
  const dialog = page.getByTestId("ssh-create-project-dialog");
  // Submit through the native form event while the listbox is open. Clicking
  // the footer would also dismiss the listbox as an outside pointer action.
  await dialog.locator("form").evaluate((form) => form.requestSubmit());
  // The save failed, so the form is still open: the list behind it is what
  // changed, not the form.
  await expect(dialog).toBeVisible();
}

test("the picker follows the hosts that are still there", async ({ page }) => {
  await openSshSettings(page);
  await openProjectForm(page, "alpha");

  const trigger = hostPicker(page);
  await trigger.click();
  await expect(hostOptions(page)).toBeVisible();
  await expect(hostOptions(page).getByRole("option")).toHaveCount(2);

  // One of the hosts goes away while the picker is open.
  await reloadHosts(page, ["gamma"]);

  // The list is the hosts that are still there, and the picker names one of
  // them: an index left over from the longer list would name an option that
  // is not in the document.
  await expect(hostOptions(page).getByRole("option")).toHaveCount(1);
  const named = await namedOption(page);
  if (named.named) {
    expect(named.named.text).toContain("gamma");
  }
  await expect(trigger).toHaveText(/gamma/u);

  if (evidenceDir) {
    await page.screenshot({ path: `${evidenceDir}/select-hosts-changed.png` });
  }
});

test("a picker with no host left opens nothing and chooses nothing", async ({ page }) => {
  await openSshSettings(page);
  await openProjectForm(page, "alpha");

  const trigger = hostPicker(page);
  await trigger.click();
  await expect(hostOptions(page)).toBeVisible();

  // The last host goes away.
  await reloadHosts(page, []);

  // A picker with nothing to pick is disabled: it says so instead of opening
  // a list of nothing.
  await expect(trigger).toBeDisabled();
  await expect(hostOptions(page)).toHaveCount(0);
  const named = await namedOption(page);
  expect(named.named).toBeNull();
  expect(named.expanded).toBe("false");

  // And a press on it opens nothing: there is no list to open.
  await trigger.click({ force: true });
  await expect(hostOptions(page)).toHaveCount(0);

  if (evidenceDir) {
    await page.screenshot({ path: `${evidenceDir}/select-hosts-empty.png` });
  }
});
