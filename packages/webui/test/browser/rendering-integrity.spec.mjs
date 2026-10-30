// Rendering integrity of the migrated surfaces (ADR 0028 § Rendering integrity
// after extraction).
//
// Each surface below declares the states it can actually show and, among them,
// the content extremes it can reach: an empty collection, one item, the maximum
// number of items, and the longest label or name it can display. A baseline
// captured with short content does not prove the layout survives real content,
// so the report at the end of this file names any surface whose declared
// extremes are not enumerated instead of counting it as passing.
//
// Every state is measured twice — in the light theme and in the dark one — and
// compared against the recording kept in `support/rendering-integrity.json`,
// which is what this suite measured before the migrations started. The
// comparison is geometry and text extent, never pixels: a squeezed box, a label
// that is now cut off, a row that vanished and a surface that left its container
// are all visible in the recording, and re-recording a screenshot cannot make
// any of them disappear.
//
// `RECORD_RENDERING_INTEGRITY=1 pnpm test:webui-browser rendering-integrity`
// re-records the manifest. Re-record deliberately, with the change in the same
// commit: the manifest is the before-and-after evidence, and recording it by
// habit turns the comparison into a description of the current state.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";
import {
  EXTREMES,
  THEMES,
  appliedTheme,
  captureSurface,
  compareWithRecorded,
  loadManifest,
  manifestKey,
  saveManifest,
  summariseSurface,
  useTheme,
} from "./support/rendering-integrity.mjs";

const RECORDING = process.env.RECORD_RENDERING_INTEGRITY === "1";

const PROVIDER = (index, name, baseUrl) => ({
  providerId: `provider-${index}`,
  name,
  source: "user",
  kind: "apiKey",
  enabled: true,
  baseUrl,
  apiFormat: "openai-completions",
  hasApiKey: true,
  maskedApiKey: "sk-synthetic-0000",
  headerNames: ["X-Api-Key"],
  configRevision: `rev-${index}`,
  models: [{ modelId: `model-${index}`, displayName: `Model ${index}`, enabled: true }],
});

const PRESETS = [
  {
    providerId: "preset-openai",
    name: "OpenAI 兼容",
    baseUrl: "https://api.openai.example/v1",
    apiFormat: "openai-completions",
  },
];

const MAXIMUM_PROVIDERS = 12;
const LONGEST_NAME = "Synthetic Provider With The Longest Display Name This Form Can Show".repeat(2);
const LONGEST_URL = `https://${"subdomain.".repeat(8)}synthetic.example/v1/completions`;

/** Seed the fixture before the client script runs; the data stays in Node. */
async function seed(page, data) {
  await page.addInitScript({
    content: `
      window.__WEBUI_FIXTURE_SETUP__ ??= [];
      window.__WEBUI_FIXTURE_SETUP__.push(function () {
        const data = ${JSON.stringify(data)};
        window.__fixture.setModelProviders(data.providers);
        window.__fixture.setProviderPresets(data.presets);
      });
    `,
  });
}

const settingsDialog = (page) => page.locator('[role="dialog"][aria-label="设置"]');
const customPanel = (page) => page.locator('[data-testid="settings-custom-models-panel"]');
const formDialog = (page) =>
  page.locator('[role="dialog"][aria-label="添加模型"], [role="dialog"][aria-label="编辑提供商"]');

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

const S = "settings-custom-models-panel";

const SURFACES = [
  {
    id: "models-provider-form",
    label: "Settings › 用量 › 自定义模型 — the provider form",
    families: ["controls-and-form-composition", "overlays"],
    extremes: ["empty", "one", "maximum", "longest"],
    root: (page) => formDialog(page),
    container: '[role="dialog"][aria-label="设置"]',
    items: "label",
    texts: "label, button, input",
    states: [
      {
        id: "empty",
        extreme: "empty",
        data: { providers: [], presets: PRESETS },
        open: async (page) => {
          await openCustomModels(page);
          await customPanel(page).getByRole("button", { name: "添加模型" }).click();
          await expect(formDialog(page)).toBeVisible();
        },
      },
      {
        id: "one",
        extreme: "one",
        data: { providers: [PROVIDER(1, "Synthetic Provider", "https://synthetic.example/v1")], presets: PRESETS },
        open: async (page) => {
          await openCustomModels(page);
          await expect(customPanel(page)).toContainText("Synthetic Provider");
          await customPanel(page).getByRole("button", { name: "编辑提供商" }).click();
          await expect(formDialog(page)).toBeVisible();
        },
      },
      {
        id: "maximum",
        extreme: "maximum",
        data: {
          providers: Array.from({ length: MAXIMUM_PROVIDERS }, (_, index) =>
            PROVIDER(index + 1, `Synthetic Provider ${index + 1}`, `https://provider-${index + 1}.example/v1`),
          ),
          presets: PRESETS,
        },
        open: async (page) => {
          await openCustomModels(page);
          await expect(customPanel(page)).toContainText(`Synthetic Provider ${MAXIMUM_PROVIDERS}`);
          const rows = customPanel(page).getByRole("button", { name: "编辑提供商" });
          await expect(rows).toHaveCount(MAXIMUM_PROVIDERS);
          await rows.first().click();
          await expect(formDialog(page)).toBeVisible();
        },
      },
      {
        id: "longest",
        extreme: "longest",
        data: {
          providers: [PROVIDER(99, LONGEST_NAME, LONGEST_URL)],
          presets: PRESETS,
        },
        open: async (page) => {
          await openCustomModels(page);
          await customPanel(page).getByRole("button", { name: "编辑提供商" }).click();
          await expect(formDialog(page)).toBeVisible();
        },
      },
    ],
  },
];

test.describe("rendering integrity of the migrated surfaces", () => {
  const manifest = loadManifest();
  const recorded = {};

  for (const surface of SURFACES) {
    for (const state of surface.states) {
      for (const theme of THEMES) {
        test(`${surface.id} / ${state.id} / ${theme}`, async ({ page }) => {
          await useTheme(page, theme);
          await seed(page, state.data);
          await state.open(page);
          expect(await appliedTheme(page), `${surface.id}/${state.id}: the theme did not apply`).toBe(theme);

          const facts = await captureSurface(page, surface, state);
          const key = manifestKey(surface.id, state.id, theme);
          recorded[key] = facts;

          if (RECORDING) return;
          const before = manifest.states[key];
          expect(
            before,
            `${key}: no recording — run with RECORD_RENDERING_INTEGRITY=1 to record this state before migrating it`,
          ).toBeDefined();
          expect(compareWithRecorded(before, facts), `${key}: the surface changed`).toEqual([]);
        });
      }
    }
  }

  test.afterAll(() => {
    if (RECORDING) {
      saveManifest({ version: 1, states: recorded });
      return;
    }
    const report = SURFACES.map((surface) => {
      const verified = new Set(
        surface.states
          .filter((state) => THEMES.every((theme) => manifest.states[manifestKey(surface.id, state.id, theme)]))
          .map((state) => state.id),
      );
      return summariseSurface(surface, verified);
    });
    const unverified = report.filter((surface) => surface.unverified);
    // The report is printed either way: an unverified surface is evidence this
    // suite does not have, not a surface that passed.
    console.log(JSON.stringify({ surfaces: report, extremes: EXTREMES }, null, 2));
    expect(unverified.map((surface) => [surface.surface, surface.missing])).toEqual([]);
  });
});
