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

import { openApp, openLauncherTile, test } from "./harness.mjs";
import {
  classifyFindings,
  compareBaseline,
  contrastOf,
  loadReview,
  staleExceptions,
  undispositionedRules,
  formatReport,
  loadBaseline,
  loadExceptions,
  saveBaseline,
  scanSurface,
} from "./support/accessibility.mjs";
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
// `RECORD_ACCESSIBILITY_BASELINE=1` re-records the known debt. Re-record
// deliberately, in the same commit as the change that moved it.
const RECORD_A11Y = process.env.RECORD_ACCESSIBILITY_BASELINE === "1";

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

const RAIL_MAXIMUM_SESSIONS = 10;
const TREE_MAXIMUM_FILES = 30;
const LONGEST_SESSION_TITLE =
  "Longest session title this rail can be given — a name with no useful break in it whatsoever";
const LONGEST_FILENAME = `${"longest-file-name-".repeat(6)}component.tsx`;

/** Apply whichever fixture setters a state needs, before the client script runs. */
async function seedFixture(page, data) {
  await page.addInitScript({
    content: `
      window.__WEBUI_FIXTURE_SETUP__ ??= [];
      window.__WEBUI_FIXTURE_SETUP__.push(function () {
        const data = ${JSON.stringify(data)};
        if (data.sessions) window.__fixture.setSessions(data.sessions);
        if (data.projects) window.__fixture.setProjects(data.projects);
        if (data.tree) window.__fixture.setTree(data.tree);
        if (data.workspaceTree) window.__fixture.setWorkspaceFileTree(data.workspaceTree);
        if (data.usageQuota) window.__fixture.setUsageQuotaResult(data.usageQuota);
        if (data.turnDiff) window.__fixture.setTurnDiff(data.turnDiff);
        if (data.sessionMessages) window.__fixture.setPage("A", data.sessionMessages);
        for (const [action, result] of Object.entries(data.pluginManagement ?? {})) {
          window.__fixture.setPluginManagementResult(action, result);
        }
        for (const [operation, value] of Object.entries(data.responses ?? {})) {
          window.__fixture.setResponse(operation, value);
        }
      });
    `,
  });
}

const railSession = (id, title, index) => ({
  sessionId: id,
  agentName: `synthetic-${id}`,
  title,
  createdAt: 1_700_000_000_000 + index,
  updatedAt: 1_700_000_000_000 + index,
  workspaceDir: "/synthetic/workspace",
});

const railProject = (projectId, sessionCount) => ({
  projectId,
  projectKind: "workspace",
  workspaceDir: "/synthetic/workspace",
  pinned: false,
  hidden: false,
  orderIndex: 0,
  recentAtMs: 1_700_000_000_001,
  latestActivityAtMs: 1_700_000_000_001,
  sessionCount,
});

const treeFile = (name) => ({
  path: name,
  name,
  type: "file",
  size: 120,
  modifiedAt: 1_700_000_000_000,
});

/** The workspace panel with its file tree open, the way a user opens it. */
async function openWorkspaceTree(page) {
  await openApp(page, "#session=A");
  await page
    .getByTestId("workspace-panel-controls")
    .getByRole("button", { name: "浏览器" })
    .click();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await openLauncherTile(page, "files");
  await expect(page.getByRole("complementary", { name: "工作区文件树" })).toBeVisible();
}

const MCP_LONGEST_NAME = `synthetic-mcp-server-${"long-name-".repeat(12)}`;

/** Settings › 用量, reached the way a user reaches it. */
async function openUsagePage(page) {
  await openApp(page, "#session=A");
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
  await page.locator('.webui-settings-nav [data-menu-key="usage"]').click();
  await expect(page.locator('[data-testid="settings-usage-token-plan"]')).toBeVisible();
}

/**
 * Plugins › 管理 › MCP › 添加 MCP server.
 *
 * The management surface has to be reached before the MCP category filter and
 * the add button exist, and the fixture has to answer `listMcpServers` for the
 * list behind the dialog to render at all.
 */
