// The settings page's two language packs and the one way to read them.
//
// Why this module exists: the settings page's copy was hardcoded Chinese in the
// component that renders it, and `mavis-locale` was read by a `useState` that
// had no setter — the key was there, the read was there, and nothing a user
// could do ever wrote a different value. A language switch needs three things
// this module owns: the packs, a locale value, and a lookup that cannot fail
// in a way the caller has to handle.
//
// Why it lives in the settings business's projection folder: the copy is a
// derivation, not a capability — it is read, never written, and both the
// sidebar's tab list and the pages' own rows need it. The layer matrix lets a
// view module import another view module and a binding module import a view
// module, so a pack here reaches the registry and the dialog without a new
// dependency and without the platform layer reaching down into a business.
//
// The packs are Chinese and English. Chinese is the base language: it is the
// language the settings page was written in, and a key the English pack does
// not carry falls back to the Chinese text rather than to a raw key. A
// half-translated pack then reads as Chinese instead of as a bug.
//
// The scope is the settings page and nothing else. The conversation, the file
// panel and the workspace keep their own copy; a full extraction of the
// client's 8,000-odd Chinese characters is a different change with a different
// cost, and this module is shaped so that one can extend it (a third pack, more
// keys) without rewriting it.

export type SettingsLocale = "zh" | "en";

/**
 * The storage key the language choice lives under.
 *
 * The key already existed and was already written on every mount, so the
 * switch reuses it instead of inventing a second one: a user who has the app
 * open already has this key in their storage, and a second key would leave the
 * two disagreeing about the same choice.
 */
export const SETTINGS_LOCALE_STORAGE_KEY = "mavis-locale";

/**
 * The Chinese pack — the base language.
 *
 * Every string the settings page shows in Chinese lives here, so the page has
 * one copy of its words rather than one per call site. The keys are namespaced
 * by the surface that reads them (`tab.`, `shell.`, `generic.`) because a
 * flat namespace would let two surfaces claim the same word.
 */
const ZH_COPY = {
  // The sidebar's group headings.
  "group.preferences": "偏好",
  "group.management": "管理",
  "group.coding": "编码",
  "group.archived": "归档",
  // The sidebar's tab names.
  "tab.desktop": "通用",
  "tab.voice": "语音",
  "tab.shortcuts": "快捷键",
  "tab.custom-instructions": "个性化",
  "tab.browser": "浏览器",
  "tab.usage": "用量与模型",
  "tab.connection": "连接",
  "tab.account": "账户",
  "tab.coding": "代码审查",
  "tab.worktree": "工作树",
  "tab.archived": "已归档任务",
  // The dialog's own chrome.
  "shell.dialogLabel": "设置",
  "shell.back": "返回应用",
  "shell.backLabel": "返回",
  "shell.searchPlaceholder": "搜索设置...",
  "shell.searchLabel": "搜索设置",
  "shell.clearSearch": "清空设置搜索",
  "shell.navLabel": "设置分类",
  "shell.noResults": "没有匹配的设置",
  "shell.deleteAll": "全部删除",
  // The 通用 page: sections.
  "generic.section.mode": "模式",
  "generic.section.application": "应用",
  "generic.section.link": "链接",
  "generic.section.file": "文件",
  "generic.section.session": "会话管理",
  "generic.section.agentControl": "Agent 控制权限",
  "generic.section.about": "关于",
  // The 通用 page: the mode cards.
  "generic.mode.coding.title": "适用于编程开发",
  "generic.mode.coding.description": "保留技术细节与开发工具",
  "generic.mode.work.title": "适用于日常工作",
  "generic.mode.work.description": "同样强大，减少技术细节干扰",
  // The 通用 page: appearance.
  "generic.appearance.title": "外观",
  "generic.appearance.description": "选择应用的显示主题",
  "generic.theme.light": "浅色模式",
  "generic.theme.dark": "深色模式",
  "generic.theme.system": "跟随系统",
  "generic.themePreviewAlt": "{theme}预览",
  // The 通用 page: the language row.
  "generic.language.title": "语言",
  "generic.language.description": "选择设置页显示的语言",
  // The 通用 page: link destinations.
  "generic.link.web.title": "网页链接打开位置",
  "generic.link.web.description": "公开网页链接默认打开位置",
  "generic.link.local.title": "本地链接打开位置",
  "generic.link.local.description": "本地开发页面默认打开位置",
  "generic.link.builtinBrowser": "内置浏览器",
  // The 通用 page: files.
  "generic.file.newTab.title": "在新的标签页打开文件",
  "generic.file.newTab.description": "关闭后，默认复用未固定的文件标签页；已固定的标签页会保留。",
  "generic.file.wrap.title": "文件预览自动换行",
  "generic.file.wrap.description": "开启后，超出预览区域宽度的文本和代码会自动折行；关闭后可横向滚动查看。不修改文件内容。",
  // The 通用 page: session management.
  "generic.session.contextWindow.title": "显示上下文窗口使用情况",
  // The 通用 page: agent control.
  "generic.agent.autoOpenBrowser.title": "自动打开浏览器面板",
  "generic.agent.autoOpenBrowser.description": "Agent 操作网页时，自动打开右侧浏览器面板",
  // The 通用 page: about.
  "generic.about.uploadLogs.title": "上传日志",
  "generic.about.uploadLogs.description": "上传日志以协助排查问题",
  "generic.about.uploadLogs.button": "上传",
  "generic.about.version.title": "应用版本",
  "generic.about.version.button": "检查更新",
} as const;

