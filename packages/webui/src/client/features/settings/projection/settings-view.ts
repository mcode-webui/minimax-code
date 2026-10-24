// Which theme the app should use, and which settings tabs are shown.
//
// Carved out of `components/SettingsModal.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **5 declarations**, 2 functions, 3 types and constants they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.
//
// The language work that came later does change one thing here: a tab's name
// is now read from the language pack (`settings-locale.ts`) rather than being
// a literal, and the registry keeps the Chinese name as its `label` so the
// registry still reads the way it always did. A second key, `labelKey`, is
// what a locale lookup reads — the pack holds the words, the registry holds
// the structure.

import {
  settingsText,
  type SettingsCopyKey,
  type SettingsLocale,
} from "./settings-locale.js";

export type SettingsTabKey = "desktop" | "shortcuts" | "voice" | "custom-instructions" | "browser" | "usage" | "connection" | "account" | "coding" | "worktree" | "archived";

/** The sidebar's group headings, in the order the sidebar shows them. */
export type SettingsGroupKey = "preferences" | "management" | "coding" | "archived";

export interface SettingsTabDefinition { readonly key: SettingsTabKey; readonly group: SettingsGroupKey; /** The tab's name in the page's base language. Read from the pack, so the registry and the pack cannot drift apart. */ readonly label: string; /** The pack key the name is read from when a locale is applied. */ readonly labelKey: SettingsCopyKey; readonly icon: string; readonly disabled?: boolean; }

export interface SettingsGroupDefinition { readonly key: SettingsGroupKey; readonly label: string; readonly labelKey: SettingsCopyKey; }

export const DESKTOP_SETTINGS_TABS: readonly SettingsTabDefinition[] = [
{ key: "desktop", group: "preferences", label: settingsText("zh", "tab.desktop"), labelKey: "tab.desktop", icon: "desktop" }, { key: "voice", group: "preferences", label: settingsText("zh", "tab.voice"), labelKey: "tab.voice", icon: "voice", disabled: true }, { key: "shortcuts", group: "preferences", label: settingsText("zh", "tab.shortcuts"), labelKey: "tab.shortcuts", icon: "shortcuts" }, { key: "custom-instructions", group: "preferences", label: settingsText("zh", "tab.custom-instructions"), labelKey: "tab.custom-instructions", icon: "custom-instructions" },
  // The browser switches were under the browser panel, in the tool area. A
  // setting that lives in a panel is a setting nobody finds without opening
  // that panel first, so they are a page of their own — under 偏好, next to
  // the other preferences.
  { key: "browser", group: "preferences", label: settingsText("zh", "tab.browser"), labelKey: "tab.browser", icon: "browser" },
  { key: "usage", group: "management", label: settingsText("zh", "tab.usage"), labelKey: "tab.usage", icon: "chart" },
  // The SSH host management is here on the Desktop too (`设置 > 连接 > SSH`), and the 远程 page's
  // SSH link opens the same surface.
  { key: "connection", group: "management", label: settingsText("zh", "tab.connection"), labelKey: "tab.connection", icon: "link" },
  { key: "account", group: "management", label: settingsText("zh", "tab.account"), labelKey: "tab.account", icon: "user" }, { key: "coding", group: "coding", label: settingsText("zh", "tab.coding"), labelKey: "tab.coding", icon: "coding" }, { key: "worktree", group: "coding", label: settingsText("zh", "tab.worktree"), labelKey: "tab.worktree", icon: "worktree" }, { key: "archived", group: "archived", label: settingsText("zh", "tab.archived"), labelKey: "tab.archived", icon: "archived" },
];

export const SETTINGS_GROUPS: readonly SettingsGroupDefinition[] = [
  { key: "preferences", label: settingsText("zh", "group.preferences"), labelKey: "group.preferences" },
  { key: "management", label: settingsText("zh", "group.management"), labelKey: "group.management" },
  { key: "coding", label: settingsText("zh", "group.coding"), labelKey: "group.coding" },
  { key: "archived", label: settingsText("zh", "group.archived"), labelKey: "group.archived" },
];

export function resolveThemePreference(preference: string, systemDark: boolean): "light" | "dark" { return preference === "system" ? (systemDark ? "dark" : "light") : preference === "dark" ? "dark" : "light"; }

