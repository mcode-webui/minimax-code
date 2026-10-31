// The field contract in the provider form, measured in the browser (#288).
//
// The unit test next door proves the wiring from a rendered string; this proves
// the two things a string cannot: that each field's control is reachable by its
// own name, and that the focus ring is actually drawn when a keyboard user
// arrives. A field whose label is associated on paper but whose ring is invisible
// is worse than an unlabelled one — the user cannot see where they are.
//
// The error case is the third claim: a validation message the form computes
// itself reaches the control it belongs to, rather than sitting under the form.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

const FIELD_LABELS = ["提供商", "提供商名称", "API 格式", "接口地址", "API Key", "模型名称", "上下文窗口", "最大输出 Token"];

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  // Settings › Usage › 自定义模型: the page the provider form lives on.
  await openApp(page, "#session=A");
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();
  await expect(page.locator('[role="dialog"][aria-label="设置"]')).toBeVisible();
  await page.locator('.webui-settings-nav [data-menu-key="usage"]').click();
  await page.getByRole("button", { name: "自定义模型" }).click();
  await page.locator('[data-testid="settings-custom-models-panel"]').getByRole("button", { name: "添加模型" }).click();
  await expect(page.getByRole("dialog", { name: "添加模型" })).toBeVisible();
});

const form = (page) => page.getByRole("dialog", { name: "添加模型" });

test("every field names its own control", async ({ page }) => {
  // A control with no name is announced as "edit text"; one named by its field is
  // announced as what it is for.
  // The label carries the required marker, so the name is matched by its start.
  for (const label of ["接口地址", "API Key"]) {
    const control = form(page).getByLabel(new RegExp(`^${label}`, "u"));
    await expect(control, `a control named ${label}`).toHaveCount(1);
  }
  // The format picker is a button that opens a listbox, so its name comes from the
  // field's label and the value it shows.
  await expect(form(page).getByRole("button", { name: /API 格式/u })).toHaveCount(1);
});

test("the focus ring is visible on each field", async ({ page }) => {
  // Text inputs only: a text field is the control that matches `:focus-visible`
  // whenever it is focused, so the measurement is about the ring and not about
  // whether the browser decided a press was a keyboard press.
  // The contract's own fields: a checkbox in the footer is named by its wrapping
  // label and is not a field of this form, so it is not measured here.
  const controls = form(page).locator(".webui-field input");
  const count = await controls.count();
  // In this state the preset picker supplies the name and the form has no model
  // card yet, so two contract fields are rendered: the endpoint and the key.
  expect(count, "fields in the form").toBeGreaterThanOrEqual(2);

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    // A focus indicator is not necessarily an outline: these fields answer focus
    // by strengthening their border. What matters is that something the eye can
    // see changes between resting and focused.
    const read = () =>
      control.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          borderColor: style.borderColor,
          borderWidth: style.borderWidth,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          boxShadow: style.boxShadow,
          name: element.getAttribute("aria-labelledby") ?? element.id,
        };
      });
    const resting = await read();
    await control.focus();
    const focused = await read();
    const drawn =
      resting.borderColor !== focused.borderColor ||
      resting.borderWidth !== focused.borderWidth ||
      resting.outlineStyle !== focused.outlineStyle ||
      resting.outlineWidth !== focused.outlineWidth ||
      resting.boxShadow !== focused.boxShadow;
    expect(drawn, `a visible focus indicator on ${focused.name}`).toBe(true);
  }
});

test("a validation error reaches the control it belongs to", async ({ page }) => {
  const endpoint = form(page).getByLabel(/^接口地址/u);
  await endpoint.fill("not-a-url");

  const message = form(page).getByRole("alert");
  await expect(message).toHaveText(/http:\/\/ 或 https:\/\//u);
  await expect(endpoint).toHaveAttribute("aria-invalid", "true");

  // The control points at the message, so a reader that lands on the field hears
  // what is wrong with it without hunting through the dialog.
  const describedBy = (await endpoint.getAttribute("aria-describedby")) ?? "";
  const messageId = (await message.getAttribute("id")) ?? "";
  expect(messageId).toBeTruthy();
  expect(describedBy.split(" ")).toContain(messageId);

  // And it clears when the value becomes an endpoint again.
  await endpoint.fill("https://synthetic.example/v1");
  await expect(form(page).getByRole("alert")).toHaveCount(0);
  await expect(endpoint).not.toHaveAttribute("aria-invalid", "true");
});
