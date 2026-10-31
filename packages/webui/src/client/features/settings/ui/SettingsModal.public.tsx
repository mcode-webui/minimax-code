// The settings business's published dialog component.
//
// `account/ui/UserMenu.tsx` is the only cross-business consumer: it mounts this
// dialog as the account menu's 「设置」 action. Every other settings surface
// (`WebuiWorktreePanel`, `GenericPage`, the constants `SETTINGS_GROUPS` and
// friends) is the settings business's own concern and stays in the private
// sibling `SettingsModal.tsx`.
//
// This module is `.public` because the account business needs the dialog
// component to render the settings page from its user menu. The `.public`
// suffix is a publication marker; the dialog and the pages it mounts are
// unchanged, and every other settings surface stays in the private sibling.

import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { IconArchive, IconArrowLeft, IconBraces, IconBrowser, IconChartBar, IconChevronDown, IconCode, IconGitBranch, IconLayoutDashboard, IconLink, IconMessageCircle, IconMicrophone, IconSearch, IconTrash, IconUserCircle, IconX, IconBook, IconCircle, IconCircleDot } from "@tabler/icons-react";
import type { WebuiSessionListItem } from "../../../../shared/contracts/session.js";
import type { WebuiVersionInfo } from "../../../../shared/contracts/version.js";
import {
  buildWebuiModelSelectionRequest,
  webuiModelFromOptionValue,
} from "../../../features/models/contracts/model-selection.js";
import { basenamePath } from "../../../projection/common/paths.js";
import {
  groupWebuiWorktreeWorkspaces,
  selectWebuiPrimaryWorkspace,
  selectWebuiWorktreeWorkspaces,
  type WebuiWorktreeSourceSession,
  type WebuiWorktreeWorkspace,
} from "../../../features/sessions/projection/worktree-state.public.js";
import { ToggleSwitch as Switch } from "../../../ui/ToggleSwitch.js";
import { FolderIcon, SearchIcon } from "../../../ui/settings-glyphs.js";
import { SettingsDivider, SettingsPage, SettingsRow, SettingsSection } from "../../../ui/settings-layout.js";
import { SettingsButton as Button } from "./settings-atoms.js";
import { ReviewSettingsPage } from "../../../features/review/ui/ReviewSettingsPage.public.js";
import { AccountUsageSettings, AccountUsageShareAction } from "./AccountUsageSettings.js";
import { UsageModelSettings } from "./UsageModelSettings.js";
import { PersonalizationSettings } from "./PersonalizationSettings.js";
import type { MemoryHandoff } from "../contracts/memory-handoff.js";
import {
  useWebuiArchivedSessionsState,
  useWebuiSessionWorkflows,
  useWebuiSettingsWorkflows,
  useWebuiModelsWorkflows,
  useWebuiModelsWorkflowsState,
  useWebuiSettingsWorkflowsState,
} from "../../../bindings/use-query-state.js";
import {
  useWebuiAccountWorkflows,
  useWebuiAccountWorkflowsState,
} from "../../../features/account/bindings/use-account-workflows.public.js";
import { useWebuiSessionStoreContext } from "../../../bindings/application-context.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { selectWebuiCatalogFlatPage } from "../../../features/sessions/application/session-catalog.public.js";
import { BrowserSettingsPage } from "../../browser/ui/BrowserSettingsPage.public.js";
import { SshPanel } from "../../ssh/ui/SshPanel.public.js";
import { useWebuiSshOwner } from "../../../bindings/ssh-owner-context.js";
import { resolveThemePreference, filterSettingsTabs, settingsGroups, settingsTabs, findSettingsSearchHit } from "../projection/settings-view.js";
import type { SettingsTabKey, SettingsSearchHit } from "../projection/settings-view.js";
import { SETTINGS_LANGUAGE_OPTIONS, SETTINGS_LOCALE_STORAGE_KEY, resolveSettingsLocale, settingsText } from "../projection/settings-locale.js";
import type { SettingsCopyKey, SettingsLocale } from "../projection/settings-locale.js";
import { DEFAULT_SHORTCUT_BINDINGS, parseShortcutBindings, serializeShortcutBindings, SHORTCUT_STORAGE_KEY } from "../../../projection/common/shortcuts.js";
import { ShortcutsSettings } from "./ShortcutsSettings.js";
import { WebuiZoneBoundary } from "../../../shell/WebuiZoneBoundary.js";
import { WebuiWorktreePanel } from "./SettingsModal.js";

