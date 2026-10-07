import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { WebuiModelEntry, WebuiSessionListItem, WebuiVersionInfo, WebuiWorkspaceReviewFileDiff } from "../../server/port.js";
import type { WebuiTransport } from "../contracts.js";
import {
  initialWebuiReviewState,
  isWebuiReviewFiltering,
  projectWebuiReviewLines,
  reduceWebuiReviewState,
  selectWebuiReviewVisibleFiles,
  webuiReviewLineTarget,
  WEBUI_REVIEW_DIFF_BATCH_SIZE,
  type WebuiReviewFile,
  type WebuiReviewState,
} from "../projection/review-state.js";
import {
  groupWebuiWorktreeWorkspaces,
  selectWebuiPrimaryWorkspace,
  selectWebuiWorktreeWorkspaces,
  type WebuiWorktreeSourceSession,
  type WebuiWorktreeWorkspace,
} from "../projection/worktree-state.js";
import {
  WEBUI_SHORTCUT_COMMANDS,
  WEBUI_SHORTCUT_OVERRIDES_KEY,
  findWebuiShortcutConflict,
  formatWebuiShortcut,
  parseWebuiShortcutOverrides,
  resetWebuiShortcutOverrides,
  resolveWebuiShortcutBindings,
  webuiShortcutFromEvent,
  type WebuiShortcutOverride,
} from "../projection/shortcut-state.js";
import { ToggleSwitch as Switch } from "./ToggleSwitch.js";
import { UsageModelSettings } from "./settings/UsageModelSettings.js";
import { PersonalizationSettings, type MemoryHandoff } from "./settings/PersonalizationSettings.js";

export type SettingsTabKey = "desktop" | "shortcuts" | "voice" | "custom-instructions" | "usage" | "connection" | "account" | "coding" | "worktree" | "archived";
export interface SettingsTabDefinition { readonly key: SettingsTabKey; readonly group: "preferences" | "management" | "coding" | "archived"; readonly label: string; readonly icon: string; readonly disabled?: boolean; }
export const DESKTOP_SETTINGS_TABS: readonly SettingsTabDefinition[] = [
{ key: "desktop", group: "preferences", label: "通用", icon: "desktop" }, { key: "voice", group: "preferences", label: "语音", icon: "voice", disabled: true }, { key: "shortcuts", group: "preferences", label: "快捷键", icon: "shortcuts" }, { key: "custom-instructions", group: "preferences", label: "个性化", icon: "custom-instructions" },
  { key: "usage", group: "management", label: "用量与模型", icon: "chart" }, { key: "connection", group: "management", label: "连接", icon: "link", disabled: true }, { key: "account", group: "management", label: "账户", icon: "user" }, { key: "coding", group: "coding", label: "代码审查", icon: "coding" }, { key: "worktree", group: "coding", label: "工作树", icon: "worktree" }, { key: "archived", group: "archived", label: "已归档任务", icon: "archived" },
];
export const SETTINGS_GROUPS = [{ key: "preferences", label: "偏好" }, { key: "management", label: "管理" }, { key: "coding", label: "编码" }, { key: "archived", label: "归档" }] as const;
export function resolveThemePreference(preference: string, systemDark: boolean): "light" | "dark" { return preference === "system" ? (systemDark ? "dark" : "light") : preference === "dark" ? "dark" : "light"; }
export function filterSettingsTabs(query: string): readonly SettingsTabDefinition[] { const needle = query.trim().toLowerCase(); return DESKTOP_SETTINGS_TABS.filter((tab) => !needle || `${tab.label} ${tab.key}`.toLowerCase().includes(needle)); }

const ICONS: Record<string, string> = { desktop: "M14.9996 3.56689H4.99963C3.747 3.56689 2.73303 4.581 2.73303 5.8335V12.938L1.7301 15.189C1.61993 15.408 1.66322 16.3808 2.31799 17.0884H16.983C18.3361 16.3808 18.3787 15.4072 18.2682 15.188L17.2662 12.938V5.8335C17.2662 4.581 16.2522 3.56689 14.9996 3.56689Z", voice: "M11.25 4.25C11.25 3.00736 10.2426 2 9 2C7.75736 2 6.75 3.00736 6.75 4.25V9.5C6.75 10.7426 7.75736 11.75 9 11.75C10.2426 11.75 11.25 10.7426 11.25 9.5V4.25ZM14.25 7.5V9C14.25 11.8995 11.8995 14.25 9 14.25C6.10051 14.25 3.75 11.8995 3.75 9V7.5M9 14.25V16.5M6.75 16.5H11.25", shortcuts: "M13.8768 13.1403H6.10529M2 5.59998C2 4.49541 2.89543 3.59998 4 3.59998H16C17.1046 3.59998 18 4.49541 18 5.59998V14.4C18 15.5045 17.1046 16.4 16 16.4H4C2.89543 16.4 2 15.5045 2 14.4V5.59998Z", "custom-instructions": "M5.24316 2.84784C5.24316 1.57385 6.64787 .800013 7.72461 1.48065L9.60449 3.33514L10.5469 4.78241L11.4404 4.40253C12.9336 3.47824 14.6993 3.09444 16.4414 3.31561V14.6672C14.7097 14.609 13.1971 14.3609 11.873 15.1232L10.2988 16.0295L9.25098 15.7307C7.60003 14.6279 5.89805 14.1654 4.07324 14.3644V4.47479Z", chart: "M2.86194 2.26236V15.5514C2.86194 16.0953 3.30396 16.5368 3.84788 16.5368H17.1373M6.82776 9.53873V13.9655M10.7926 4.44888V13.9655M14.7584 7.62076V13.9655", link: "M10.0002 1.97192A8.0283 8.0283 0 1 0 10.0002 18.0286A8.0283 8.0283 0 0 0 10.0002 1.97192ZM3.19849 10.5999H16.801", user: "M6.25 16.4965V15.25C6.25 14.8522 6.40804 14.4706 7.75 13.75H12.25C13.75 14.8522 13.592 14.4706 13.75 15.25V16.4965M17.5 10A7.5 7.5 0 1 1 2.5 10A7.5 7.5 0 0 1 17.5 10Z", coding: "M11.7852 3.57383L8.34082 16.4264M5.14453 5.74961L1.42969 9.46347L5.99219 14.027M14.0078 5.74961L18.5703 9.46347L14.0078 14.027", worktree: "M11.1538 1.82715V5.42676H10.7524V9.33691H13.9868C15.4225 9.33726 16.5864 10.5008 16.5864 11.9365V12.9736", work: "M7.33333 2.66667H12.6667C15.9804 2.66667 18.6667 5.35296 18.6667 8.66667C18.6667 11.9804 15.9804 14.6667 12.6667 14.6667H8.66667L4 18V14.1141C2.77778 13.0222 2 11.4259 2 9.66667C2 5.8 4.61111 2.66667 7.33333 2.66667Z", archived: "M16.0669 3.6062H3.13232C2.12081 3.6062 1.30127 4.42602 1.30127 5.43726V6.05347C1.30127 7.06489 2.12081 7.8855 3.13232 7.8855H16.0669V14.7683C16.0669 16.2334 14.657 17.4216 13.1919 17.4216H6.00635C4.54129 17.4216 3.354 16.2334 3.354 14.7683V7.8855", search: "m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4", close: "M6 6l12 12M18 6 6 18", back: "M9.57617 3.74332C9.81049 3.509 10.1905 3.509 10.4248 3.74332L3.74219 9.57632L9.57617 16.258C10.1906 16.492 10.1906 16.492 10.4248 16.258L5.61426 10.5998H15.834C16.165 10.5998 16.4336 10.3312 16.4336 10.0002C16.4336 9.66901 16.165 9.40092 15.834 9.40054H5.61426Z" };
export const SETTINGS_ICON_PATHS = ICONS;
export const GENERIC_SECTION_TEST_IDS = ["app-mode-section", "application-section", "link-open-destination-section", "file-section", "session-management-section", "agent-control-permission-section", "about-section"] as const;
export const GENERIC_RADIO_CONTRACT = { position: "absolute right-4 top-[22px]", accentToken: "icon_default_accent" } as const;
export const GENERIC_FILE_ROW_ORDER = ["file-open-in-new-tab-switch", "file-line-wrap-switch"] as const;
function Icon({ name, size = 18 }: { readonly name: string; readonly size?: number }): ReactElement {
  const voice = name === "voice";
  let shape: ReactNode;
  if (name === "link") {
    shape = <><circle cx="10" cy="10" r="8" /><path d="M2 10h16M10 2c-2 2.2-3 4.8-3 8s1 5.8 3 8m0-16c2 2.2 3 4.8 3 8s-1 5.8-3 8" /></>;
  } else if (name === "worktree") {
    shape = <><circle cx="10" cy="4" r="1.75" /><circle cx="4" cy="15" r="1.75" /><circle cx="10" cy="15" r="1.75" /><circle cx="16" cy="15" r="1.75" /><path d="M10 5.75V9M4 9h12M4 9v4.25M10 9v4.25M16 9v4.25" /></>;
  } else {
    shape = <path d={ICONS[name] ?? ICONS.desktop} fill="none" />;
  }
  return <svg aria-hidden="true" data-testid={voice ? "asr-mic-icon" : undefined} className="webui-settings-icon" width={size} height={size} viewBox={voice ? "0 0 18 18" : "0 0 20 20"} fill="none" stroke="currentColor" strokeWidth={voice ? "1.08" : "1.2"} strokeLinecap="round" strokeLinejoin="round">{shape}</svg>;
}
function stored(key: string, fallback: string): string { return typeof localStorage === "undefined" ? fallback : localStorage.getItem(key) ?? fallback; }
function Select({ value, onChange, disabled = false, wide = false, testId }: { readonly value: string; readonly onChange?: (value: string) => void; readonly disabled?: boolean; readonly wide?: boolean; readonly testId?: string }): ReactElement { return <label className={`webui-ant-select${wide ? " is-wide" : ""}`} data-testid={testId}><select value={value} disabled={disabled} onChange={(event) => onChange?.(event.target.value)}><option>{value}</option></select><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 6L8 10L4 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg></label>; }
function Button({ children, variant = "gray", disabled = false, onClick }: { readonly children: ReactNode; readonly variant?: "gray" | "black"; readonly disabled?: boolean; readonly onClick?: () => void }): ReactElement { return <button type="button" disabled={disabled} onClick={onClick} className={`webui-mavis-button webui-mavis-button-${variant}`}>{children}</button>; }
function SettingRow({ title, description, children, testId, disabled = false }: { readonly title: string; readonly description?: ReactNode; readonly children?: ReactNode; readonly testId?: string; readonly disabled?: boolean }): ReactElement { return <div data-testid={testId} className={`webui-generic-row${disabled ? " is-disabled" : ""}`} aria-disabled={disabled || undefined}><div className="webui-generic-row-copy"><strong>{title}</strong>{description ? <span>{description}</span> : null}</div><div className="webui-generic-row-control">{children}</div></div>; }
function Divider(): ReactElement { return <div className="webui-generic-divider"><span /></div>; }
function Section({ title, testId, children }: { readonly title: string; readonly testId?: string; readonly children: ReactNode }): ReactElement { return <section data-testid={testId} className="webui-generic-section"><h3>{title}</h3><div className="webui-generic-card">{children}</div></section>; }