async function openMcpForm(page, name) {
  await openApp(page, "#session=A");
  await page.getByRole("button", { name: "插件" }).first().click();
  await page.getByTestId("plugin-manage-trigger").click();
  // The management surface's create control opens the chooser; "添加 MCP server"
  // is one option in it, not a button on the management list.
  await page.getByTestId("plugin-create-trigger").click();
  await page.getByRole("menuitem", { name: "添加 MCP server" }).click();
  const dialog = page.getByRole("dialog", { name: "MCP Server" });
  await expect(dialog).toBeVisible();
  if (name.length > 0) await dialog.getByLabel("名称").fill(name);
}

const S = "settings-custom-models-panel";

/**
 * Seed a session's transcript. `setPage` replaces what `resumeSession` answers
 * for that session, so the transcript renders exactly the messages given here.
 */
async function seedTranscript(page, messages) {
  await page.addInitScript({
    content: `
      window.__WEBUI_FIXTURE_SETUP__ ??= [];
      window.__WEBUI_FIXTURE_SETUP__.push(function () {
        window.__fixture.setPage("A", ${JSON.stringify({ messages, hasMore: false })});
      });
    `,
  });
}

const assistantMessage = (id, content) => ({
  msgId: id,
  role: "assistant",
  msgContent: content,
  timestamp: 1_700_000_000_500,
});

const userMessage = (index, content) => ({
  msgId: `message-${index}`,
  role: "user",
  msgContent: content,
  timestamp: 1_700_000_000_000 + index,
});

const transcriptScroll = (page) => page.locator(".webui-session-transcript-scroll");

const TRANSCRIPT_MESSAGES = 40;
const LONGEST_MESSAGE = `${"LongestMessageWithoutAnyBreak".repeat(12)}`.slice(0, 600);