const ICONS = {
  desktop: IconLayoutDashboard,
  browser: IconBrowser,
  voice: IconMicrophone,
  shortcuts: IconBraces,
  "custom-instructions": IconBook,
  chart: IconChartBar,
  link: IconLink,
  user: IconUserCircle,
  coding: IconCode,
  worktree: IconGitBranch,
  work: IconMessageCircle,
  archived: IconArchive,
  search: IconSearch,
  close: IconX,
  back: IconArrowLeft,
} as const;

function Icon({ name, size = 18 }: { readonly name: string; readonly size?: number }): ReactElement {
  const voice = name === "voice";
  const Glyph = ICONS[name as keyof typeof ICONS] ?? IconLayoutDashboard;
  return <Glyph aria-hidden="true" data-testid={voice ? "asr-mic-icon" : undefined} className="webui-settings-icon" size={size} stroke={1.4} />;
}
function stored(key: string, fallback: string, storage: ReturnType<typeof useWebuiBrowserCapabilities>["storage"]): string { return storage.getItem(key) ?? fallback; }
function Select({ value, onChange, disabled = false, wide = false, testId, options }: { readonly value: string; readonly onChange?: (value: string) => void; readonly disabled?: boolean; readonly wide?: boolean; readonly testId?: string; readonly options?: readonly { readonly value: string; readonly label: string }[] }): ReactElement { return <label className={`webui-ant-select${wide ? " is-wide" : ""}`} data-testid={testId}><select value={value} disabled={disabled} onChange={(event) => onChange?.(event.target.value)}>{options ? options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>) : <option>{value}</option>}</select><IconChevronDown aria-hidden="true" size={16} stroke={1.5} /></label>; }

/** Compatibility alias for the settings modal's capability surface.
 *
 *  The modal does not accept a `transport` prop — it reads the application
 *  owners directly — but the name is kept exported for consumers that used to
 *  thread that prop through (`UserMenu`). It now names the settings owner's
 *  command surface. */
export interface SettingsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly dataDir?: string;
  readonly version?: WebuiVersionInfo;
  readonly sessionId?: string;
  /** Workspace the code-review page reads its change set from. Every
   *  workspace review operation is keyed by an absolute directory, so without
   *  this the page has nothing to ask about. */
  readonly workspaceDir?: string;
  /** Opens a file at a line. This is what makes a review line a real jump
   *  rather than decoration: the editor receives the path and the new-side
   *  line number the diff projection resolved. */
  readonly onOpenFileLine?: (path: string, line: number) => void;
  /** 「在会话中创建」 on the memory manager. Not a transport capability: the
   *  memory is already client-side, and what is missing is a composer to put it
   *  in, which only the shell owns. Sibling of `getSigninPanel` upstream. */
  readonly onCreateMemorySession?: (input: MemoryHandoff) => void;
}

