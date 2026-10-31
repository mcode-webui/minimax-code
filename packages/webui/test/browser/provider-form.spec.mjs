// Settings › 用量 › 自定义模型 — the provider form against the built client.
//
// The plan's P05 exit asks for browser evidence of this surface, and until now nothing
// covered it: the unit suite pins the editor's policy and the panel's wiring at the source
// level, and neither can show what a user sees. What only a browser can answer is here — that
// the discovery control renders at all (it never did before D04, because it read a field the
// read does not send), that a saved provider's header row starts blank over its persisted
// name, and that the form's controls drive the same requests the editor's unit tests assert on.
//
// Every answer is the fixture's, so nothing here claims anything about a real runtime: the
// candidate operations are asserted through the recorded requests, which is also why the
// fixture never mutates its provider list on a write — the workflow reloads the truth after
// one, and a fixture list that pretended otherwise would be asserting a server the client
// cannot have.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

// Injected into the page, so its literals must be self-contained: it cannot close over
// anything in this module.
function seedProviderSurface() {
  window.__fixture.setModelProviders([
    {
      providerId: "provider-synthetic",
      name: "Synthetic Provider",
      source: "user",
      kind: "apiKey",
      enabled: true,
      baseUrl: "https://synthetic.example/v1",
      apiFormat: "openai-completions",
      hasApiKey: true,
      maskedApiKey: "sk-synthetic-0000",
      headerNames: ["X-Api-Key"],
      configRevision: "rev-1",
      models: [{ modelId: "gpt-x", displayName: "GPT X", enabled: true }],
    },
  ]);
  window.__fixture.setProviderPresets([
    {
      providerId: "preset-openai",
      name: "OpenAI 兼容",
      baseUrl: "https://api.openai.example/v1",
      apiFormat: "openai-completions",
    },
  ]);
}

function seedNewProviderSurface() {
  window.__fixture.setModelProviders([]);
  window.__fixture.setProviderPresets([
    {
      providerId: "preset-openai",
      name: "OpenAI 兼容",
      baseUrl: "https://api.openai.example/v1",
      apiFormat: "openai-completions",
    },
  ]);
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

const settingsDialog = (page) => page.locator('[role="dialog"][aria-label="设置"]');
const customPanel = (page) => page.locator('[data-testid="settings-custom-models-panel"]');
const formDialog = (page) => page.getByRole("dialog", { name: /^(添加模型|编辑提供商)$/u });

/** Opens settings the way a user does, then the Usage page's custom-model tab. */
async function openCustomModels(page) {
  await openApp(page, "#session=A");
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
  await page.locator('.webui-settings-nav [data-menu-key="usage"]').click();
  await page.getByRole("button", { name: "自定义模型" }).click();
  await expect(customPanel(page)).toBeVisible();
}

/** The body of the last request the fixture recorded for `operation`. */
function lastRequestBody(page, operation) {
  return page.evaluate((op) => {
    const found = window.__fixture.requests.filter((request) => request.operation === op);
    return found.length ? found[found.length - 1].body : undefined;
  }, operation);
}

/** Fills a new provider the way a user would, stopping short of the connection test. */
async function fillNewProvider(page, dialog) {
  // The provider field is a combobox: it shows the selection and searches in
  // the same box, so it is typed into rather than opened by a button.
  await dialog.getByRole("combobox", { name: "提供商" }).click();
  // The popup is portaled out of the dialog, so it is addressed from the page.
  await page.locator('[role="listbox"][aria-label="提供商列表"]').getByRole("option", { name: /其他/ }).click();
  await dialog.getByLabel("提供商名称").fill("Synthetic Draft");
  await dialog.getByLabel("接口地址").fill("https://draft.example/v1");
  await dialog.getByLabel("API Key").fill("sk-draft-synthetic");
  // The form is a list of model cards, not one textarea of ids: a row is added
  // first, and every model carries its own fields.
  await dialog.getByRole("button", { name: "添加模型" }).click();
  await dialog.getByLabel("模型名称").fill("draft-model");
}

/**
 * Records what the provider picker's popup carried, in the page.
 *
 * The exit animation is a 120ms window: the popup starts leaving, the
 * stylesheet fades it out, and the skeleton unmounts it when the fade is
 * over. A reading taken across the wire can arrive after that unmount — and a
 * popup that is no longer in the document has no computed style to read, so
 * the reading comes back empty and the test fails on a state it never saw.
 * It can also arrive before the popup has started leaving, which reads as
 * the entrance animation.
 *
 * So the reading is taken where the state changes: the page watches the
 * popup's own class and records the popup's computed animation-name at the
 * moment that class changes. The record outlives the popup, so the test can
 * read it whenever it gets there, and it cannot miss the window.
 */
async function recordProviderPickerMotion(page) {
  await page.evaluate(() => {
    const selector = '[role="listbox"][aria-label="提供商列表"]';
    window.__webuiProviderPickerMotion = [];
    new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target;
        if (!(node instanceof Element) || !node.matches(selector)) continue;
        window.__webuiProviderPickerMotion.push({
          leaving: node.classList.contains("is-leaving"),
          animationName: getComputedStyle(node).animationName,
        });
      }
    }).observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ["class"],
    });
  });
}