/** Every key the settings page can ask for. */
export type SettingsCopyKey = keyof typeof ZH_COPY;

/**
 * The English pack.
 *
 * The type is the Chinese key set, so a key the English pack is missing is a
 * compile error rather than a silent fallback: the fallback in
 * `settingsCopyValue` is for a pack that lost a key at runtime, not for a pack
 * that was never finished. The unit suite asserts the same parity again, for
 * the case where the type is satisfied by a value the pack does not really
 * hold.
 */
const EN_COPY: Record<SettingsCopyKey, string> = {
  // The sidebar's group headings.
  "group.preferences": "Preferences",
  "group.management": "Management",
  "group.coding": "Coding",
  "group.archived": "Archived",
  // The sidebar's tab names.
  "tab.desktop": "General",
  "tab.voice": "Voice",
  "tab.shortcuts": "Shortcuts",
  "tab.custom-instructions": "Personalization",
  "tab.browser": "Browser",
  "tab.usage": "Usage & Models",
  "tab.connection": "Connection",
  "tab.account": "Account",
  "tab.coding": "Code Review",
  "tab.worktree": "Worktrees",
  "tab.archived": "Archived Tasks",
  // The dialog's own chrome.
  "shell.dialogLabel": "Settings",
  "shell.back": "Back to app",
  "shell.backLabel": "Back",
  "shell.searchPlaceholder": "Search settings...",
  "shell.searchLabel": "Search settings",
  "shell.clearSearch": "Clear settings search",
  "shell.navLabel": "Settings categories",
  "shell.noResults": "No matching settings",
  "shell.deleteAll": "Delete all",
  // The 通用 page: sections.
  "generic.section.mode": "Mode",
  "generic.section.application": "Application",
  "generic.section.link": "Links",
  "generic.section.file": "Files",
  "generic.section.session": "Session management",
  "generic.section.agentControl": "Agent control permissions",
  "generic.section.about": "About",
  // The 通用 page: the mode cards.
  "generic.mode.coding.title": "For programming and development",
  "generic.mode.coding.description": "Keeps technical detail and developer tooling",
  "generic.mode.work.title": "For everyday work",
  "generic.mode.work.description": "Just as capable, with less technical noise",
  // The 通用 page: appearance.
  "generic.appearance.title": "Appearance",
  "generic.appearance.description": "Choose how the app looks",
  "generic.theme.light": "Light mode",
  "generic.theme.dark": "Dark mode",
  "generic.theme.system": "Follow system",
  "generic.themePreviewAlt": "{theme} preview",
  // The 通用 page: the language row.
  "generic.language.title": "Language",
  "generic.language.description": "Choose the language the settings page is shown in",
  // The 通用 page: link destinations.
  "generic.link.web.title": "Where web links open",
  "generic.link.web.description": "Default location for public web links",
  "generic.link.local.title": "Where local links open",
  "generic.link.local.description": "Default location for local development pages",
  "generic.link.builtinBrowser": "Built-in browser",
  // The 通用 page: files.
  "generic.file.newTab.title": "Open files in a new tab",
  "generic.file.newTab.description": "When off, unpinned file tabs are reused; pinned tabs are kept.",
  "generic.file.wrap.title": "Wrap lines in file previews",
  "generic.file.wrap.description": "When on, text and code wider than the preview wrap automatically; when off, scroll sideways. File contents are not changed.",
  // The 通用 page: session management.
  "generic.session.contextWindow.title": "Show context window usage",
  // The 通用 page: agent control.
  "generic.agent.autoOpenBrowser.title": "Open the browser panel automatically",
  "generic.agent.autoOpenBrowser.description": "Open the browser panel on the right when the agent drives a web page",
  // The 通用 page: about.
  "generic.about.uploadLogs.title": "Upload logs",
  "generic.about.uploadLogs.description": "Upload logs to help diagnose a problem",
  "generic.about.uploadLogs.button": "Upload",
  "generic.about.version.title": "App version",
  "generic.about.version.button": "Check for updates",
};