export function SettingsModal({ open, onClose, dataDir, version, sessionId, workspaceDir, onOpenFileLine, onCreateMemorySession }: SettingsModalProps): ReactElement | null {
  const { dom, storage } = useWebuiBrowserCapabilities();
  // The modal reads the four application owners directly: the `transport` prop
  // and its bound capability map are gone, and so is every business request
  // this component used to hold.
  const settingsWorkflows = useWebuiSettingsWorkflows();
  const settingsState = useWebuiSettingsWorkflowsState();
  // The model list is `models`': read and select through that owner.
  const modelsWorkflows = useWebuiModelsWorkflows();
  const modelsState = useWebuiModelsWorkflowsState();
  const accountWorkflows = useWebuiAccountWorkflows();
  const accountState = useWebuiAccountWorkflowsState();
  const sessionWorkflows = useWebuiSessionWorkflows();
  const archivedState = useWebuiArchivedSessionsState();

  const models = modelsState.models.value ?? [];
  const account = accountState.account.value;
  const archived = archivedState.sessions;
  const sshOwner = useWebuiSshOwner();
  const [active, setActive] = useState<SettingsTabKey>("desktop"); const [query, setQuery] = useState(""); const [theme, setTheme] = useState(() => stored("webui-theme", "light", storage)); const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches); const [locale, setLocale] = useState(() => resolveSettingsLocale(stored(SETTINGS_LOCALE_STORAGE_KEY, "zh", storage))); const [wrap, setWrap] = useState(() => stored("file_line_wrap", "true", storage) === "true"); const [newTab, setNewTab] = useState(() => stored("file_open_in_new_tab", "false", storage) === "true"); const [contextWindow, setContextWindow] = useState(() => stored("webui-context-window-usage", "true", storage) !== "false"); const [shortcuts, setShortcuts] = useState(() => parseShortcutBindings(storage.getItem(SHORTCUT_STORAGE_KEY))); const actualTheme = resolveThemePreference(theme, systemDark);
  useEffect(() => { if (typeof window === "undefined" || !window.matchMedia) return; const media = window.matchMedia("(prefers-color-scheme: dark)"); const listener = () => setSystemDark(media.matches); listener(); media.addEventListener?.("change", listener); return () => media.removeEventListener?.("change", listener); }, []);
  useEffect(() => { dom.updateDocumentAppearance(actualTheme, locale); storage.setItem("webui-theme", theme); storage.setItem(SETTINGS_LOCALE_STORAGE_KEY, locale); storage.setItem("file_line_wrap", String(wrap)); storage.setItem("file_open_in_new_tab", String(newTab)); storage.setItem("webui-context-window-usage", String(contextWindow)); storage.setItem(SHORTCUT_STORAGE_KEY, serializeShortcutBindings(shortcuts)); dom.dispatchContextWindowUsageChange(); }, [actualTheme, contextWindow, dom, locale, newTab, shortcuts, storage, theme, wrap]);  useEffect(() => { if (!open) return; void modelsWorkflows?.loadModels(sessionId); void accountWorkflows?.loadAccount(sessionId); void sessionWorkflows?.loadArchived(); }, [accountWorkflows, modelsWorkflows, open, sessionId, sessionWorkflows]);
  // The language the page is shown in, and the copy that follows from it: the
  // registry keeps the structure, the pack holds the words.
  const t = (key: SettingsCopyKey, params?: Readonly<Record<string, string>>): string => settingsText(locale, key, params);
  const tabs = useMemo(() => settingsTabs(locale), [locale]);
  const visibleTabs = useMemo(() => filterSettingsTabs(query, locale), [query, locale]);
  const searchHit = useMemo(() => findSettingsSearchHit(query), [query]);
  // A search that matched a row takes the reader to the page that owns it. The
  // dependency is the hit and not the active tab, so a reader who then clicks
  // another tab in the sidebar keeps their own choice.
  useEffect(() => { if (searchHit) setActive((current) => (current === searchHit.tabKey ? current : searchHit.tabKey)); }, [searchHit]);
  if (!open) return null; const selected = models.find((model) => model.selected); const modelValue = selected ? `${selected.providerId}/${selected.modelId}/${selected.variant ?? ""}` : ""; const groups = settingsGroups(locale).map((group) => ({ ...group, tabs: visibleTabs.filter((tab) => tab.group === group.key) })).filter((group) => group.tabs.length > 0); const label = tabs.find((tab) => tab.key === active)?.label;
  // The request is Models' to build: the option value and the selection are two
  // halves of one round trip, and this panel used to spell its own thinner copy
  // of the builder, so a field added to a selection could reach the composer and
  // not arrive here.
  const changeModel = async (value: string) => { const model = webuiModelFromOptionValue(models, value); if (!model || !modelsWorkflows) return; await modelsWorkflows.selectModel(buildWebuiModelSelectionRequest(model, {}, sessionId)); };
  const handleDeleteAllArchived = async () => { if (!sessionWorkflows || !archived.length || !window.confirm("确定删除全部已归档任务吗？此操作无法撤销")) return; const ids = archived.map((session) => session.sessionId); try { await Promise.all(ids.map((id) => sessionWorkflows.removeArchived(id))); } catch (error) { window.alert(`删除失败：${error instanceof Error ? error.message : String(error)}`); } };
  return <div role="dialog" aria-modal="true" aria-label={t("shell.dialogLabel")} className="webui-settings-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="webui-settings-modal" onMouseDown={(event) => event.stopPropagation()}><aside className="webui-settings-sidebar"><button type="button" aria-label={t("shell.backLabel")} className="webui-settings-back" onClick={onClose}><Icon name="back" /><span>{t("shell.back")}</span></button><div className="webui-settings-search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("shell.searchPlaceholder")} aria-label={t("shell.searchLabel")} />{query ? <button type="button" aria-label={t("shell.clearSearch")} onClick={() => setQuery("")}><Icon name="close" /></button> : null}</div><nav aria-label={t("shell.navLabel")} className="webui-settings-nav">{groups.length ? groups.map((group) => <div key={group.key} className="webui-settings-group"><h3>{group.label}</h3>{group.tabs.map((tab) => <button type="button" key={tab.key} data-menu-key={tab.key} disabled={tab.disabled} className={`webui-settings-nav-item menu-item${active === tab.key ? " is-active active" : ""}`} aria-current={active === tab.key ? "page" : undefined} onClick={() => setActive(tab.key)}><span className="menu-icon"><Icon name={tab.icon} /></span><span className="menu-label">{tab.label}</span></button>)}</div>) : <p className="webui-settings-no-results">{t("shell.noResults")}</p>}</nav></aside><main className="webui-settings-content" key={active}><header className="webui-settings-content-header"><h2>{label}</h2>{active === "archived" ? <button type="button" className="webui-archived-delete-all" disabled={!archived.length || !sessionWorkflows} onClick={() => void handleDeleteAllArchived()}><TrashIcon />{t("shell.deleteAll")}</button> : null}{active === "account" ? <AccountUsageShareAction /> : null}</header><WebuiZoneBoundary zone={active === "coding" ? "review" : "settings"}>{active === "desktop" ? <GenericPage theme={theme} setTheme={setTheme} wrap={wrap} setWrap={setWrap} newTab={newTab} setNewTab={setNewTab} contextWindow={contextWindow} setContextWindow={setContextWindow} version={version?.version ?? ""} locale={locale} setLocale={setLocale} searchHit={searchHit} /> : null}{active === "custom-instructions" ? <PersonalizationSettings {...(onCreateMemorySession ? { onCreateInSession: onCreateMemorySession } : {})} /> : null}{active === "shortcuts" ? <ShortcutsSettings bindings={shortcuts} onChange={setShortcuts} onReset={() => setShortcuts(DEFAULT_SHORTCUT_BINDINGS)} /> : null}{active === "browser" ? <BrowserSettingsPage /> : null}{active === "usage" ? <UsageModelSettings sessionId={sessionId} /> : null}{active === "connection" && sshOwner ? <SshPanel owner={sshOwner} /> : null}{active === "account" ? <AccountUsageSettings /> : null}{active === "archived" ? <ArchivedSessionsPage sessions={archived} canDelete={Boolean(sessionWorkflows)} canUnarchive={Boolean(sessionWorkflows?.canUnarchive)} onDelete={async (id) => { if (!sessionWorkflows) return; await sessionWorkflows.removeArchived(id); }} onUnarchive={async (id) => { await sessionWorkflows?.unarchive(id); }} /> : null}{active === "coding" ? <ReviewSettingsPage workspaceDir={workspaceDir} onOpenFileLine={onOpenFileLine} /> : null}{active === "worktree" ? <SettingsWorktreePage /> : null}{active !== "desktop" && active !== "usage" && active !== "account" && active !== "archived" && active !== "coding" && active !== "worktree" && active !== "custom-instructions" && active !== "browser" && active !== "shortcuts" && active !== "connection" ? <div className="webui-settings-empty-panel" aria-label="空设置面板" /> : null}{active === "desktop" && dataDir ? <p className="webui-settings-data-dir">{dataDir}</p> : null}</WebuiZoneBoundary></main></section></div>;
}