/** Capability subset the settings modal actually reads: 9 transport
 *  members plus dataDir / version / sessionId. The single source of truth
 *  for capability shape is `WebuiTransport`; this `Pick<…>` keeps the modal's
 *  real dependency visible on the prop type instead of swallowing the full
 *  68-key contract. Optional semantics are preserved: every picked key
 *  remains `?` because the source field is optional. */
export type WebuiSettingsModalCapabilities = Pick<
  WebuiTransport,
  | "listModels"
  | "selectModel"
  | "getUsageQuota"
  | "getAccountStatus"
  | "beginAccountLogin"
  | "getAccountLoginStatus"
  | "cancelAccountLogin"
  | "listUserModelProviders"
  | "listArchivedSessions"
  | "archiveSession"
  | "getMiniMaxApiKeyStatus"
  | "signOut"
  | "deleteSession"
  | "createUserModelProvider"
  | "updateUserModelProvider"
  | "deleteUserModelProvider"
  | "testUserModelProvider"
  | "testUserModel"
  | "discoverUserModelsCandidate"
  | "saveUserModelProviderCandidate"
  | "listProviderPresets"
  | "upsertMiniMaxApiKey"
  | "getCodexOAuthStatus"
  | "getMiniMaxModelSource"
  | "setMiniMaxModelSource"
  | "testUserModelCandidate"
  | "revealModelProviderApiKey"
  | "startCodexOAuthLogin"
  | "cancelCodexOAuthLogin"
  | "refreshModels"
| "getWorkspaceReviewSummary"
  | "listWorkspaceReviewFileDiffs"
  | "searchWorkspaceReviewDiffs"
  | "loadSessions"
  | "getGlobalInstructions"
  | "setGlobalInstructions"
  | "getAgentMemory"
  | "setAgentMemory"
  | "getUserProfile"
  | "setUserProfile"
  | "getMemorySettings"
  | "setMemorySettings"
>;

interface SettingsModalProps {
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
  /** Capability source for the modal. Typed as the narrow contract so the
   *  modal cannot accidentally start reading members it does not consume. */
  readonly transport?: WebuiSettingsModalCapabilities;
  /** 「在会话中创建」 on the memory manager. Not a transport capability: the
   *  memory is already client-side, and what is missing is a composer to put it
   *  in, which only the shell owns. Sibling of `getSigninPanel` upstream. */
  readonly onCreateMemorySession?: (input: MemoryHandoff) => void;
}