/**
 * One pack: a key set whose values are strings, and whose absent keys are
 * `undefined` rather than a hole in the type. The `undefined` matters — it is
 * what makes the fallback in `settingsCopyValue` reachable rather than dead
 * code the compiler could rule out.
 */
export type SettingsCopyPack = Readonly<Record<string, string | undefined>>;

/** The two packs, read as one pair. */
export interface SettingsCopyPacks {
  readonly zh: SettingsCopyPack;
  readonly en: SettingsCopyPack;
}

/** The packs the settings page reads. */
export const SETTINGS_COPY_PACKS: SettingsCopyPacks = { zh: ZH_COPY, en: EN_COPY };

/**
 * The locale a stored value means.
 *
 * Anything that is not a Chinese tag is English, and anything unrecognised is
 * Chinese — the language the page was written in. A stored value that is not a
 * locale at all must not blank the page, and it must not silently read as
 * English either: a user whose storage was written by an older build has no
 * opinion about the language, and the page they know is the Chinese one.
 */
export function resolveSettingsLocale(raw: string | null | undefined): SettingsLocale {
  const value = (raw ?? "").trim().toLowerCase();
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("en")) return "en";
  return "zh";
}

/**
 * Reads one string.
 *
 * The locale's pack wins; a key the pack does not carry falls back to the
 * Chinese text, and a key neither pack carries falls back to the key itself —
 * which is visible, and therefore a bug someone can report, rather than a
 * blank the user cannot describe.
 *
 * The packs are a parameter so the fallback is a rule that can be tested
 * rather than a branch nothing can reach.
 */
export function settingsCopyValue(
  locale: SettingsLocale,
  key: string,
  packs: SettingsCopyPacks = SETTINGS_COPY_PACKS,
): string {
  return packs[locale][key] ?? packs.zh[key] ?? key;
}

/**
 * Reads one string and fills its placeholders.
 *
 * A placeholder is `{name}`; a name the caller did not supply is left as it
 * was written, so a missing parameter shows up as a literal `{name}` instead of
 * as an empty gap in a sentence.
 */
export function settingsText(
  locale: SettingsLocale,
  key: SettingsCopyKey,
  params?: Readonly<Record<string, string>>,
): string {
  const template = settingsCopyValue(locale, key);
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => params[name] ?? match);
}

/**
 * The languages the switch offers, each written in its own language.
 *
 * An endonym is the convention: a reader who cannot read the current interface
 * language is exactly the reader who needs this list, and "Deutsch" in a
 * German list is easier to recognise than "German".
 */
export const SETTINGS_LANGUAGE_OPTIONS: readonly { readonly value: SettingsLocale; readonly label: string }[] = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];