function GenericPage({ theme, setTheme, wrap, setWrap, newTab, setNewTab, contextWindow, setContextWindow, version, locale, setLocale, searchHit }: { readonly theme: string; readonly setTheme: (value: string) => void; readonly wrap: boolean; readonly setWrap: (value: boolean) => void; readonly newTab: boolean; readonly setNewTab: (value: boolean) => void; readonly contextWindow: boolean; readonly setContextWindow: (value: boolean) => void; readonly version: string; readonly locale: SettingsLocale; readonly setLocale: (value: SettingsLocale) => void; readonly searchHit?: SettingsSearchHit }): ReactElement {
  const t = (key: SettingsCopyKey, params?: Readonly<Record<string, string>>): string => settingsText(locale, key, params);
  return <SettingsPage testId="content-body"><SettingsSection title={t("generic.section.mode")} testId="app-mode-section" bare><div data-testid="app-mode-options" className="webui-mode-options"><ModeCard testId="app-mode-option-coding" title={t("generic.mode.coding.title")} description={t("generic.mode.coding.description")} icon="coding" selected /><ModeCard testId="app-mode-option-work" title={t("generic.mode.work.title")} description={t("generic.mode.work.description")} icon="work" /></div></SettingsSection><SettingsSection title={t("generic.section.application")} testId="application-section"><Appearance theme={theme} setTheme={setTheme} locale={locale} /><LanguageRow locale={locale} setLocale={setLocale} highlighted={isSearchHit(searchHit, "generic.language.title")} /></SettingsSection><SettingsSection title={t("generic.section.link")} testId="link-open-destination-section"><SettingsRow title={t("generic.link.web.title")} description={t("generic.link.web.description")} testId="web-link-open-destination-row"><Select value={t("generic.link.builtinBrowser")} wide disabled testId="web-link-open-destination-row-select" /></SettingsRow><SettingsDivider /><SettingsRow title={t("generic.link.local.title")} description={t("generic.link.local.description")} testId="local-link-open-destination-row"><Select value={t("generic.link.builtinBrowser")} wide disabled testId="local-link-open-destination-row-select" /></SettingsRow></SettingsSection><SettingsSection title={t("generic.section.file")} testId="file-section"><SettingsRow title={t("generic.file.newTab.title")} description={t("generic.file.newTab.description")} testId="file-open-in-new-tab-switch"><Switch checked={newTab} onChange={setNewTab} label={t("generic.file.newTab.title")} /></SettingsRow><SettingsDivider /><SettingsRow title={t("generic.file.wrap.title")} description={t("generic.file.wrap.description")} testId="file-line-wrap-switch"><Switch checked={wrap} onChange={setWrap} label={t("generic.file.wrap.title")} /></SettingsRow></SettingsSection><SettingsSection title={t("generic.section.session")} testId="session-management-section"><SettingsRow title={t("generic.session.contextWindow.title")} testId="context-window-usage-switch"><Switch checked={contextWindow} onChange={setContextWindow} label={t("generic.session.contextWindow.title")} /></SettingsRow></SettingsSection><SettingsSection title={t("generic.section.agentControl")} testId="agent-control-permission-section"><SettingsRow title={t("generic.agent.autoOpenBrowser.title")} description={t("generic.agent.autoOpenBrowser.description")} testId="browser-use-auto-open-row"><Switch checked={false} label={t("generic.agent.autoOpenBrowser.title")} disabled testId="browser-use-auto-open-switch" /></SettingsRow></SettingsSection><SettingsSection title={t("generic.section.about")} testId="about-section"><SettingsRow title={t("generic.about.uploadLogs.title")} description={t("generic.about.uploadLogs.description")}><Button disabled>{t("generic.about.uploadLogs.button")}</Button></SettingsRow><SettingsDivider /><SettingsRow title={t("generic.about.version.title")} description={version}><Button variant="black" disabled>{t("generic.about.version.button")}</Button></SettingsRow></SettingsSection></SettingsPage>;
}
function Appearance({ theme, setTheme, locale }: { readonly theme: string; readonly setTheme: (value: string) => void; readonly locale: SettingsLocale }): ReactElement { const t = (key: SettingsCopyKey, params?: Readonly<Record<string, string>>): string => settingsText(locale, key, params); return <SettingsRow title={t("generic.appearance.title")} description={t("generic.appearance.description")} testId="mavis-settings-appearance-row"><div className="mavis-settings-theme-selector">{([["light", t("generic.theme.light"), "light.d3fbb1aa.svg"], ["dark", t("generic.theme.dark"), "dark.14c569ba.svg"], ["system", t("generic.theme.system"), "system.aba90841.svg"]]).map(([value, text, src]) => <button type="button" key={value} aria-pressed={theme === value} className="mavis-settings-theme-option" onClick={() => setTheme(value)}><span className={`mavis-settings-theme-preview${theme === value ? " is-selected" : ""}`}><span><img src={`/assets/img/${src}`} alt={t("generic.themePreviewAlt", { theme: text })} draggable="false" /></span></span><span>{text}</span></button>)}</div></SettingsRow>; }