test("the custom tab lists the saved provider and its model row", async ({ page }) => {
  await configureFixture(page, seedProviderSurface);
  await openCustomModels(page);

  const panel = customPanel(page);
  await expect(panel.getByText("Synthetic Provider")).toBeVisible();
  await expect(panel.locator('[data-testid="settings-custom-model-row-gpt-x"]')).toBeVisible();
  // The row is the read's: the page asked the owner, and the owner asked the runtime.
  await expect
    .poll(() => page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "listUserModelProviders").length))
    .toBeGreaterThan(0);
});

test("V10 rapid model toggles serialize semantic intent without restoring stale rows", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setModelProviders([{ providerId: "rapid", name: "Rapid", source: "user", kind: "apiKey", enabled: true, hasApiKey: true,
      models: [{ modelId: "first", displayName: "First", enabled: true }, { modelId: "second", displayName: "Second", enabled: true }] }]);
    window.__fixture.delayEvery("updateUserModelProvider", {});
  });
  await openCustomModels(page);
  await page.getByRole("switch", { name: "禁用 First", exact: true }).click();
  await page.getByRole("switch", { name: "禁用 Second", exact: true }).click();
  const writes = () => page.evaluate(() => window.__fixture.requests.filter(r => r.operation === "updateUserModelProvider"));
  await expect.poll(async () => (await writes()).length).toBe(1);
  await page.evaluate(() => {
    window.__fixture.setModelProviders([{ providerId: "rapid", name: "Rapid", source: "user", kind: "apiKey", enabled: true, hasApiKey: true,
      models: [{ modelId: "first", displayName: "First", enabled: false }, { modelId: "second", displayName: "Second", enabled: true }] }]);
    window.__fixture.resolve("updateUserModelProvider", {}, { ok: true });
  });
  await expect.poll(async () => (await writes()).length).toBe(2);
  expect((await writes())[1].body.models.map(m => ({ modelId: m.modelId, enabled: m.enabled }))).toEqual([
    { modelId: "first", enabled: false }, { modelId: "second", enabled: false },
  ]);
  await page.evaluate(() => {
    window.__fixture.setModelProviders([{ providerId: "rapid", name: "Rapid", source: "user", kind: "apiKey", enabled: true, hasApiKey: true,
      models: [{ modelId: "first", displayName: "First", enabled: false }, { modelId: "second", displayName: "Second", enabled: false }] }]);
    window.__fixture.resolve("updateUserModelProvider", {}, { ok: true });
  });
  await expect(page.getByRole("switch", { name: "启用 First", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "启用 Second", exact: true })).toHaveAttribute("aria-checked", "false");
});

