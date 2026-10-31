import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SettingsCard,
  SettingsDivider,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../../src/client/ui/settings-layout.js";
import { WebuiWorktreePanel } from "../../src/client/features/settings/ui/SettingsModal.js";
import { UsageModelSettings } from "../../src/client/features/settings/ui/UsageModelSettings.js";
import { UsageResetCards } from "../../src/client/features/settings/ui/UsageResetCards.js";
import type { WebuiAccountWorkflowsConsumer } from "../../src/client/features/account/bindings/use-account-workflows.public.js";

/* The settings pages used to carry a frame each — a page column, a section
 * title, a card — and the copies drifted: the worktree page drew a bordered
 * white card where the general page drew a grouped-surface card, so two pages
 * in one panel looked like two products. The frame is now declared once, in
 * `client/ui/settings-layout.tsx`, and these tests hold it there: one
 * declaration, one look, every page. */

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const PAGE_SOURCES = [
  "../../src/client/features/settings/ui/SettingsModal.public.tsx",
  "../../src/client/features/settings/ui/SettingsModal.tsx",
  "../../src/client/features/settings/ui/PersonalizationSettings.tsx",
  "../../src/client/features/settings/ui/GlobalInstructionsSection.tsx",
  "../../src/client/features/settings/ui/UserProfileSection.tsx",
  "../../src/client/features/settings/ui/MemorySection.tsx",
  "../../src/client/features/settings/ui/UsageModelSettings.tsx",
  "../../src/client/features/settings/ui/UsageResetCards.tsx",
  "../../src/client/features/settings/ui/AccountUsageSettings.tsx",
  "../../src/client/features/settings/ui/UsageHeatmap.tsx",
  "../../src/client/features/review/ui/ReviewSettingsPage.public.tsx",
];

/** The frame each page used to draw for itself. */
const PRIVATE_FRAME_CLASSES = [
  "webui-generic-page",
  "webui-generic-section",
  "webui-generic-card",
  "webui-generic-row",
  "webui-generic-divider",
  "webui-personalization-page",
  "webui-personalization-header",
  "webui-personalization-title",
  "webui-archived-page",
  "webui-review-page",
  "webui-settings-panels",
  "webui-settings-panel",
];

describe("the shared settings skeleton", () => {
  it("renders one frame: a page, a section, a card, a row and a divider", () => {
    const markup = renderToStaticMarkup(
      <SettingsPage testId="frame">
        <SettingsSection title="模式" testId="section">
          <SettingsRow title="标题" description="说明" testId="row">
            <button type="button">控制</button>
          </SettingsRow>
          <SettingsDivider />
        </SettingsSection>
      </SettingsPage>,
    );
    expect(markup).toContain('class="webui-settings-page"');
    expect(markup).toContain('class="webui-settings-section"');
    expect(markup).toContain('class="webui-settings-card"');
    expect(markup).toContain('class="webui-settings-row"');
    expect(markup).toContain('class="webui-settings-divider"');
    // The title is the section's own heading and the control sits on the
    // right, so a section reads the same whichever page it belongs to.
    expect(markup).toContain("<h3>模式</h3>");
    expect(markup).toContain('class="webui-settings-row-control"');
  });

  it("keeps the help bubble beside the title and the action on the far side", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection title="记忆" hint="这段说明属于这一节。" hintTestId="hint" actions={<button type="button">保存</button>}>
        <SettingsRow title="行" />
      </SettingsSection>,
    );
    expect(markup).toContain('data-testid="hint"');
    expect(markup).toContain("这段说明属于这一节。");
    expect(markup).toContain('class="webui-settings-section-actions"');
  });

  it("drops the card for a section that brings its own surface", () => {
    const markup = renderToStaticMarkup(
      <SettingsSection title="模式" bare>
        <div className="own-surface" />
      </SettingsSection>,
    );
    expect(markup).toContain('class="webui-settings-card is-bare"');
    expect(markup).not.toContain('class="webui-settings-card"');
  });

  it("is the frame the settings pages render in", () => {
    const worktree = renderToStaticMarkup(<WebuiWorktreePanel workspaces={[]} />);
    expect(worktree).toContain('class="webui-settings-page"');
    expect(worktree).toContain('class="webui-settings-section"');
    const usage = renderToStaticMarkup(<UsageModelSettings />);
    expect(usage).toContain('class="webui-settings-page"');
  });

  it("leaves no settings page drawing a frame of its own", () => {
    for (const source of PAGE_SOURCES) {
      const markup = repoFile(source);
      for (const className of PRIVATE_FRAME_CLASSES) {
        expect(markup.includes(className), `${source} still draws ${className}`).toBe(false);
      }
    }
  });

  it("declares the frame once, in the shared shell stylesheet", () => {
    const shell = repoFile("../../src/client/styles/shell.css");
    const settings = repoFile("../../src/client/features/settings/ui/settings.css");
    for (const className of [
      "webui-settings-page",
      "webui-settings-section",
      "webui-settings-card",
      "webui-settings-row",
      "webui-settings-divider",
    ]) {
      expect(shell.includes(`.${className} {`), `shell.css does not declare ${className}`).toBe(true);
      expect(settings.includes(`.${className} {`), `settings.css declares ${className} too`).toBe(false);
    }
  });

  it("keeps a second card available for a section that needs one", () => {
    const markup = renderToStaticMarkup(
      <SettingsCard>
        <SettingsRow title="行" />
      </SettingsCard>,
    );
    expect(markup).toContain('class="webui-settings-card"');
  });
});