const SURFACES = [
  {
    id: "models-provider-form",
    seed: (page, state) => seed(page, state.data),
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
  {
    id: "transcript",
    seed: (page, state) => seedTranscript(page, state.messages),
    label: "The conversation transcript of a session",
    families: ["conversation-and-workspace-interaction", "surfaces-and-content"],
    extremes: ["empty", "one", "maximum", "longest"],
    root: (page) => transcriptScroll(page),
    texts: "span, p",
    states: [
      {
        id: "empty",
        extreme: "empty",
        messages: [],
        open: async (page) => {
          await openApp(page, "#session=A");
          await expect(page.getByTestId("transcript-empty-state")).toBeVisible();
        },
      },
      {
        id: "one",
        extreme: "one",
        messages: [userMessage(1, "A single synthetic message")],
        open: async (page) => {
          await openApp(page, "#session=A");
          await expect(transcriptScroll(page)).toContainText("A single synthetic message");
        },
      },
      {
        id: "maximum",
        extreme: "maximum",
        messages: Array.from({ length: TRANSCRIPT_MESSAGES }, (_, index) =>
          userMessage(index + 1, `Synthetic message ${index + 1}`),
        ),
        open: async (page) => {
          await openApp(page, "#session=A");
          // Every message the fixture was given is on the page: the last one is
          // the claim a truncated or virtualised list would break.
          await expect(transcriptScroll(page)).toContainText(`Synthetic message ${TRANSCRIPT_MESSAGES}`);
          await expect(transcriptScroll(page)).toContainText("Synthetic message 1");
          // The collection renders every item it was given, not a sample of them.
          await expect(transcriptScroll(page).getByText(/^Synthetic message \d+$/u)).toHaveCount(
            TRANSCRIPT_MESSAGES,
          );
        },
      },
      {
        id: "longest",
        extreme: "longest",
        messages: [userMessage(1, LONGEST_MESSAGE)],
        open: async (page) => {
          await openApp(page, "#session=A");
          await expect(transcriptScroll(page)).toContainText(LONGEST_MESSAGE.slice(0, 40));
        },
      },
      {
        // Not one of the four extremes: the message that carries a turn diff.
        // A diff card is a data-driven block inside the transcript, and its
        // numbers and state are what a migration of the message body would
        // silently drop.
        id: "turn-diff",
        seed: (page) => seedFixture(page, {
          sessionMessages: {
            messages: [
              assistantMessage("assistant-diff", "Edited one file."),
              userMessage(2, "A second synthetic message"),
            ],
            hasMore: false,
          },
          turnDiff: {
            status: "active",
            changeSetId: "cs-fixture",
            sourceMessageId: "assistant-diff",
            canUndo: true,
            canReapply: false,
            fileChanges: [
              { file: "a.ts", additions: 2, deletions: 1 },
              { file: "src/long-file-name-for-layout-pressure.ts", additions: 12, deletions: 7 },
            ],
          },
        }),
        open: async (page) => {
          await openApp(page, "#session=A");
          const card = transcriptScroll(page).locator('[data-webui-diff-card="true"]');
          await expect(card).toBeVisible();
          // The counts, the file names and the state badge are the data the card
          // exists to show.
          await expect(card.locator('[data-webui-diff-stats="true"]').first()).toContainText("+");
          await expect(card).toContainText("a.ts");
          await expect(card).toHaveAttribute("data-webui-diff-state", /active|applied|undone/u);
        },
      },
    ],
  },
  {
    id: "application-shell",
    // The rail builds its rows from the session tree, not from the session list,
    // so a state that only replaces `sessions` measures the fixture's default
    // rail while claiming to measure its own content.
    seed: (page, state) =>
      seedFixture(page, {
        sessions: state.sessions,
        projects: state.projects,
        tree: {
          sessions: state.sessions.map((session) => ({ session, childSessions: [] })),
          hasMore: false,
        },
      }),
    label: "The application shell — the session rail",
    families: ["structure", "navigation-and-selection"],
    extremes: ["empty", "one", "maximum", "longest"],
    root: (page) => page.locator(".webui-rail-scroll"),
    texts: "span, label, p",
    states: [
      {
        id: "empty",
        extreme: "empty",
        sessions: [],
        projects: [],
        open: async (page) => {
          await openApp(page, "#session=A");
          await expect(page.locator(".webui-rail-scroll")).toBeVisible();
        },
      },
      {
        id: "one",
        extreme: "one",
        sessions: [railSession("A", "Synthetic session A", 0)],
        projects: [railProject(1, 1)],
        open: async (page) => {
          await openApp(page, "#session=A");
          await expect(page.locator(".webui-rail-scroll")).toContainText("Synthetic session A");
        },
      },
      {
        id: "maximum",
        extreme: "maximum",
        sessions: Array.from({ length: RAIL_MAXIMUM_SESSIONS }, (_, index) =>
          railSession(`session-${index + 1}`, `Synthetic session ${index + 1}`, index),
        ),
        projects: [railProject(1, RAIL_MAXIMUM_SESSIONS)],
        open: async (page) => {
          await openApp(page, "#session=session-1");
          const rail = page.locator(".webui-rail-scroll");
          await expect(rail).toContainText("Synthetic session 1");
          // The row's timestamp is part of what the rail shows; a migration that
          // drops it would otherwise pass a name-only check.
          await expect(rail).toContainText(/\d{4}-\d{2}-\d{2}/u);
          await expect(rail.getByText(`Synthetic session ${RAIL_MAXIMUM_SESSIONS}`)).toHaveCount(1);
        },
      },
      {
        id: "longest",
        extreme: "longest",
        sessions: [railSession("A", LONGEST_SESSION_TITLE, 0)],
        projects: [railProject(1, 1)],
        open: async (page) => {
          await openApp(page, "#session=A");
          await expect(page.locator(".webui-rail-scroll")).toContainText("Longest session title");
        },
      },
    ],
  },
  {
    id: "workspace-panel",
    seed: (page, state) => seedFixture(page, { workspaceTree: state.tree }),
    label: "The workspace panel — its file tree",
    families: ["structure", "surfaces-and-content"],
    extremes: ["empty", "one", "maximum", "longest"],
    root: (page) => page.getByTestId("workspace-panel"),
    texts: "span, label, p",
    states: [
      {
        id: "empty",
        extreme: "empty",
        tree: [],
        open: (page) => openWorkspaceTree(page),
      },
      {
        id: "one",
        extreme: "one",
        tree: [treeFile("a.ts")],
        open: async (page) => {
          await openWorkspaceTree(page);
          await expect(page.getByRole("complementary", { name: "工作区文件树" })).toContainText("a.ts");
        },
      },
      {
        id: "maximum",
        extreme: "maximum",
        tree: Array.from({ length: TREE_MAXIMUM_FILES }, (_, index) => treeFile(`file-${index + 1}.ts`)),
        open: async (page) => {
          await openWorkspaceTree(page);
          const tree = page.getByRole("complementary", { name: "工作区文件树" });
          await expect(tree).toContainText(`file-${TREE_MAXIMUM_FILES}.ts`);
        },
      },
      {
        id: "longest",
        extreme: "longest",
        tree: [treeFile(LONGEST_FILENAME)],
        open: async (page) => {
          await openWorkspaceTree(page);
          await expect(page.getByRole("complementary", { name: "工作区文件树" })).toContainText(
            LONGEST_FILENAME.slice(0, 30),
          );
        },
      },
    ],
  },
  {
    id: "settings-usage-page",
    seed: (page, state) => seedFixture(page, { usageQuota: state.usageQuota }),
    label: "Settings › 用量 — the usage page",
    families: ["surfaces-and-content", "feedback-and-recovery"],
    extremes: ["empty", "one", "maximum", "longest"],
    root: (page) => page.locator('[data-testid="settings-usage-token-plan"]'),
    container: '[role="dialog"][aria-label="设置"]',
    texts: "span, label, p",
    states: [
      {
        id: "empty",
        extreme: "empty",
        usageQuota: { signedIn: false },
        open: async (page) => {
          await openUsagePage(page);
          // Signed out the page says so instead of drawing empty rows.
          await expect(page.locator('[data-testid="settings-usage-token-plan"]')).toContainText(
            "登录后查看用量",
          );
        },
      },
      {
        id: "one",
        extreme: "one",
        // Every signed-in state answers without a token plan on purpose: a
        // subscribed answer turns on the reset-card flow, which this surface does
        // not measure and which the fixture does not model. The plan row, the
        // credits and the expiry date are all reachable without it.
        usageQuota: {
          signedIn: true,
          hasTokenPlan: false,
          subscriptionType: "mplan",
          planName: "M Plan 标准版",
        },
        open: async (page) => {
          await openUsagePage(page);
          await expect(page.getByTestId("settings-usage-plan-name")).toHaveText(/\S/u);
          // The model-source pill carries the badge that names the source in use.
          await expect(page.getByTestId("settings-usage-source-tab")).not.toBeEmpty();
        },
      },
      {
        id: "maximum",
        extreme: "maximum",
        usageQuota: {
          signedIn: true,
          hasTokenPlan: false,
          subscriptionType: "mplan",
          planName: "M Plan 标准版",
          creditBalance: "1280",
          purchasedCredits: "1000",
          freeCredits: "280",
          tokenPlanExpiresAt: 1_800_000_000_000,
          willRenewal: true,
          quota: {
            fiveHour: { usedPercent: 87, totalPercent: 100, resetAtMs: 1_800_000_000_000, unlimited: false },
            weekly: { usedPercent: 42, totalPercent: 100, resetAtMs: 1_800_000_000_000, unlimited: false },
            video: { usedCount: 12, totalCount: 20, resetAtMs: 1_800_000_000_000, unlimited: false },
          },
        },
        open: async (page) => {
          await openUsagePage(page);
          // Every figure the page can draw is present: the plan row with its
          // renewal date, and the credits.
          const section = page.locator('[data-testid="settings-usage-token-plan"]');
          await expect(section).toContainText("自动续费");
          await expect(section).toContainText("积分");
        },
      },
      {
        id: "longest",
        extreme: "longest",
        usageQuota: {
          signedIn: true,
          hasTokenPlan: false,
          subscriptionType: "mplan",
          planName: "M Plan 企业版 Enterprise Plan With A Very Long Display Name For Layout Pressure",
          creditBalance: "999999",
        },
        open: async (page) => {
          await openUsagePage(page);
          const planName = page.getByTestId("settings-usage-plan-name");
          await expect(planName).toHaveText(/\S/u);
          const length = await planName.evaluate((node) => (node.textContent ?? "").length);
          expect(length, "the longest plan name was not rendered in full").toBeGreaterThan(20);
        },
      },
    ],
  },
  {
    id: "plugins-mcp-form",
    // The form renders one server's fields, so it has no collection to grow to a
    // maximum: its extremes are blank, filled, and the longest values it holds.
    seed: (page) =>
      seedFixture(page, {
        pluginManagement: {
          listMcpServers: { servers: [] },
          createMcpServer: { success: true },
        },
      }),
    label: "Plugins › 管理 › MCP — the add-server form",
    families: ["controls-and-form-composition", "overlays"],
    extremes: ["empty", "one", "longest"],
    root: (page) => page.getByRole("dialog", { name: "MCP Server" }),
    texts: "span, label, p",
    states: [
      {
        id: "empty",
        extreme: "empty",
        name: "",
        open: (page) => openMcpForm(page, ""),
      },
      {
        id: "one",
        extreme: "one",
        name: "local-docs",
        open: async (page) => {
          await openMcpForm(page, "local-docs");
          // A field's value is not its text content, so it is read back rather
          // than matched against the dialog's rendered text.
          await expect(
            page.getByRole("dialog", { name: "MCP Server" }).getByLabel("名称"),
          ).toHaveValue("local-docs");
        },
      },
      {
        id: "longest",
        extreme: "longest",
        name: MCP_LONGEST_NAME,
        open: async (page) => {
          await openMcpForm(page, MCP_LONGEST_NAME);
          const value = await page
            .getByRole("dialog", { name: "MCP Server" })
            .getByLabel("名称")
            .inputValue();
          expect(value, "the longest name was truncated in the field").toBe(MCP_LONGEST_NAME);
        },
      },
    ],
  },
];

test.describe("rendering integrity of the migrated surfaces", () => {
  const manifest = loadManifest();
  const recorded = {};
  // The same enumeration drives the accessibility scan: the states a surface
  // enumerates for its geometry are the states it is scanned in.
  const findings = [];
  const incomplete = [];
  const scannedStates = new Set();

  for (const surface of SURFACES) {
    for (const state of surface.states) {
      for (const theme of THEMES) {
        test(`${surface.id} / ${state.id} / ${theme}`, async ({ page }) => {
          await useTheme(page, theme);
          await (state.seed ?? surface.seed)(page, state);
          await state.open(page);
          expect(await appliedTheme(page), `${surface.id}/${state.id}: the theme did not apply`).toBe(theme);

          const facts = await captureSurface(page, surface, state);
          const key = manifestKey(surface.id, state.id, theme);
          recorded[key] = facts;

          const scan = await scanSurface(page);
          for (const violation of scan.violations) {
            findings.push({ ...violation, surface: surface.id, state: state.id, theme });
          }
          for (const entry of scan.incomplete) {
            incomplete.push({ ...entry, surface: surface.id, state: state.id, theme });
            // A manual review needs the nodes, not the count. This prints them on
            // demand so the review is written from what the engine saw.
            if (process.env.DUMP_INCOMPLETE) {
              for (const node of entry.nodes) {
                console.log(`INCOMPLETE\t${entry.rule}\t${surface.id}/${state.id}/${theme}\t${node.html ?? node.stable}`);
              }
            }
            // A contrast finding axe could not decide is resolved the way the
            // browser composites it: the element's colour against the first
            // ancestor that states one. The ratio is logged so the manual review
            // is written from a measurement.
            if (process.env.DUMP_INCOMPLETE && entry.rule === "color-contrast") {
              for (const node of entry.nodes) {
                const measured = await page.evaluate(
                  ([selectors, source]) => {
                    // The measurement runs in the page, so the function travels as
                    // source: it is pure DOM and this keeps one implementation.
                    const measure = new Function(`return (${source})`)();
                    for (const selector of selectors) {
                      try {
                        const element = document.querySelector(selector);
                        if (element) return measure(element);
                      } catch {
                        // A generated selector can stop matching between runs.
                      }
                    }
                    return null;
                  },
                  [node.selectors ?? [], contrastOf.toString()],
                );
                console.log(
                  `CONTRAST\t${surface.id}/${state.id}/${theme}\t${node.html ?? node.stable}\t${JSON.stringify(measured)}`,
                );
              }
            }
          }
          scannedStates.add(key);

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

    // The accessibility half of the same enumeration (ADR 0028 § Accessibility).
    const exceptions = loadExceptions().exceptions ?? [];
    // Colour is measurable, so it takes no exception. A contrast exemption is
    // always either an unfixed value or a reason that describes a different
    // failure than the one in front of it — the memory editor's text was excused
    // as "secondary and tertiary tokens" while it used the primary one, and its
    // own bubble sat at 1.04:1 in the dark theme for as long as the exemption
    // stood. Fix the value, or fix the token.
    expect(
      exceptions
        .filter((exception) => exception.rule === "color-contrast")
        .map((exception) => exception.target),
      "contrast exceptions are not accepted: fix the colour and delete the exemption",
    ).toEqual([]);
    const dispositions = loadReview().dispositions ?? [];
    const unexcepted = [];
    for (const surface of SURFACES) {
      for (const state of surface.states) {
        for (const theme of THEMES) {
          const stateFindings = findings.filter(
            (finding) =>
              finding.surface === surface.id && finding.state === state.id && finding.theme === theme,
          );
          const classified = classifyFindings({
            surface: surface.id,
            state: `${state.id}/${theme}`,
            findings: stateFindings,
            exceptions,
          });
          unexcepted.push(
            ...classified.unexcepted.map((finding) => ({
              ...finding,
              state: `${state.id}/${theme}`,
            })),
          );
          void classified;
        }
      }
    }
    // An excepted finding is a reviewed decision, so it does not belong in the
    // recorded debt: the debt is what nobody has looked at yet.
    // Exemption is per target, not per finding: an exception covers the nodes it
    // names, and the other nodes of the same rule in the same state stay in the
    // debt. Dropping the whole finding would let one reviewed node hide the rest.
    const exceptedNode = (finding, node) =>
      exceptions.some(
        (exception) =>
          exception.rule === finding.rule &&
          (exception.surface === "*" || exception.surface === finding.surface) &&
          [node.stable, ...node.selectors].some((value) => value.includes(exception.target)),
      );
    const unreviewed = findings
      .map((finding) => ({
        ...finding,
        nodes: finding.nodes.filter((node) => !exceptedNode(finding, node)),
      }))
      .filter((finding) => finding.nodes.length > 0);

    if (RECORD_A11Y) {
      const count = saveBaseline(unreviewed);
      console.log(`accessibility baseline recorded: ${count} findings across ${scannedStates.size} states`);
      return;
    }
    const baseline = compareBaseline(loadBaseline().findings ?? [], unreviewed);
    // The report is printed before the assertions, so a failing run carries the
    // evidence of what it found instead of only the fact that it failed.
    const report_ = formatReport({
      scanned: scannedStates.size,
      findings,
      unexcepted,
      stale: staleExceptions(findings, exceptions),
      incomplete,
      review: dispositions,
    });
    expect(
      baseline.newFindings,
      `accessibility findings that are not in the recorded debt\n${report_}`,
    ).toEqual([]);
    expect(baseline.staleEntries, "recorded findings that have gone; delete them").toEqual([]);
    // The report states what the scan cannot decide; it is printed on every run,
    // pass or fail, because a clean scan is not a finding of accessibility.
    console.log(report_);
    // The gate is the recorded debt, not the report: what the recording does not
    // know fails, and a recorded finding that has gone fails. The reviewed
    // exceptions are the narrower mechanism and are counted above.
    void unexcepted;
    // Decided over the whole run: an exception scoped to every state matches in
    // the state that renders its node and nowhere else.
    if (process.env.DUMP_EXCEPTION_CONTRAST) {
      console.log("== measured contrast for every colour exception, worst state ==");
      for (const [target, value] of [...EXCEPTION_CONTRAST.entries()].sort((a, b) => a[1].min - b[1].min)) {
        console.log(`  ${String(value.min).padStart(6)} : ${target}  (${value.count} node(s), ${value.state})`);
      }
    }
    expect(
      staleExceptions(findings, exceptions).map((exception) => `${exception.rule} ${exception.target}`),
      "exceptions whose finding has gone",
    ).toEqual([]);
    // An undecided finding is not allowed to sit in the report unowned.
    expect(
      undispositionedRules(incomplete, dispositions),
      "incomplete rules with no recorded manual disposition",
    ).toEqual([]);
  });
});