export function SettingsModal({ open, onClose, dataDir, version, sessionId, workspaceDir, onOpenFileLine, transport, onCreateMemorySession }: SettingsModalProps): ReactElement | null {
  // The transport is optional. Each capability is optional too, so we bind
  // only when both are present; otherwise we surface `undefined` and let the
  // call sites do their existing null checks.
  const boundCapabilities = useMemo(() => ({
    listModels: transport?.listModels?.bind(transport),
    selectModel: transport?.selectModel?.bind(transport),
    getUsageQuota: transport?.getUsageQuota?.bind(transport),
    getAccountStatus: transport?.getAccountStatus?.bind(transport),
    listUserModelProviders: transport?.listUserModelProviders?.bind(transport),
    listArchivedSessions: transport?.listArchivedSessions?.bind(transport),
    archiveSession: transport?.archiveSession?.bind(transport),
    getMiniMaxApiKeyStatus: transport?.getMiniMaxApiKeyStatus?.bind(transport),
    signOut: transport?.signOut?.bind(transport),
    deleteSession: transport?.deleteSession?.bind(transport),
    createUserModelProvider: transport?.createUserModelProvider?.bind(transport),
    updateUserModelProvider: transport?.updateUserModelProvider?.bind(transport),
    deleteUserModelProvider: transport?.deleteUserModelProvider?.bind(transport),
    testUserModelProvider: transport?.testUserModelProvider?.bind(transport),
    testUserModel: transport?.testUserModel?.bind(transport),
    discoverUserModelsCandidate: transport?.discoverUserModelsCandidate?.bind(transport),
    saveUserModelProviderCandidate: transport?.saveUserModelProviderCandidate?.bind(transport),
    listProviderPresets: transport?.listProviderPresets?.bind(transport),
    upsertMiniMaxApiKey: transport?.upsertMiniMaxApiKey?.bind(transport),
    getCodexOAuthStatus: transport?.getCodexOAuthStatus?.bind(transport),
    getMiniMaxModelSource: transport?.getMiniMaxModelSource?.bind(transport),
    setMiniMaxModelSource: transport?.setMiniMaxModelSource?.bind(transport),
    testUserModelCandidate: transport?.testUserModelCandidate?.bind(transport),
    revealModelProviderApiKey: transport?.revealModelProviderApiKey?.bind(transport),
    startCodexOAuthLogin: transport?.startCodexOAuthLogin?.bind(transport),
    cancelCodexOAuthLogin: transport?.cancelCodexOAuthLogin?.bind(transport),
    refreshModels: transport?.refreshModels?.bind(transport),
getWorkspaceReviewSummary: transport?.getWorkspaceReviewSummary?.bind(transport),
    listWorkspaceReviewFileDiffs: transport?.listWorkspaceReviewFileDiffs?.bind(transport),
    searchWorkspaceReviewDiffs: transport?.searchWorkspaceReviewDiffs?.bind(transport),
    loadSessions: transport?.loadSessions?.bind(transport),
    getGlobalInstructions: transport?.getGlobalInstructions?.bind(transport),
    setGlobalInstructions: transport?.setGlobalInstructions?.bind(transport),
    getAgentMemory: transport?.getAgentMemory?.bind(transport),
    setAgentMemory: transport?.setAgentMemory?.bind(transport),
    getUserProfile: transport?.getUserProfile?.bind(transport),
    setUserProfile: transport?.setUserProfile?.bind(transport),
    getMemorySettings: transport?.getMemorySettings?.bind(transport),
    setMemorySettings: transport?.setMemorySettings?.bind(transport),
  }), [transport]);
  const {
    listModels, selectModel, getUsageQuota, getAccountStatus,
    listUserModelProviders, listArchivedSessions, archiveSession, getMiniMaxApiKeyStatus,
    signOut, deleteSession, createUserModelProvider, updateUserModelProvider,
    deleteUserModelProvider, testUserModelProvider, testUserModel,
    discoverUserModelsCandidate, saveUserModelProviderCandidate,
    listProviderPresets, upsertMiniMaxApiKey, getCodexOAuthStatus,
    getMiniMaxModelSource, setMiniMaxModelSource, testUserModelCandidate,
    revealModelProviderApiKey, startCodexOAuthLogin, cancelCodexOAuthLogin,
refreshModels,
    getWorkspaceReviewSummary, listWorkspaceReviewFileDiffs, searchWorkspaceReviewDiffs,
    loadSessions,
    getGlobalInstructions, setGlobalInstructions,
    getAgentMemory, setAgentMemory, getUserProfile, setUserProfile,
    getMemorySettings, setMemorySettings,
  } = boundCapabilities;
  const usageCapabilities: WebuiSettingsModalCapabilities = useMemo(() => ({
    getUsageQuota, getMiniMaxApiKeyStatus, listUserModelProviders, createUserModelProvider,
    updateUserModelProvider, deleteUserModelProvider, testUserModelProvider, testUserModel,
    discoverUserModelsCandidate, saveUserModelProviderCandidate, listProviderPresets,
    upsertMiniMaxApiKey, getCodexOAuthStatus, getMiniMaxModelSource, setMiniMaxModelSource,
    testUserModelCandidate, revealModelProviderApiKey, startCodexOAuthLogin,
    cancelCodexOAuthLogin, refreshModels,
  }), [boundCapabilities]);
  const [active, setActive] = useState<SettingsTabKey>("desktop"); const [query, setQuery] = useState(""); const [theme, setTheme] = useState(() => stored("webui-theme", "light")); const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches); const [language] = useState(() => stored("mavis-locale", "en")); const [wrap, setWrap] = useState(() => stored("file_line_wrap", "true") === "true"); const [newTab, setNewTab] = useState(() => stored("file_open_in_new_tab", "false") === "true"); const [contextWindow, setContextWindow] = useState(() => stored("webui-context-window-usage", "true") !== "false"); const [models, setModels] = useState<readonly WebuiModelEntry[]>([]); const [account, setAccount] = useState<Record<string, unknown>>(); const [archived, setArchived] = useState<readonly WebuiSessionListItem[]>([]); const [signOutError, setSignOutError] = useState<string>(); const actualTheme = resolveThemePreference(theme, systemDark);
  useEffect(() => { if (typeof window === "undefined" || !window.matchMedia) return; const media = window.matchMedia("(prefers-color-scheme: dark)"); const listener = () => setSystemDark(media.matches); listener(); media.addEventListener?.("change", listener); return () => media.removeEventListener?.("change", listener); }, []);
  useEffect(() => { if (typeof document === "undefined") return; document.documentElement.classList.toggle("dark", actualTheme === "dark"); document.documentElement.classList.toggle("light", actualTheme !== "dark"); document.documentElement.lang = language.startsWith("zh") ? "zh-CN" : "en"; localStorage?.setItem("webui-theme", theme); localStorage?.setItem("mavis-locale", language); localStorage?.setItem("file_line_wrap", String(wrap)); localStorage?.setItem("file_open_in_new_tab", String(newTab)); localStorage?.setItem("webui-context-window-usage", String(contextWindow)); window.dispatchEvent(new Event("webui-context-window-usage-change")); }, [actualTheme, contextWindow, language, newTab, theme, wrap]);
  useEffect(() => { if (!open) return; let cancelled = false; void listModels?.({ sessionId }).then((value) => { if (!cancelled && value) setModels(value); }).catch(() => undefined); void getAccountStatus?.({ sessionId }).then((value) => { if (!cancelled && value) setAccount(value); }).catch(() => undefined); void listArchivedSessions?.().then((value) => { if (!cancelled && value) setArchived(value.sessions); }).catch(() => undefined); return () => { cancelled = true; }; }, [getAccountStatus, listArchivedSessions, listModels, open, sessionId]);
  const visibleTabs = useMemo(() => filterSettingsTabs(query), [query]); if (!open) return null; const selected = models.find((model) => model.selected); const modelValue = selected ? `${selected.providerId}/${selected.modelId}/${selected.variant ?? ""}` : ""; const groups = SETTINGS_GROUPS.map((group) => ({ ...group, tabs: visibleTabs.filter((tab) => tab.group === group.key) })).filter((group) => group.tabs.length > 0); const label = DESKTOP_SETTINGS_TABS.find((tab) => tab.key === active)?.label;
  const changeModel = async (value: string) => { const model = models.find((candidate) => `${candidate.providerId}/${candidate.modelId}/${candidate.variant ?? ""}` === value); if (!model || !selectModel) return; await selectModel({ providerId: model.providerId, modelId: model.modelId, ...(model.variant ? { variant: model.variant } : {}), ...(sessionId ? { sessionId } : {}) }); }; const handleSignOut = async () => { if (!signOut) return; try { setSignOutError(undefined); await signOut(); onClose(); } catch (error) { setSignOutError(error instanceof Error ? error.message : String(error)); } };
  const handleDeleteAllArchived = async () => { if (!deleteSession || !archived.length || !window.confirm("确定删除全部已归档任务吗？此操作无法撤销。")) return; const ids = archived.map((session) => session.sessionId); try { await Promise.all(ids.map((id) => deleteSession({ id }))); setArchived([]); } catch (error) { window.alert(`删除失败：${error instanceof Error ? error.message : String(error)}`); } };
  return <div role="dialog" aria-modal="true" aria-label="设置" className="webui-settings-mask" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="webui-settings-modal" onMouseDown={(event) => event.stopPropagation()}><aside className="webui-settings-sidebar"><button type="button" aria-label="返回" className="webui-settings-back" onClick={onClose}><Icon name="back" /><span>返回应用</span></button><div className="webui-settings-search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索设置..." aria-label="搜索设置" />{query ? <button type="button" aria-label="清空设置搜索" onClick={() => setQuery("")}><Icon name="close" /></button> : null}</div><nav aria-label="设置分类" className="webui-settings-nav">{groups.length ? groups.map((group) => <div key={group.key} className="webui-settings-group"><h3>{group.label}</h3>{group.tabs.map((tab) => <button type="button" key={tab.key} data-menu-key={tab.key} disabled={tab.disabled} className={`webui-settings-nav-item menu-item${active === tab.key ? " is-active active" : ""}`} aria-current={active === tab.key ? "page" : undefined} onClick={() => setActive(tab.key)}><span className="menu-icon"><Icon name={tab.icon} /></span><span className="menu-label">{tab.label}</span></button>)}</div>) : <p className="webui-settings-no-results">没有匹配的设置</p>}</nav></aside><main className="webui-settings-content" key={active}><header className="webui-settings-content-header"><h2>{label}</h2>{active === "archived" ? <button type="button" className="webui-archived-delete-all" disabled={!archived.length || !deleteSession} onClick={() => void handleDeleteAllArchived()}><TrashIcon />全部删除</button> : null}</header>{active === "desktop" ? <GenericPage theme={theme} setTheme={setTheme} wrap={wrap} setWrap={setWrap} newTab={newTab} setNewTab={setNewTab} contextWindow={contextWindow} setContextWindow={setContextWindow} version={version?.version ?? ""} /> : null}{active === "custom-instructions" ? <PersonalizationSettings getGlobalInstructions={getGlobalInstructions} setGlobalInstructions={setGlobalInstructions} getAgentMemory={getAgentMemory} setAgentMemory={setAgentMemory} getUserProfile={getUserProfile} setUserProfile={setUserProfile} getMemorySettings={getMemorySettings} setMemorySettings={setMemorySettings} {...(onCreateMemorySession ? { onCreateInSession: onCreateMemorySession } : {})} /> : null}{active === "usage" ? <UsageModelSettings capabilities={usageCapabilities} sessionId={sessionId} /> : null}{active === "account" ? <div className="webui-settings-panels"><SettingPanel title="账户"><SettingRow title="账户信息" description={typeof account?.email === "string" ? account.email : ""} /><Button disabled={!signOut} onClick={handleSignOut}>退出登录</Button>{signOutError ? <p role="alert" className="webui-settings-error">{signOutError}</p> : null}</SettingPanel></div> : null}{active === "archived" ? <ArchivedSessionsPage sessions={archived} canDelete={Boolean(deleteSession)} canUnarchive={Boolean(archiveSession)} onDelete={async (id) => { if (!deleteSession) return; await deleteSession({ id }); setArchived((items) => items.filter((item) => item.sessionId !== id)); }} onUnarchive={async (id) => { if (!archiveSession) return; await archiveSession({ id, archived: false }); setArchived((items) => items.filter((item) => item.sessionId !== id)); }} /> : null}{active === "coding" ? <SettingsReviewPage workspaceDir={workspaceDir} onOpenFileLine={onOpenFileLine} loadSessions={loadSessions} getWorkspaceReviewSummary={getWorkspaceReviewSummary} listWorkspaceReviewFileDiffs={listWorkspaceReviewFileDiffs} searchWorkspaceReviewDiffs={searchWorkspaceReviewDiffs} /> : null}{active === "worktree" ? <SettingsWorktreePage loadSessions={loadSessions} /> : null}{active === "shortcuts" ? <SettingsShortcutsPage /> : null}{active !== "desktop" && active !== "usage" && active !== "account" && active !== "archived" && active !== "coding" && active !== "worktree" && active !== "shortcuts" && active !== "custom-instructions" ? <div className="webui-settings-empty-panel" aria-label="空设置面板" /> : null}{active === "desktop" && dataDir ? <p className="webui-settings-data-dir">{dataDir}</p> : null}</main></section></div>;
}