/**
 * The row-level copy each tab's page carries.
 *
 * The search matches a tab on its own name, and a name is not what a reader
 * remembers about a setting: they remember the words on the row — 「语言」,
 * 「外观」, 「文件预览自动换行」. A setting whose row nobody can search for is
 * a setting nobody finds, which is exactly how the language row was
 * unreachable before this list existed.
 *
 * Only the 通用 page is listed. The other pages keep their own copy, in their
 * own components, and the language work covers the settings page — a list that
 * named rows this change does not translate would promise a search that could
 * not deliver.
 */
export const SETTINGS_TAB_ROW_COPY: Readonly<Record<SettingsTabKey, readonly SettingsCopyKey[]>> = {
  desktop: [
    "generic.section.mode",
    "generic.mode.coding.title", "generic.mode.coding.description",
    "generic.mode.work.title", "generic.mode.work.description",
    "generic.section.application",
    "generic.appearance.title", "generic.appearance.description",
    "generic.theme.light", "generic.theme.dark", "generic.theme.system",
    "generic.language.title", "generic.language.description",
    "generic.section.link",
    "generic.link.web.title", "generic.link.web.description",
    "generic.link.local.title", "generic.link.local.description",
    "generic.section.file",
    "generic.file.newTab.title", "generic.file.newTab.description",
    "generic.file.wrap.title", "generic.file.wrap.description",
    "generic.section.session",
    "generic.session.contextWindow.title",
    "generic.section.agentControl",
    "generic.agent.autoOpenBrowser.title", "generic.agent.autoOpenBrowser.description",
    "generic.section.about",
    "generic.about.uploadLogs.title", "generic.about.uploadLogs.description",
    "generic.about.version.title",
  ],
  voice: [], shortcuts: [], "custom-instructions": [], browser: [], usage: [], connection: [], account: [], coding: [], worktree: [], archived: [],
};

/** The tabs with their names in `locale`. */
export function settingsTabs(locale: SettingsLocale): readonly SettingsTabDefinition[] {
  return DESKTOP_SETTINGS_TABS.map((tab) => ({ ...tab, label: settingsText(locale, tab.labelKey) }));
}

/** The sidebar's groups with their names in `locale`. */
export function settingsGroups(locale: SettingsLocale): readonly SettingsGroupDefinition[] {
  return SETTINGS_GROUPS.map((group) => ({ ...group, label: settingsText(locale, group.labelKey) }));
}

/**
 * Everything the search matches a tab on: its name, its key, and the copy of
 * the rows its page carries.
 *
 * Both packs are searched, not only the one on screen. A reader who looks for
 * 「语言」 in an English page, or for "Language" in a Chinese one, is looking for
 * the same setting — and a search that only knew the current language would
 * answer 「没有匹配的设置」 to half of its own users.
 */
export function settingsTabSearchText(tab: SettingsTabDefinition): string {
  const rowCopy = SETTINGS_TAB_ROW_COPY[tab.key].flatMap((key) => [settingsText("zh", key), settingsText("en", key)]);
  return [tab.label, settingsText("zh", tab.labelKey), settingsText("en", tab.labelKey), tab.key, ...rowCopy].join(" ").toLowerCase();
}

export function filterSettingsTabs(query: string, locale: SettingsLocale = "zh"): readonly SettingsTabDefinition[] { const needle = query.trim().toLowerCase(); if (!needle) return settingsTabs(locale); return settingsTabs(locale).filter((tab) => settingsTabSearchText(tab).includes(needle)); }

/** A row the search matched, and the tab that owns it. */
export interface SettingsSearchHit { readonly tabKey: SettingsTabKey; readonly copyKey: SettingsCopyKey; }

/**
 * The row a search matched, if it matched a row rather than a tab.
 *
 * A tab match needs no help: the sidebar shows the tab and the reader clicks
 * it. A row match is different — the reader was looking for a setting they
 * saw on some page, and finding the page is only half of what they asked for.
 * This says which tab the row lives on, so the dialog can go there and mark
 * the row.
 */
export function findSettingsSearchHit(query: string): SettingsSearchHit | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;
  for (const tab of DESKTOP_SETTINGS_TABS) {
    for (const copyKey of SETTINGS_TAB_ROW_COPY[tab.key]) {
      const text = [settingsText("zh", copyKey), settingsText("en", copyKey)].join(" ").toLowerCase();
      if (text.includes(needle)) return { tabKey: tab.key, copyKey };
    }
  }
  return undefined;
}