/** Whether a row is the one the settings search matched.
 *
 * The hit names the row by its pack key, so a row that is marked is marked
 * because the reader's words found *that* row — not because a page happens to
 * be open. */
function isSearchHit(hit: SettingsSearchHit | undefined, key: SettingsCopyKey): boolean { return hit !== undefined && hit.tabKey === "desktop" && hit.copyKey === key; }

/** The language row: the one setting that decides what the rest of the page says.
 *
 * It sits in the 应用 section next to the appearance, because that is where a
 * reader looks for the settings that change the page rather than the work.
 *
 * The choice is written to `mavis-locale` by the modal's effect — the key the
 * page already read, so nothing else has to know about it — and the document's
 * `lang` attribute follows from the same value. The options are written in
 * their own language: a reader who cannot read the current interface language
 * is exactly the reader who needs this list. */
function LanguageRow({ locale, setLocale, highlighted }: { readonly locale: SettingsLocale; readonly setLocale: (value: SettingsLocale) => void; readonly highlighted: boolean }): ReactElement { const t = (key: SettingsCopyKey, params?: Readonly<Record<string, string>>): string => settingsText(locale, key, params); return <SettingsRow title={t("generic.language.title")} description={t("generic.language.description")} testId="mavis-settings-language-row" dataAttributes={highlighted ? { "data-search-hit": "true" } : undefined}><Select value={locale} options={SETTINGS_LANGUAGE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} onChange={(value) => setLocale(resolveSettingsLocale(value))} testId="mavis-settings-language-select" /></SettingsRow>; }
function ModeCard({ testId, title, description, icon, selected = false }: { readonly testId: string; readonly title: string; readonly description: string; readonly icon: string; readonly selected?: boolean }): ReactElement { return <button type="button" data-testid={testId} data-selected={selected} aria-pressed={selected} disabled className="webui-mode-card"><span className="webui-mode-inner"><span className="webui-mode-icon"><Icon name={icon} size={24} /></span><span className="webui-mode-copy"><strong data-testid={`${testId}-title`}>{title}</strong><span data-testid={`${testId}-description`}>{description}</span></span><span data-testid={`${testId}-radio`} className={`webui-mode-radio${selected ? " is-selected" : ""}`}>{selected ? <IconCircleDot aria-hidden="true" size={20} stroke={1.5} /> : <IconCircle aria-hidden="true" size={16} stroke={1.5} />}</span></span></button>; }
/** The worktree page: see which parallel experiment branches exist and switch
 * into one.
 *
 * Creating an isolated worktree already works from the rail's context menu;
 * this is the other half of the feature. The session list is read from the
 * session catalog the rail already loaded; grouping is done by
 * `groupWebuiWorktreeWorkspaces`, so the list a test asserts on is the same
 * list the page renders. */