function GenericPage({ theme, setTheme, wrap, setWrap, newTab, setNewTab, contextWindow, setContextWindow, version }: { readonly theme: string; readonly setTheme: (value: string) => void; readonly wrap: boolean; readonly setWrap: (value: boolean) => void; readonly newTab: boolean; readonly setNewTab: (value: boolean) => void; readonly contextWindow: boolean; readonly setContextWindow: (value: boolean) => void; readonly version: string }): ReactElement {
  return <div data-testid="content-body" className="webui-generic-page"><Section title="模式" testId="app-mode-section"><div data-testid="app-mode-options" className="webui-mode-options"><ModeCard testId="app-mode-option-coding" title="适用于编程开发" description="保留技术细节与开发工具" icon="coding" selected /><ModeCard testId="app-mode-option-work" title="适用于日常工作" description="同样强大，减少技术细节干扰" icon="work" /></div></Section><Section title="应用" testId="application-section"><Appearance theme={theme} setTheme={setTheme} /></Section><Section title="链接" testId="link-open-destination-section"><SettingRow title="网页链接打开位置" description="公开网页链接默认打开位置" testId="web-link-open-destination-row"><Select value="内置浏览器" wide disabled testId="web-link-open-destination-row-select" /></SettingRow><Divider /><SettingRow title="本地链接打开位置" description="本地开发页面默认打开位置" testId="local-link-open-destination-row"><Select value="内置浏览器" wide disabled testId="local-link-open-destination-row-select" /></SettingRow></Section><Section title="文件" testId="file-section"><SettingRow title="在新的标签页打开文件" description="关闭后，默认复用未固定的文件标签页；已固定的标签页会保留。" testId="file-open-in-new-tab-switch"><Switch checked={newTab} onChange={setNewTab} label="在新的标签页打开文件" /></SettingRow><Divider /><SettingRow title="文件预览自动换行" description="开启后，超出预览区域宽度的文本和代码会自动折行；关闭后可横向滚动查看。不修改文件内容。" testId="file-line-wrap-switch"><Switch checked={wrap} onChange={setWrap} label="文件预览自动换行" /></SettingRow></Section><Section title="会话管理" testId="session-management-section"><SettingRow title="显示上下文窗口使用情况" testId="context-window-usage-switch"><Switch checked={contextWindow} onChange={setContextWindow} label="显示上下文窗口使用情况" /></SettingRow></Section><Section title="Agent 控制权限" testId="agent-control-permission-section"><SettingRow title="自动打开浏览器面板" description="Agent 操作网页时，自动打开右侧浏览器面板" testId="browser-use-auto-open-row"><Switch checked={false} label="自动打开浏览器面板" disabled testId="browser-use-auto-open-switch" /></SettingRow></Section><Section title="关于" testId="about-section"><SettingRow title="上传日志" description="上传日志以协助排查问题"><Button disabled>上传</Button></SettingRow><Divider /><SettingRow title="应用版本" description={version}><Button variant="black" disabled>检查更新</Button></SettingRow></Section></div>;
}
function Appearance({ theme, setTheme }: { readonly theme: string; readonly setTheme: (value: string) => void }): ReactElement { return <SettingRow title="外观" description="选择应用的显示主题" testId="mavis-settings-appearance-row"><div className="mavis-settings-theme-selector">{([['light', '浅色模式', 'light.d3fbb1aa.svg'], ['dark', '深色模式', 'dark.14c569ba.svg'], ['system', '跟随系统', 'system.aba90841.svg']] as const).map(([value, text, src]) => <button type="button" key={value} aria-pressed={theme === value} className="mavis-settings-theme-option" onClick={() => setTheme(value)}><span className={`mavis-settings-theme-preview${theme === value ? " is-selected" : ""}`}><span><img src={`/assets/img/${src}`} alt={`${text}预览`} draggable="false" /></span></span><span>{text}</span></button>)}</div></SettingRow>; }
function ModeCard({ testId, title, description, icon, selected = false }: { readonly testId: string; readonly title: string; readonly description: string; readonly icon: string; readonly selected?: boolean }): ReactElement { return <button type="button" data-testid={testId} data-selected={selected} aria-pressed={selected} disabled className="webui-mode-card"><span className="webui-mode-inner"><span className="webui-mode-icon"><Icon name={icon} size={24} /></span><span className="webui-mode-copy"><strong data-testid={`${testId}-title`}>{title}</strong><span data-testid={`${testId}-description`}>{description}</span></span><span data-testid={`${testId}-radio`} className={`webui-mode-radio${selected ? " is-selected" : ""}`}><svg aria-hidden="true" width={selected ? 20 : 16} height={selected ? 20 : 16} viewBox="0 0 20 20" fill="none">{selected ? <><circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.25" /><circle cx="10" cy="10" r="4.5" fill="currentColor" /></> : <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.25" />}</svg></span></span></button>; }
function SettingPanel({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement { return <section className="webui-settings-panel"><h3>{title}</h3><div>{children}</div></section>; }
/** The subset of the settings capability contract the code-review page reads.
 *  Named so the page cannot quietly grow a dependency on a member the modal
 *  does not otherwise use. */
type WebuiSettingsReviewCapabilities = Pick<
  WebuiSettingsModalCapabilities,
  "getWorkspaceReviewSummary" | "listWorkspaceReviewFileDiffs" | "searchWorkspaceReviewDiffs"
>;

type WebuiReviewStateAction = Parameters<typeof reduceWebuiReviewState>[1];

/** Roadmap E 区「Review 审查模式」and「修复建议+跳转」.
 *
 * The review capability was already wired end to end; what was missing was a
 * place to read a whole change set. Every decision that does not need the
 * network lives in `review-state.ts` so it can be tested without a DOM — this
 * component is the thin shell that fetches and renders. */
function SettingsReviewPage({ workspaceDir, onOpenFileLine, loadSessions, getWorkspaceReviewSummary, listWorkspaceReviewFileDiffs, searchWorkspaceReviewDiffs }: {
  readonly workspaceDir?: string;
  readonly onOpenFileLine?: (path: string, line: number) => void;
  readonly loadSessions?: WebuiSettingsModalCapabilities["loadSessions"];
} & WebuiSettingsReviewCapabilities): ReactElement {
  const [state, setState] = useState<WebuiReviewState>(initialWebuiReviewState);
  const dispatch = useCallback((action: WebuiReviewStateAction) => {
    setState((current) => reduceWebuiReviewState(current, action));
  }, []);

  /* The prop is the selected session's workspace, and it is empty whenever the
   * selected session is not bound to a project — including the default
   * workspace, which the rail groups under 「未选项目」. A workspace chosen here
   * overrides the prop rather than replacing it, so picking one takes effect
   * immediately instead of waiting for the user to go change session in the
   * rail, which the `aria-modal` dialog does not even let them click. */
  const [pickedWorkspaceDir, setPickedWorkspaceDir] = useState<string | undefined>(undefined);
  const [workspaceChoices, setWorkspaceChoices] = useState<readonly WebuiWorktreeSourceSession[]>([]);
  const [workspaceChoicesLoading, setWorkspaceChoicesLoading] = useState(false);
  const [workspaceChoicesError, setWorkspaceChoicesError] = useState<string | undefined>(undefined);
  const effectiveWorkspaceDir = workspaceDir?.trim() || pickedWorkspaceDir;

  /* Only the chooser needs the session list, so a page opened from a
   * workspace-bound session never pays for this fetch. */
  useEffect(() => {
    if (workspaceDir || !loadSessions) return;
    let cancelled = false;
    setWorkspaceChoicesLoading(true);
    setWorkspaceChoicesError(undefined);
    void loadSessions()
      .then((page) => {
        if (cancelled) return;
        setWorkspaceChoices((page?.sessions ?? []) as readonly WebuiWorktreeSourceSession[]);
        setWorkspaceChoicesLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setWorkspaceChoicesError(cause instanceof Error ? cause.message : String(cause));
        setWorkspaceChoicesLoading(false);
      });
    return () => { cancelled = true; };
  }, [loadSessions, workspaceDir]);

  useEffect(() => {
    if (!effectiveWorkspaceDir || !getWorkspaceReviewSummary) return;
    let cancelled = false;
    dispatch({ type: "load-begun" });
    void getWorkspaceReviewSummary({ workspaceDir: effectiveWorkspaceDir })
      .then((summary) => {
        if (cancelled) return;
        const snapshotId = summary?.reviewSnapshotId;
        const files = summary?.files ?? [];
        // A workspace with nothing staged against it is a normal state, and
        // showing it as a failure would put a red banner on every fresh repo.
        if (!snapshotId || !files.length) {
          dispatch({ type: "unavailable", reason: "当前工作区没有待审查的变更" });
          return;
        }
        const totals = summary?.totals ?? {
          files: files.length,
          additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        };
        dispatch({ type: "summary-loaded", reviewSnapshotId: snapshotId, files: [...files], totals });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        dispatch({ type: "load-failed", reason: error instanceof Error ? error.message : String(error) });
      });
    return () => { cancelled = true; };
  }, [dispatch, getWorkspaceReviewSummary, effectiveWorkspaceDir]);

  /* The snapshot id and the query are passed in rather than read back out of
   * state: reading a `useState` value from inside a setter callback is a type
   * error waiting to happen and silently captures whatever the reducer saw,
   * not what the caller meant. */
  const loadDiffs = useCallback(async (fileIds: readonly string[], reviewSnapshotId: string) => {
    if (!effectiveWorkspaceDir || !listWorkspaceReviewFileDiffs || !fileIds.length) return;
    dispatch({ type: "diffs-begun", fileIds });
    for (let index = 0; index < fileIds.length; index += WEBUI_REVIEW_DIFF_BATCH_SIZE) {
      const batch = fileIds.slice(index, index + WEBUI_REVIEW_DIFF_BATCH_SIZE);
      try {
        const result = await listWorkspaceReviewFileDiffs({ workspaceDir: effectiveWorkspaceDir, reviewSnapshotId, fileIds: [...batch] });
        const diffs: Record<string, string> = {};
        const errors: Record<string, string> = {};
        for (const entry of (result?.diffs ?? []) as readonly WebuiWorkspaceReviewFileDiff[]) {
          if (entry.error) errors[entry.fileId] = entry.error;
          else if (entry.diff?.type === "text" && entry.diff.content) diffs[entry.fileId] = entry.diff.content;
          else if (entry.diff?.type === "binary") errors[entry.fileId] = "二进制文件没有可显示的补丁";
          else errors[entry.fileId] = "运行时没有返回这个文件的补丁";
        }
        dispatch({ type: "diffs-loaded", diffs, errors });
      } catch (error: unknown) {
        dispatch({ type: "diffs-loaded", diffs: {}, errors: Object.fromEntries(batch.map((fileId) => [fileId, error instanceof Error ? error.message : String(error)])) });
      }
    }
  }, [dispatch, listWorkspaceReviewFileDiffs, effectiveWorkspaceDir]);

  const runSearch = useCallback(async (reviewSnapshotId: string, query: string) => {
    if (!effectiveWorkspaceDir || !searchWorkspaceReviewDiffs || !query.trim()) return;
    dispatch({ type: "search-begun" });
    try {
      const result = await searchWorkspaceReviewDiffs({ workspaceDir: effectiveWorkspaceDir, reviewSnapshotId, query, includeUntrackedFiles: true });
      dispatch({ type: "search-settled", fileIds: (result?.matchedFiles ?? []).map((entry) => entry.fileId) });
    } catch {
      // A failed search must not leave the list filtered by the previous one.
      dispatch({ type: "search-settled", fileIds: [] });
    }
  }, [dispatch, searchWorkspaceReviewDiffs, effectiveWorkspaceDir]);

  const visible = selectWebuiReviewVisibleFiles(state);
  const filtering = isWebuiReviewFiltering(state);

  /* The picker is the way in. It lists real checkouts, taken from the same
   * grouping the worktree page uses, so one checkout cannot appear twice just
   * because the runtime spelled its path two ways. */
  if (!effectiveWorkspaceDir) {
    return <WebuiReviewWorkspacePicker
      workspaces={groupWebuiWorktreeWorkspaces(workspaceChoices)}
      loading={workspaceChoicesLoading}
      error={workspaceChoicesError}
      selected={pickedWorkspaceDir}
      onSelect={setPickedWorkspaceDir}
    />;
  }
  if (state.status === "idle" || state.status === "loading") {
    return <WebuiReviewPanel state={state} loading />;
  }
  if (state.status === "unavailable" || state.status === "error") {
    return <WebuiReviewPanel state={state} note={state.error} empty={state.status === "error" ? "读取待审查的变更失败" : "当前工作区没有待审查的变更。"} workspaceDir={effectiveWorkspaceDir} />;
  }

  return <WebuiReviewPanel
    state={state}
    visible={visible}
    filtering={filtering}
    onQueryChange={(query) => {
      dispatch({ type: "query-changed", query });
      // Live search: the server is asked for every keystroke, and the
      // reducer drops the previous matches first so the list never shows
      // results for a query that is no longer in the box.
      if (state.reviewSnapshotId && query.trim()) void runSearch(state.reviewSnapshotId, query);
    }}
    onClearFilters={() => dispatch({ type: "clear-filters" })}
    onToggleFile={(fileId, willExpand, file) => {
      dispatch({ type: "toggle-file", fileId });
      if (willExpand && !state.diffs[fileId] && !state.diffErrors[fileId] && state.reviewSnapshotId) {
        void loadDiffs([fileId], state.reviewSnapshotId);
      }
      void file;
    }}
    onOpenFileLine={onOpenFileLine}
  />;
}

/** Presentational half of the code-review page.
 *
 * Split from the fetching shell on purpose: `renderToStaticMarkup` runs the
 * first render and never runs effects, so a page that only reaches its
 * populated state through an effect cannot be asserted on at all. Everything
 * that depends on data is decided upstream in `review-state.ts` and arrives
 * here as a plain value, which makes the populated render reachable from a
 * test without a DOM. */
/* Roadmap E 区 follow-up: the review page used to answer "先打开一个工作区"
 * and stop. The instruction named the problem and gave no way out of it — and
 * the settings dialog is `aria-modal`, so the rail cannot be clicked while it
 * is open. Choosing here is the only route that stays inside the page.
 *
 * Presentational like `WebuiReviewPanel`, so the list is assertable without a
 * DOM. It deliberately reuses the worktree panel's class names instead of
 * inventing a second look for what is the same thing: a list of checkouts. */
export function WebuiReviewWorkspacePicker({ workspaces, selected, loading, error, onSelect }: {
  readonly workspaces: readonly WebuiWorktreeWorkspace[];
  readonly selected?: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly onSelect?: (workspaceDir: string) => void;
}): ReactElement {
  const state = error ? "error" : loading ? "loading" : workspaces.length ? "ready" : "empty";
  return <div className="webui-review-page" data-testid="review-workspace-picker" data-webui-workspace-state={state}>
    <p className="webui-review-empty">选一个工作区来审查它的变更。</p>
    {error ? <p className="webui-review-error" role="alert" data-testid="review-workspace-error">{error}</p> : null}
    {loading ? <p className="webui-review-loading" role="status">正在读取可审查的工作区…</p> : null}
    {!loading && !error && workspaces.length === 0 ? (
      /* Saying why matters more than saying that: an empty list under the same
       * heading reads as the bug this page is fixing. */
      <p className="webui-review-empty" data-testid="review-workspace-empty">现在没有绑定项目目录的会话，所以没有可审查的工作区。在左栏给一个会话选好项目目录，再回到这里。</p>
    ) : null}
    <ul className="webui-worktree-branches">
      {workspaces.map((workspace) => <li className="webui-worktree-group" key={workspace.workspaceDir}>
        <button
          type="button"
          className="webui-worktree-heading"
          data-testid="review-workspace-option"
          data-webui-workspace-dir={workspace.workspaceDir}
          data-webui-workspace-current={workspace.workspaceDir === selected ? "true" : undefined}
          onClick={() => onSelect?.(workspace.workspaceDir)}
        >
          <span className="webui-worktree-name"><FolderIcon />{workspace.name}</span>
          <span className="webui-worktree-kind">{workspace.sessions.length} 个会话</span>
        </button>
        <p className="webui-worktree-path" title={workspace.workspaceDir}>{workspace.workspaceDir}</p>
      </li>)}
    </ul>
  </div>;
}

/* Roadmap P 区「快捷键管理」.
 *
 * Presentational like the review and worktree panels, so the rows it renders
 * are assertable without a DOM. Which commands exist and how a binding is
 * parsed live in `shortcut-state.ts`; nothing here decides anything. */
export function WebuiShortcutSettings({ overrides, platform, editing, conflict, onStartEdit, onReset, onCancelEdit }: {
  readonly overrides: readonly WebuiShortcutOverride[];
  readonly platform?: string;
  readonly editing?: string;
  readonly conflict?: { readonly commandId: string; readonly label: string } | undefined;
  readonly onStartEdit?: (commandId: string) => void;
  readonly onReset?: (commandId: string) => void;
  readonly onCancelEdit?: () => void;
}): ReactElement {
  const bindings = resolveWebuiShortcutBindings(overrides);
  const overridden = new Set(overrides.map((override) => override.id));
  const groups = [...new Set(WEBUI_SHORTCUT_COMMANDS.map((command) => command.group))];
  return <div className="webui-settings-shortcuts" data-testid="settings-shortcut-page">
    {groups.map((group) => <section className="webui-settings-shortcut-group" key={group}>
      <h3 className="webui-settings-shortcut-group-name">{group}</h3>
      <ul className="webui-settings-shortcut-list">
        {WEBUI_SHORTCUT_COMMANDS.filter((command) => command.group === group).map((command) => {
          const isOverridden = overridden.has(command.id);
          return <li
            className="webui-settings-shortcut-row"
            key={command.id}
            data-webui-shortcut-id={command.id}
            data-webui-shortcut-overridden={isOverridden ? "true" : undefined}
          >
            <span className="webui-settings-shortcut-label">{command.label}</span>
            {editing === command.id ? (
              <span className="webui-settings-shortcut-capture" data-testid="shortcut-capture">按下新的组合键，Esc 取消</span>
            ) : (
              <button
                type="button"
                className="webui-settings-shortcut-key"
                data-testid="shortcut-binding"
                onClick={() => onStartEdit?.(command.id)}
              >
                {formatWebuiShortcut(bindings.get(command.id) ?? command.defaultBinding, platform)}
              </button>
            )}
            {isOverridden ? (
              <button
                type="button"
                className="webui-settings-shortcut-reset"
                data-testid="shortcut-reset"
                onClick={() => onReset?.(command.id)}
              >
                恢复默认
              </button>
            ) : null}
          </li>;
        })}
      </ul>
    </section>)}
    {conflict ? (
      <p className="webui-settings-shortcut-conflict" role="alert" data-testid="shortcut-conflict">
        这个组合键已经被「{conflict.label}」占用了，换一个。
      </p>
    ) : null}
    {editing ? (
      <button type="button" className="webui-settings-shortcut-cancel" data-testid="shortcut-cancel" onClick={() => onCancelEdit?.()}>
        取消
      </button>
    ) : null}
  </div>;
}

/** Reads overrides once on mount and owns the capture gesture while a row is
 * being rebound. The shell's global handler reads the same storage key. */
function SettingsShortcutsPage(): ReactElement {
  const [overrides, setOverrides] = useState<readonly WebuiShortcutOverride[]>([]);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<{ readonly commandId: string; readonly label: string } | undefined>(undefined);
  const [platform, setPlatform] = useState("");

  useEffect(() => {
    setOverrides(parseWebuiShortcutOverrides(localStorage.getItem(WEBUI_SHORTCUT_OVERRIDES_KEY)));
    setPlatform(typeof navigator === "undefined" ? "" : navigator.platform || "");
  }, []);

  const write = useCallback((next: readonly WebuiShortcutOverride[]) => {
    setOverrides(next);
    localStorage.setItem(WEBUI_SHORTCUT_OVERRIDES_KEY, JSON.stringify(next));
  }, []);

  useEffect(() => {
    if (!editing) return undefined;
    /* Capture phase, so the row wins over the shell's own global dispatcher
     * for the duration of the gesture rather than after it. */
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setEditing(undefined);
        setConflict(undefined);
        return;
      }
      const binding = webuiShortcutFromEvent(event);
      if (!binding) return;
      const clash = findWebuiShortcutConflict(binding, editing, resolveWebuiShortcutBindings(overrides));
      if (clash) {
        setConflict({
          commandId: clash,
          label: WEBUI_SHORTCUT_COMMANDS.find((command) => command.id === clash)?.label ?? clash,
        });
        return;
      }
      write([...resetWebuiShortcutOverrides(overrides, editing), { id: editing, binding }]);
      setEditing(undefined);
      setConflict(undefined);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [editing, overrides, write]);

  return <WebuiShortcutSettings
    overrides={overrides}
    platform={platform}
    editing={editing}
    conflict={conflict}
    onStartEdit={(commandId) => { setEditing(commandId); setConflict(undefined); }}
    onReset={(commandId) => { write(resetWebuiShortcutOverrides(overrides, commandId)); setConflict(undefined); }}
    onCancelEdit={() => { setEditing(undefined); setConflict(undefined); }}
  />;
}

export function WebuiReviewPanel({ state, visible, filtering, loading, note, empty, workspaceDir, onQueryChange, onClearFilters, onToggleFile, onOpenFileLine }: {
  readonly state: WebuiReviewState;
  readonly visible?: readonly WebuiReviewFile[];
  readonly filtering?: boolean;
  readonly loading?: boolean;
  readonly note?: string;
  readonly empty?: string;
  readonly workspaceDir?: string;
  readonly onQueryChange?: (query: string) => void;
  readonly onClearFilters?: () => void;
  readonly onToggleFile?: (fileId: string, willExpand: boolean, file: WebuiReviewFile) => void;
  readonly onOpenFileLine?: (path: string, line: number) => void;
}): ReactElement {
  const rows = visible ?? state.files;
  const filterActive = filtering ?? isWebuiReviewFiltering(state);
  return <div className="webui-review-page" data-testid="settings-review-page" data-webui-review-state={state.status} data-webui-review-snapshot={state.reviewSnapshotId}>
    {state.status === "ready" ? <div className="webui-review-totals" data-testid="review-totals">
      <span>{state.totals.files} 个文件</span>
      <span className="webui-diff-add">{`+${state.totals.additions}`}</span>
      <span className="webui-diff-del">{`-${state.totals.deletions}`}</span>
    </div> : null}
    {state.status === "ready" ? <div className="webui-review-search">
      <SearchIcon />
      <input
        aria-label="在变更里搜索"
        placeholder="在变更里搜索"
        data-testid="review-search-input"
        value={state.query}
        onChange={(event) => onQueryChange?.(event.target.value)}
      />
      {filterActive ? <button type="button" className="webui-review-clear" data-testid="review-search-clear" onClick={() => onClearFilters?.()}>清除</button> : null}
    </div> : null}
    {loading || state.searchPending ? <p className="webui-review-loading" role="status">{loading ? "正在读取待审查的变更…" : "正在搜索…"}</p> : null}
    {note || state.error ? <p className={state.status === "error" ? "webui-review-error" : "webui-review-empty"} role={state.status === "error" ? "alert" : undefined} data-testid="review-note">{note ?? state.error}</p> : null}
    {workspaceDir ? <p className="webui-review-empty" data-testid="review-workspace">{workspaceDir}</p> : null}
    {empty && !note ? <p className="webui-review-empty" data-testid="review-empty">{empty}</p> : null}
    {state.status === "ready" && rows.length === 0 ? <p className="webui-review-empty" data-testid="review-empty">{filterActive ? "没有匹配的文件" : "没有可显示的文件"}</p> : null}
    <ul className="webui-review-files">
      {rows.map((file) => {
        const expanded = state.expandedFileIds.includes(file.fileId);
        const diff = state.diffs[file.fileId];
        const diffError = state.diffErrors[file.fileId];
        const pending = state.loadingFileIds.includes(file.fileId);
        return <li className="webui-review-file" key={file.fileId} data-testid="review-file" data-file-id={file.fileId} data-webui-review-file-status={file.status}>
          <button
            type="button"
            className="webui-review-file-heading"
            data-testid="review-file-toggle"
            aria-expanded={expanded}
            onClick={() => onToggleFile?.(file.fileId, !expanded, file)}
          >
            <span className="webui-review-file-path" title={file.path}>{file.path}</span>
            <span className="webui-review-file-status">{file.status}</span>
            <span className="webui-review-file-stats">
              <span className="webui-diff-add">{`+${file.additions}`}</span>
              {file.deletions > 0 ? <span className="webui-diff-del">{`-${file.deletions}`}</span> : null}
            </span>
          </button>
          {expanded ? <div className="webui-review-file-body" data-testid="review-file-body">
            {pending ? <p className="webui-review-loading" role="status">正在读取这个文件的补丁…</p> : null}
            {diffError ? <p className="webui-review-file-error" role="status" data-testid="review-file-error">{diffError}</p> : null}
            {diff ? <ol className="webui-review-lines" data-testid="review-lines">
              {projectWebuiReviewLines(diff).map((line, index) => {
                const target = webuiReviewLineTarget(line);
                const text = (
                  <>
                    <span className="webui-review-line-number">{line.newLine ?? ""}</span>
                    <span className="webui-review-line-text">{line.text}</span>
                  </>
                );
                return <li className={`webui-review-line webui-review-line--${line.kind}`} key={index} data-webui-review-line-kind={line.kind} data-webui-review-line={line.newLine ?? ""}>
                  {target === undefined || !onOpenFileLine
                    ? <span className="webui-review-line-static">{text}</span>
                    : <button type="button" className="webui-review-line-jump" data-testid="review-line-jump" data-webui-review-jump-line={target} onClick={() => onOpenFileLine(file.path, target)}>{text}</button>}
                </li>;
              })}
            </ol> : null}
          </div> : null}
        </li>;
      })}
    </ul>
  </div>;
}

/** Roadmap E 区「工作树隔离」.
 *
 * Creating an isolated worktree already works from the rail's context menu;
 * this is the other half of the row — being able to see which parallel
 * experiment branches exist and switch into one. Grouping is done by
 * `groupWebuiWorktreeWorkspaces`, so the list a test asserts on is the same
 * list the page renders. */
function SettingsWorktreePage({ loadSessions }: {
  readonly loadSessions?: WebuiSettingsModalCapabilities["loadSessions"];
}): ReactElement {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [sessions, setSessions] = useState<readonly WebuiWorktreeSourceSession[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!loadSessions) return;
    let cancelled = false;
    setStatus("loading");
    void loadSessions()
      .then((page) => {
        if (cancelled) return;
        setSessions((page?.sessions ?? []) as readonly WebuiWorktreeSourceSession[]);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      });
    return () => { cancelled = true; };
  }, [loadSessions]);

  const workspaces = groupWebuiWorktreeWorkspaces(sessions);
  const worktrees = selectWebuiWorktreeWorkspaces(workspaces);
  const primary = selectWebuiPrimaryWorkspace(workspaces);

  if (status === "error") {
    return <WebuiWorktreePanel workspaces={workspaces} error={error} />;
  }
  if (status === "loading") {
    return <div className="webui-review-page" data-testid="settings-worktree-page" data-webui-worktree-state="loading">
      <p className="webui-review-loading" role="status">正在读取工作树…</p>
    </div>;
  }
  return <WebuiWorktreePanel workspaces={workspaces} worktrees={worktrees} primary={primary} />;
}

