// Which theme the app should use, and which settings tabs are shown.
//
// Carved out of `components/SettingsModal.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **5 declarations**, 2 functions, 3 types and constants they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

export type SettingsTabKey = "desktop" | "shortcuts" | "voice" | "custom-instructions" | "browser" | "usage" | "connection" | "account" | "coding" | "worktree" | "archived";

export interface SettingsTabDefinition { readonly key: SettingsTabKey; readonly group: "preferences" | "management" | "coding" | "archived"; readonly label: string; readonly icon: string; readonly disabled?: boolean; }

export const DESKTOP_SETTINGS_TABS: readonly SettingsTabDefinition[] = [
{ key: "desktop", group: "preferences", label: "通用", icon: "desktop" }, { key: "voice", group: "preferences", label: "语音", icon: "voice", disabled: true }, { key: "shortcuts", group: "preferences", label: "快捷键", icon: "shortcuts" }, { key: "custom-instructions", group: "preferences", label: "个性化", icon: "custom-instructions" },
  // The browser switches were under the browser panel, in the tool area. A
  // setting that lives in a panel is a setting nobody finds without opening
  // that panel first, so they are a page of their own — under 偏好, next to
  // the other preferences.
  { key: "browser", group: "preferences", label: "浏览器", icon: "browser" },
  { key: "usage", group: "management", label: "用量与模型", icon: "chart" },
  // The SSH host management is here on the Desktop too (`设置 > 连接 > SSH`), and the 远程 page's
  // SSH link opens the same surface.
  { key: "connection", group: "management", label: "连接", icon: "link" },
  { key: "account", group: "management", label: "账户", icon: "user" }, { key: "coding", group: "coding", label: "代码审查", icon: "coding" }, { key: "worktree", group: "coding", label: "工作树", icon: "worktree" }, { key: "archived", group: "archived", label: "已归档任务", icon: "archived" },
];

export function resolveThemePreference(preference: string, systemDark: boolean): "light" | "dark" { return preference === "system" ? (systemDark ? "dark" : "light") : preference === "dark" ? "dark" : "light"; }

export function filterSettingsTabs(query: string): readonly SettingsTabDefinition[] { const needle = query.trim().toLowerCase(); return DESKTOP_SETTINGS_TABS.filter((tab) => !needle || `${tab.label} ${tab.key}`.toLowerCase().includes(needle)); }

export const SETTINGS_GROUPS = [{ key: "preferences", label: "偏好" }, { key: "management", label: "管理" }, { key: "coding", label: "编码" }, { key: "archived", label: "归档" }] as const;