function SettingsWorktreePage(): ReactElement {
  const store = useWebuiSessionStoreContext();
  const catalog = useSyncExternalStore(store.subscribe, () => store.getSnapshot().catalog, () => store.getSnapshot().catalog);
  const sessions = selectWebuiCatalogFlatPage(catalog).sessions as readonly WebuiWorktreeSourceSession[];
  const workspaces = groupWebuiWorktreeWorkspaces(sessions);
  const worktrees = selectWebuiWorktreeWorkspaces(workspaces);
  const primary = selectWebuiPrimaryWorkspace(workspaces);

  if (catalog.flat.error && sessions.length === 0) {
    return <WebuiWorktreePanel workspaces={workspaces} error={catalog.flat.error} />;
  }
  if (catalog.flat.loading && sessions.length === 0) {
    return <SettingsPage testId="settings-worktree-page" dataAttributes={{ "data-webui-worktree-state": "loading" }}>
      <p className="webui-review-loading" role="status">正在读取工作树…</p>
    </SettingsPage>;
  }
  return <WebuiWorktreePanel workspaces={workspaces} worktrees={worktrees} primary={primary} />;
}

/** Presentational half of the worktree page, split for the same reason as
 * `WebuiReviewPanel`: `renderToStaticMarkup` runs no effects, so a page that
 * only reaches its populated state through a fetch cannot be asserted on.
 *
 * The panel itself stays in the private sibling `SettingsModal.tsx`: the page
 * here imports it (intra-feature), and the worktree-panel test asserts on it
 * through the same private module. Both pieces belong to the settings
 * business; neither is consumed cross-business. */


