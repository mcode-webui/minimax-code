import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DESKTOP_SETTINGS_TABS, filterSettingsTabs, GENERIC_FILE_ROW_ORDER, GENERIC_RADIO_CONTRACT, GENERIC_SECTION_TEST_IDS, resolveThemePreference, SETTINGS_GROUPS, SETTINGS_ICON_PATHS } from "../../src/client/components/SettingsModal.js";
import { DisabledBillingActions, UsageModelSettings } from "../../src/client/components/settings/UsageModelSettings.js";
import { reorderModelIds } from "../../src/client/projection/model-reorder.js";
import { formatResetLabel, getActiveSourceBadge, projectProviderHeaders } from "../../src/client/projection/usage-settings.js";

describe("desktop settings registry", () => {
  it("keeps the electron tab order, labels, and groups", () => {
    expect(DESKTOP_SETTINGS_TABS.map((tab) => [tab.key, tab.group, tab.label])).toEqual([
      ["desktop", "preferences", "通用"],
      ["voice", "preferences", "语音"],
      ["shortcuts", "preferences", "快捷键"],
      ["custom-instructions", "preferences", "个性化"],
      ["usage", "management", "用量与模型"],
      ["connection", "management", "连接"],
      ["account", "management", "账户"],
      ["coding", "coding", "代码审查"],
      ["worktree", "coding", "工作树"],
      ["archived", "archived", "已归档任务"],
    ]);
  });

  it("declares every desktop group exactly once", () => {
    expect(SETTINGS_GROUPS.map((group) => group.key)).toEqual(["preferences", "management", "coding", "archived"]);
    expect(new Set(DESKTOP_SETTINGS_TABS.map((tab) => tab.key)).size).toBe(DESKTOP_SETTINGS_TABS.length);
    for (const group of SETTINGS_GROUPS) expect(DESKTOP_SETTINGS_TABS.some((tab) => tab.group === group.key)).toBe(true);
  });

  it("resolves system theme against the OS preference", () => {
    expect(resolveThemePreference("system", true)).toBe("dark");
    expect(resolveThemePreference("system", false)).toBe("light");
    expect(resolveThemePreference("light", true)).toBe("light");
    expect(resolveThemePreference("dark", false)).toBe("dark");
  });

  it("returns the desktop empty-state condition for an unmatched search", () => {
    expect(filterSettingsTabs("不存在的设置")).toHaveLength(0);
  });

  it("keeps the generic page structure and control contracts", () => {
    expect(GENERIC_SECTION_TEST_IDS).toEqual(["app-mode-section", "application-section", "link-open-destination-section", "file-section", "session-management-section", "agent-control-permission-section", "about-section"]);
    expect(GENERIC_FILE_ROW_ORDER).toEqual(["file-open-in-new-tab-switch", "file-line-wrap-switch"]);
    expect(GENERIC_RADIO_CONTRACT).toEqual({ position: "absolute right-4 top-[22px]", accentToken: "icon_default_accent" });
    for (const tab of DESKTOP_SETTINGS_TABS) expect(SETTINGS_ICON_PATHS[tab.icon]).toBeTruthy();
  });

  it("renders the usage source shell and its loading branch without a DOM runtime", () => {
    const markup = renderToStaticMarkup(<UsageModelSettings capabilities={{}} />);
    expect(markup).toContain("Token Plan");
    expect(markup).toContain("加载中…");
  });

  it("keeps every cloud billing control inert and leaves credit fallback unchecked", () => {
    const markup = renderToStaticMarkup(<DisabledBillingActions />);
    expect((markup.match(/disabled=""/gu) ?? []).length).toBe(8);
    expect(markup).toContain("Disabled (not yet wired)");
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toMatch(/<button(?=[^>]*disabled="")(?=[^>]*title="Disabled \(not yet wired\)")[^>]*><span[^>]*>明细<\/span>/u);
  });

  it("reorders model ids by stable identity and leaves missing ids untouched", () => {
    expect(reorderModelIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderModelIds(["a", "b", "c"], "missing", "c")).toEqual(["a", "b", "c"]);
  });

  it("does not claim an active source until the source read resolves", () => {
    expect(getActiveSourceBadge(false, "token_plan", true)).toBeUndefined();
    expect(getActiveSourceBadge(true, "token_plan", true)).toBe("使用中");
    expect(getActiveSourceBadge(true, "minimax_api_key", true)).toBe("未启用");
  });

  it("formats reset countdowns at and below the one-minute boundary", () => {
    const now = 1_000_000;
    expect(formatResetLabel(now + 59_000, now)).toBe("59秒");
    expect(formatResetLabel(now + 60_000, now)).toBe("1分后重置");
    expect(formatResetLabel(now, now)).toBeUndefined();
  });

  it("preserves all saved headers unless an individual row is removed or renamed", () => {
    const original = ["X-First", "X-Second"];
    expect(projectProviderHeaders([
      { id: "1", name: "X-First", value: "one", persistedName: "X-First" },
      { id: "2", name: "X-Second", value: "", persistedName: "X-Second" },
    ], original)).toEqual({ headers: { "X-First": "one" } });
    expect(projectProviderHeaders([
      { id: "1", name: "X-Renamed", value: "new", persistedName: "X-First" },
    ], original)).toEqual({ headers: { "X-Renamed": "new" }, removeHeaders: ["X-First", "X-Second"] });
  });
});

describe("account tab gating", () => {
  it("leaves the account tab clickable while the unimplemented tabs stay disabled", () => {
    // The account panel is fully implemented (email row, sign-out button,
    // sign-out error region), so it must not carry the `disabled` gate the
    // not-yet-built panels still need.
    const account = DESKTOP_SETTINGS_TABS.find((tab) => tab.key === "account");
    expect(account?.disabled).toBeUndefined();
    for (const key of ["voice", "shortcuts", "custom-instructions", "connection", "coding", "worktree"])
      expect(DESKTOP_SETTINGS_TABS.find((tab) => tab.key === key)?.disabled).toBe(true);
  });

  it("keeps the account tab reachable through the settings search", () => {
    expect(filterSettingsTabs("账户").map((tab) => tab.key)).toContain("account");
  });
});