describe("the 限额重置 section renders the shared frame", () => {
  /** A subscribed account: the reset cards are a plan feature. */
  const subscribedAccount = {
    canUseResetCards: true,
    loadResetCards: () => Promise.resolve(true),
    loadMoreResetCards: () => Promise.resolve(true),
    openResetCardHistory: () => Promise.resolve(true),
    loadMoreResetCardHistory: () => Promise.resolve(true),
    closeResetCardHistory: () => undefined,
    selectResetCard: () => undefined,
    clearResetCardSelection: () => undefined,
    redeemResetCard: () => Promise.resolve(),
  } as unknown as WebuiAccountWorkflowsConsumer;

  const state = {
    cards: {
      items: [
        { cardId: "card-1", name: "完全重置", expireTimeMs: Date.UTC(2026, 9, 31) },
      ],
      page: 1,
      loading: false,
      hasMore: false,
      retryMore: false,
    },
    total: 1,
    history: { items: [], page: 0, loading: false, hasMore: true, retryMore: false },
    phase: "idle" as const,
    dialogOpen: false,
    historyOpen: false,
  };

  it("renders the section title, the card and the rows the page renders", () => {
    const markup = renderToStaticMarkup(
      <UsageResetCards account={subscribedAccount} state={state} />,
    );
    expect(markup).toContain('class="webui-settings-section"');
    expect(markup).toContain('class="webui-settings-card"');
    expect(markup).toContain('class="webui-settings-row"');
    expect(markup).toContain("<h3>限额重置</h3>");
    // The history is the section's action, not a stray link under the list.
    expect(markup).toContain('class="webui-settings-section-actions"');
  });

  it("uses the page's own button, not a border of its own", () => {
    const markup = renderToStaticMarkup(
      <UsageResetCards account={subscribedAccount} state={state} />,
    );
    expect(markup).toContain("webui-mavis-button");
    expect(markup).not.toContain("border-border_default");
  });

  it("shows no section at all for an account without a plan", () => {
    const markup = renderToStaticMarkup(
      <UsageResetCards
        account={{ ...subscribedAccount, canUseResetCards: false } as unknown as WebuiAccountWorkflowsConsumer}
        state={state}
      />,
    );
    expect(markup).toBe("");
  });
});