function ArchivedSessionsPage({ sessions, canDelete, canUnarchive, onDelete, onUnarchive }: { readonly sessions: readonly WebuiSessionListItem[]; readonly canDelete: boolean; readonly canUnarchive: boolean; readonly onDelete: (id: string) => Promise<void>; readonly onUnarchive: (id: string) => Promise<void> }): ReactElement {
  const [search, setSearch] = useState("");
  const [actionError, setActionError] = useState("");
  const runDelete = async (id: string) => { try { setActionError(""); await onDelete(id); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };
  const runUnarchive = async (id: string) => { try { setActionError(""); await onUnarchive(id); } catch (error) { setActionError(error instanceof Error ? error.message : String(error)); } };
  const filtered = sessions.filter((session) => {
    const title = session.title || session.sessionId;
    const matchesSearch = !search.trim() || `${title} ${session.workspaceDir ?? ""}`.toLowerCase().includes(search.trim().toLowerCase());
    return matchesSearch;
  });
  const grouped = new Map<string, WebuiSessionListItem[]>();
  for (const session of filtered) {
    const key = session.workspaceDir?.trim() || "未关联项目";
    grouped.set(key, [...(grouped.get(key) ?? []), session]);
  }
  return <SettingsPage testId="settings-archived-page">
    {actionError ? <p role="alert" className="webui-archived-error">{actionError}</p> : null}
    <div className="webui-archived-filters">
      <label className="webui-archived-search"><SearchIcon /><input aria-label="搜索已归档聊天" placeholder="搜索已归档聊天" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    </div>
    {filtered.length ? [...grouped].map(([path, rows]) => <SettingsSection key={path} title={<><FolderIcon />{path === "未关联项目" ? path : basenamePath(path)}</>} actions={<span className="webui-archived-count">{rows.length} 个聊天</span>}>
      {rows.map((session, index) => <Fragment key={session.sessionId}>
        {index > 0 ? <SettingsDivider /> : null}
        <SettingsRow title={session.title || session.sessionId} description={<time>{formatArchivedDate(session.updatedAt)}</time>} testId="archived-session-row">
          <button type="button" className="webui-archived-icon-button" aria-label={`删除：${session.title || session.sessionId}`} title="删除" disabled={!canDelete} onClick={() => { if (window.confirm("确定删除这个已归档聊天吗？此操作无法撤销。")) void runDelete(session.sessionId); }}><TrashIcon /></button>
          <button type="button" className="webui-archived-unarchive" disabled={!canUnarchive} onClick={() => void runUnarchive(session.sessionId)}>取消归档</button>
        </SettingsRow>
      </Fragment>)}
    </SettingsSection>) : <p className="webui-archived-empty">{sessions.length ? "没有符合条件的聊天" : "暂无已归档聊天"}</p>}
  </SettingsPage>;
}
function formatArchivedDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(timestamp));
}
function TrashIcon(): ReactElement { return <IconTrash aria-hidden="true" size={16} stroke={1.4} />; }