test("the provider picker closes when the pointer lands outside it", async ({ page }) => {
  await configureFixture(page, seedNewProviderSurface);
  await openCustomModels(page);

  await customPanel(page).getByRole("button", { name: "添加模型" }).click();
  const dialog = formDialog(page);
  await dialog.getByRole("combobox", { name: "提供商" }).click();

  const listbox = page.locator('[role="listbox"][aria-label="提供商列表"]');
  await expect(listbox).toBeVisible();
  // The popup carries the shared surface.
  await expect(listbox).toHaveClass(/webui-dropdown-popup/);

  // A press outside the trigger and the popup closes it, and it is gone once
  // the exit animation has run.
  await page.mouse.click(6, 6);
  await expect(listbox).toHaveCount(0);
});

test.describe("with motion allowed", () => {
  test.use({ reducedMotion: "no-preference" });

  test("the provider picker animates in and out", async ({ page }) => {
    await configureFixture(page, seedNewProviderSurface);
    await openCustomModels(page);

    await customPanel(page).getByRole("button", { name: "添加模型" }).click();
    const dialog = formDialog(page);
    await dialog.getByRole("combobox", { name: "提供商" }).click();

    const listbox = page.locator('[role="listbox"][aria-label="提供商列表"]');
    await expect(listbox).toBeVisible();
    // The shared surface carries the motion, so every popup in the client
    // opens and closes the same way.
    expect(await listbox.evaluate((node) => getComputedStyle(node).animationName)).toBe("webui-dropdown-in");

    // The recorder is in place before the press, so what it records is this
    // press's leaving.
    await recordProviderPickerMotion(page);
    await page.mouse.click(6, 6);

    // While it is fading out it is still mounted, and it carries the exit
    // animation rather than the entrance one. The reading is the one the page
    // took at the moment the popup started leaving — not a sample of a popup
    // that has already been unmounted.
    await expect
      .poll(() => page.evaluate(() => (window.__webuiProviderPickerMotion ?? []).find((entry) => entry.leaving) ?? null))
      .toEqual({ leaving: true, animationName: "webui-dropdown-out" });
    await expect(listbox).toHaveCount(0);
  });
});

test("a save stays refused until the draft is proven or the test is skipped", async ({ page }) => {
  await configureFixture(page, seedNewProviderSurface);
  await openCustomModels(page);

  await customPanel(page).getByRole("button", { name: "添加模型" }).click();
  const dialog = formDialog(page);
  await expect(dialog).toBeVisible();
  await fillNewProvider(page, dialog);

  // The draft is filled and nothing has proven it: the save is offered, not enabled.
  await expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled();
  await dialog.getByLabel("跳过连通检测").check();
  await expect(dialog.getByRole("button", { name: "保存" })).toBeEnabled();
});

test("a proven draft saves the candidate the editor built, and the form closes", async ({ page }) => {
  await configureFixture(page, seedNewProviderSurface);
  await openCustomModels(page);

  await customPanel(page).getByRole("button", { name: "添加模型" }).click();
  const dialog = formDialog(page);
  await fillNewProvider(page, dialog);

  await dialog.getByRole("button", { name: "连通检测" }).click();
  await expect.poll(() => lastRequestBody(page, "testUserModelCandidate")).toBeTruthy();
  const tested = await lastRequestBody(page, "testUserModelCandidate");
  expect(tested.candidate).toMatchObject({
    name: "Synthetic Draft",
    baseUrl: "https://draft.example/v1",
    apiKey: "sk-draft-synthetic",
    apiFormat: "openai-completions",
    models: [{ modelId: "draft-model" }],
  });
  expect(tested.modelId).toBe("draft-model");

  await dialog.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => lastRequestBody(page, "saveUserModelProviderCandidate")).toBeTruthy();
  const saved = await lastRequestBody(page, "saveUserModelProviderCandidate");
  expect(saved).toMatchObject({ modelId: "draft-model", saveAndUse: false, skipConnectionTest: false });
  expect(saved.candidate).toMatchObject({ name: "Synthetic Draft", models: [{ modelId: "draft-model" }] });
  await expect(dialog).toHaveCount(0);
});