/** Presentational half of the worktree page, split for the same reason as
 * `WebuiReviewPanel`: `renderToStaticMarkup` runs no effects, so a page that
 * only reaches its populated state through a fetch cannot be asserted on. */
export function WebuiWorktreePanel({ workspaces, worktrees, primary, error }: {
  readonly workspaces: readonly WebuiWorktreeWorkspace[];
  readonly worktrees?: readonly WebuiWorktreeWorkspace[];
  readonly primary?: WebuiWorktreeWorkspace;
  readonly error?: string;
}): ReactElement {
  const branches = worktrees ?? selectWebuiWorktreeWorkspaces(workspaces);
  const main = primary ?? selectWebuiPrimaryWorkspace(workspaces);
  return <div className="webui-review-page" data-testid="settings-worktree-page" data-webui-worktree-state={error ? "error" : branches.length ? "ready" : "empty"}>
    {error ? <p className="webui-review-error" role="alert" data-testid="worktree-error">{error}</p> : null}
    {main ? <section className="webui-worktree-group" data-testid="worktree-primary" data-webui-worktree-primary="true">
      <header className="webui-worktree-heading">
        <span className="webui-worktree-name"><FolderIcon />{main.name}</span>
        <span className="webui-worktree-kind">主检出</span>
      </header>
      <p className="webui-worktree-path" title={main.workspaceDir}>{main.workspaceDir}</p>
      <ul className="webui-worktree-sessions">
        {main.sessions.map((entry) => <li className="webui-worktree-session" key={entry.sessionId} data-testid="worktree-session">
          <span className="webui-worktree-session-title" title={entry.title}>{entry.title}</span>
        </li>)}
      </ul>
    </section> : null}
    <h3 className="webui-worktree-section-title">并行实验分支</h3>
    {branches.length === 0 ? <p className="webui-review-empty" data-testid="worktree-empty">还没有工作树。在会话的右键菜单里选「复制到新工作树」即可开一个。</p> : null}
    <ul className="webui-worktree-branches">
      {branches.map((branch) => <li className="webui-worktree-group" key={branch.workspaceDir} data-testid="worktree-branch" data-webui-worktree-dir={branch.workspaceDir}>
        <header className="webui-worktree-heading">
          <span className="webui-worktree-name"><FolderIcon />{branch.name}</span>
          <span className="webui-worktree-kind">{branch.sessions.length} 个会话</span>
        </header>
        <p className="webui-worktree-path" title={branch.workspaceDir}>{branch.workspaceDir}</p>
        <ul className="webui-worktree-sessions">
          {branch.sessions.map((entry) => <li className="webui-worktree-session" key={entry.sessionId} data-testid="worktree-session" data-webui-worktree-session={entry.sessionId}>
            {/* Session navigation in this shell is the `#session=<id>` hash,
                which is what the rail's own links use. Reusing it keeps one
                navigation path instead of adding a second one. */}
            <a className="webui-worktree-session-link" href={`#session=${entry.sessionId}`} title={entry.title}>{entry.title}</a>
            {entry.parentSessionId ? <span className="webui-worktree-forked" title={`派生自 ${entry.parentSessionId}`}>派生</span> : null}
          </li>)}
        </ul>
      </li>)}
    </ul>
  </div>;
}

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
  return <div className="webui-archived-page" data-testid="settings-archived-page">
    {actionError ? <p role="alert" className="webui-archived-error">{actionError}</p> : null}
    <div className="webui-archived-filters">
      <label className="webui-archived-search"><SearchIcon /><input aria-label="搜索已归档聊天" placeholder="搜索已归档聊天" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    </div>
    {filtered.length ? <div className="webui-archived-groups">{[...grouped].map(([path, rows]) => <section className="webui-archived-project" key={path}>
      <header className="webui-archived-project-heading"><span className="webui-archived-project-name"><FolderIcon />{path === "未关联项目" ? path : projectLabel(path)}</span><span>{rows.length} 个聊天</span></header>
      <div className="webui-archived-list">{rows.map((session) => <article className="webui-archived-row" key={session.sessionId}>
        <div className="webui-archived-row-copy"><div className="webui-archived-title" title={session.title || session.sessionId}>{session.title || session.sessionId}</div><time>{formatArchivedDate(session.updatedAt)}</time></div>
        <button type="button" className="webui-archived-icon-button" aria-label={`删除：${session.title || session.sessionId}`} title="删除" disabled={!canDelete} onClick={() => { if (window.confirm("确定删除这个已归档聊天吗？此操作无法撤销。")) void runDelete(session.sessionId); }}><TrashIcon /></button>
        <button type="button" className="webui-archived-unarchive" disabled={!canUnarchive} onClick={() => void runUnarchive(session.sessionId)}>取消归档</button>
      </article>)}</div>
    </section>)}</div> : <p className="webui-archived-empty">{sessions.length ? "没有符合条件的聊天" : "暂无已归档聊天"}</p>}
  </div>;
}
function projectLabel(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) || path; }
function formatArchivedDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(timestamp));
}
function TrashIcon(): ReactElement { return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M3.5 5.5h13M8 8.5v6m4-6v6M5.5 5.5l.7 11h7.6l.7-11M7.5 5.5V3.7h5v1.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
function SearchIcon(): ReactElement { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="8.8" cy="8.8" r="6.1" stroke="currentColor" strokeWidth="1.4" /><path d="m13.3 13.3 4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>; }
function FolderIcon(): ReactElement { return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M2.7 5.7c0-.7.5-1.2 1.2-1.2h4l1.6 1.8h6.6c.7 0 1.2.5 1.2 1.2v7.1c0 .7-.5 1.2-1.2 1.2H3.9c-.7 0-1.2-.5-1.2-1.2V5.7Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" /></svg>; }