test("each model carries its own limits, reasoning levels and attachments", async ({ page }) => {
  await configureFixture(page, seedNewProviderSurface);
  await openCustomModels(page);

  await customPanel(page).getByRole("button", { name: "添加模型" }).click();
  const dialog = formDialog(page);
  await fillNewProvider(page, dialog);

  // The fields Desktop's model card carries, filled on the model they belong to.
  await dialog.getByLabel("上下文窗口").fill("128000");
  await dialog.getByLabel("最大输出 Token").fill("8000");
  await dialog.getByLabel("推理等级").fill("low");
  await dialog.getByLabel("推理等级").press("Enter");
  await dialog.getByLabel("推理等级").fill("high");
  await dialog.getByLabel("推理等级").press("Enter");
  await dialog.getByLabel("图片").check();

  await dialog.getByLabel("跳过连通检测").check();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => lastRequestBody(page, "saveUserModelProviderCandidate")).toBeTruthy();
  const saved = await lastRequestBody(page, "saveUserModelProviderCandidate");
  expect(saved.candidate.models).toEqual([
    {
      modelId: "draft-model",
      displayName: "draft-model",
      limit: { context: 128000, output: 8000 },
      effortOptions: ["low", "high"],
      attachment: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    },
  ]);
});

test("an edit writes with the revision the read reported, and offers discovery with it", async ({ page }) => {
  await configureFixture(page, seedProviderSurface);
  await openCustomModels(page);

  await customPanel(page).getByRole("button", { name: "编辑提供商" }).click();
  const dialog = formDialog(page);
  await expect(dialog).toBeVisible();

  // Reveal-on-open reaches the field, and the row starts blank over the stored name.
  await expect(dialog.getByLabel("API Key")).toHaveValue("synthetic-revealed-key");
  const headerValue = dialog.getByLabel("Header 值");
  await expect(headerValue).toHaveValue("");
  await expect(headerValue).toHaveAttribute("placeholder", "留空保留原值");
  await expect(dialog.getByLabel("Header 名称")).toHaveValue("X-Api-Key");

  // D04: the control exists because the read carries `configRevision`, and it sends that same
  // revision — which is what the button never did before, because it read a field the read does
  // not send and therefore never rendered at all.
  await page.evaluate(() => window.__fixture.setDiscoveredModels([{ modelId: "discovered-1" }, { modelId: "discovered-2" }]));
  await dialog.getByRole("button", { name: "自动获取" }).click();
  await expect.poll(() => lastRequestBody(page, "discoverUserModelsCandidate")).toBeTruthy();
  expect(await lastRequestBody(page, "discoverUserModelsCandidate")).toMatchObject({
    providerId: "provider-synthetic",
    expectedRevision: "rev-1",
    baseUrl: "https://synthetic.example/v1",
  });
  const modelNames = dialog.getByLabel("模型名称");
  await expect(modelNames).toHaveCount(2);
  await expect(modelNames.nth(0)).toHaveValue("discovered-1");
  await expect(modelNames.nth(1)).toHaveValue("discovered-2");

  await dialog.getByRole("button", { name: "连通检测" }).click();
  await expect.poll(() => lastRequestBody(page, "testUserModelCandidate")).toBeTruthy();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => lastRequestBody(page, "saveUserModelProviderCandidate")).toBeTruthy();
  // The write carries the identity and the revision the view reported (D04's field).
  expect(await lastRequestBody(page, "saveUserModelProviderCandidate")).toMatchObject({
    candidate: { providerId: "provider-synthetic", expectedRevision: "rev-1" },
  });
  await expect(dialog).toHaveCount(0);
});
