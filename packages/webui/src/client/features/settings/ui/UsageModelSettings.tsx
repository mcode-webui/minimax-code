import { useEffect, useState, type ReactElement } from "react";
import { formatWebuiCredits, recordOf, textOf } from "../../../contracts/value-readers.js";
import { useWebuiModelsWorkflows, useWebuiModelsWorkflowsState, useWebuiSettingsWorkflows, useWebuiSettingsWorkflowsState } from "../../../bindings/use-query-state.js";
import { useWebuiAccountWorkflows, useWebuiAccountWorkflowsState } from "../../../features/account/bindings/use-account-workflows.public.js";
import { ToggleSwitch } from "../../../ui/ToggleSwitch.js";
import { SettingsPage, SettingsSection } from "../../../ui/settings-layout.js";
import { formatResetLabel, getActiveSourceBadge, type ProviderHeaderDraft } from "../../../features/models/projection/usage-settings.public.js";
import { formatPlanName, formatPlanSourceLabel, hasWebuiPlan } from "../projection/usage-plan.js";
import { UsageResetCards } from "./UsageResetCards.js";
import { IconButton, RefreshIcon } from "../../../ui/form-atoms.js";
import { IconChevronDown, IconExternalLink, IconInfoCircle } from "@tabler/icons-react";
import { ProviderFormPanel, type WebuiProviderFormCommands } from "../../../features/models/ui/ProviderFormPanel.public.js";
import { useWebuiProviderEditor } from "../../../features/models/bindings/use-provider-editor.public.js";
import type { WebuiProviderEditorCommands } from "../../../features/models/contracts/provider-editor.js";
import { unavailableWebuiProviderOutcome } from "../../../features/models/contracts/provider-outcome.js";
import type { WebuiModelProviderView } from "../../../../shared/contracts/models.js";
import { FeedbackError, FeedbackLiveRegion } from "../../../ui/feedback.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiTextInput } from "../../../ui/field.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";

type Props = {
  readonly sessionId?: string;
};

/** The provider form's commands when the owner is not wired yet. It disables what `models?.` used
 * to make unavailable and does nothing where `settings?.X()` used to call nothing, so the panel's
 * own code needs no optional-chaining of its own. */
// The editor's fallback: the same "not wired" answers, for the members the editor
// needs that the panel's bundle does not carry (`createProvider`).
const NO_PROVIDER_EDITOR_COMMANDS: WebuiProviderEditorCommands = {
  canManageProviders: false,
  revealApiKey: async () => "",
  createProvider: async () => undefined,
  updateProvider: async () => undefined,
  deleteProvider: async () => undefined,
  // A refusal with the stable "this host does not implement it" code, rather
  // than an absence the editor has to interpret. `undefined` made the
  // unsupported case and the runtime-refused case identical, and the one the
  // user must never retry was the one the panel could offer.
  discoverCandidate: async () => unavailableWebuiProviderOutcome("当前运行时不支持模型发现。"),
  saveCandidate: async () => unavailableWebuiProviderOutcome("当前运行时不支持保存提供商。"),
  testCandidate: async () => unavailableWebuiProviderOutcome("当前运行时不支持模型测试。"),
};

const NO_PROVIDER_COMMANDS: WebuiProviderFormCommands = {
  canManageProviders: false,
  loadProviders: async () => {},
  loadPresets: async () => {},
  revealApiKey: async () => "",
  testModel: async () => undefined,
  discoverCandidate: async () => unavailableWebuiProviderOutcome("当前运行时不支持模型发现。"),
  testCandidate: async () => unavailableWebuiProviderOutcome("当前运行时不支持模型测试。"),
  saveCandidate: async () => undefined,
  deleteProvider: async () => undefined,
  setProviderModelEnabled: async () => ({ status: "failed", category: "refused", error: new Error("当前运行时不支持修改提供商。") }),
  reorderProviderModels: async () => ({ status: "failed", category: "refused", error: new Error("当前运行时不支持修改提供商。") }),
};

export function UsageModelSettings({ sessionId }: Props): ReactElement {
  // The models/providers/api-key/model-source/codex answers come from the
  // settings owner and the usage quota from the account owner.
  // This panel submits commands and reads snapshots; every uncommitted form
  // field below stays local, and the one-second quota clock stays local too.
  //
  // The provider form is `models`': it lives in
  // `features/models/ui/ProviderFormPanel.tsx` and is rendered below in the same
  // conditional branch it occupied when it was declared here. Its drafts stay
  // **here**, because a sub-tab switch unmounts that branch and the drafts have
  // to survive it.
  const settings = useWebuiSettingsWorkflows();
  const settingsState = useWebuiSettingsWorkflowsState();
  // The provider form and the model list are `models`': its commands and its
  // snapshot come from that owner, not from the settings one.
  const models = useWebuiModelsWorkflows();
  const modelsState = useWebuiModelsWorkflowsState();
  // The provider editor is hosted *here*, above the custom-tab branch rendered
  // below, so a source-tab switch neither loses a draft nor forgets that the
  // draft was tested. Its lifetime is this component's, which is leaving the
  // Usage category or closing Settings.
  const { editor, snapshot: providerEditorSnapshot } = useWebuiProviderEditor(
    models ?? NO_PROVIDER_EDITOR_COMMANDS,
  );
  const account = useWebuiAccountWorkflows();
  const accountState = useWebuiAccountWorkflowsState();
  const [sourceTab, setSourceTab] = useState<"token-plan" | "minimax-api" | "custom">("token-plan");
  const [apiKey, setApiKey] = useState("");
  const [quotaClock, setQuotaClock] = useState(() => Date.now());
  const [savingKey, setSavingKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyResult, setKeyResult] = useState<string>();
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [providerActionError, setProviderActionError] = useState<string>();
  const [oauthError, setOauthError] = useState<string>();
  const [oauthLoginId, setOauthLoginId] = useState<string>();
  const [providerPendingDelete, setProviderPendingDelete] = useState<WebuiModelProviderView>();

  // Committed read state, derived from the owner snapshots.
  const quota = accountState.usage.result;
  const quotaLoading = accountState.usage.status === "idle" || accountState.usage.status === "loading";
  const quotaError = accountState.usage.status === "error" ? accountState.usage.error : undefined;
  const apiStatus = accountState.apiKeyStatus.value;
  const apiLoading = accountState.apiKeyStatus.status === "idle" || accountState.apiKeyStatus.status === "loading";
  const apiError = accountState.apiKeyStatus.status === "error" ? accountState.apiKeyStatus.error : undefined;
  const providers = modelsState.providers.value ?? [];
  const providerLoading = modelsState.providers.status === "idle" || modelsState.providers.status === "loading";
  const providerError = providerActionError ?? (modelsState.providers.status === "error" ? modelsState.providers.error : undefined);
  const presets = modelsState.presets.value ?? [];
  const oauth = accountState.codexOAuth.value;
  const activeSource = settingsState.modelSource.value;
  const sourceLoaded = settingsState.modelSource.status === "ready";

  const loadQuota = () => { void account?.loadUsage(); };
  const loadApiStatus = () => { void account?.loadApiKeyStatus(); };
  const loadProviders = () => { setProviderActionError(undefined); void models?.loadProviders(); };
  useEffect(() => {
    void account?.loadUsage(); void account?.loadApiKeyStatus(); void models?.loadProviders();
    void settings?.loadModelSource(); void account?.loadCodexOAuthStatus();
    void account?.loadCreditFallback();
  // Owner objects are stable; the initial loads are keyed on the session as before.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  useEffect(() => {
    const timer = setInterval(() => setQuotaClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // The poll is the owner's, not this component's: the surface acquires an
  // interest while a Codex login is pending and releases it on unmount, so a
  // hidden or remounted surface cannot leave a second timer behind.
  useEffect(() => {
    if (!oauthLoginId || !account) return;
    return account.acquireCodexOAuthPolling();
  }, [account, oauthLoginId]);

  const chooseSource = async (source: "token_plan" | "minimax_api_key") => {
    setSourceTab(source === "token_plan" ? "token-plan" : "minimax-api");
    if (source === activeSource || !settings?.canSetModelSource) return;
    if (source === "minimax_api_key" && apiStatus?.valid !== true) return;
    try { await settings.setModelSource(source); }
    catch (error) { setKeyResult(error instanceof Error ? error.message : String(error)); }
  };
  const testKey = async () => {
    if ((!apiKey.trim() && !apiValid) || !models) return;
    setTestingKey(true); setKeyResult(undefined);
    try {
      const result = recordOf(await models.testProvider({ providerId: "minimax_api", ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }));
      setKeyResult(result.success === true ? "连接成功" : textOf(recordOf(result.status).lastErrorMessage) || "连接失败");
    } catch (error) { setKeyResult(error instanceof Error ? error.message : String(error)); }
    finally { setTestingKey(false); }
  };
  const saveKey = async () => {
    if (!apiKey.trim() || !models) return;
    setSavingKey(true); setKeyResult(undefined);
    try { await models.upsertApiKey({ apiKey: apiKey.trim(), saveAndUse: true }); void settings?.loadModelSource(); }
    catch (error) { setKeyResult(error instanceof Error ? error.message : String(error)); }
    finally { setSavingKey(false); }
  };
  const beginCodexLogin = async () => {
    if (!settings?.canStartCodexOAuth) return;
    const popup = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    setOauthError(undefined);
    try {
      const result = recordOf(await settings.startCodexOAuth({}));
      const loginId = textOf(result.loginId);
      const authUrl = textOf(result.authUrl);
      if (loginId) setOauthLoginId(loginId);
      if (authUrl && popup) popup.location.replace(authUrl);
      else if (popup) popup.close();
    } catch (error) {
      popup?.close();
      setOauthError(error instanceof Error ? error.message : String(error));
    }
  };
  const cancelCodexLogin = async () => {
    if (!oauthLoginId || !settings) return;
    try { await settings.cancelCodexOAuth(oauthLoginId); setOauthLoginId(undefined); }
    catch (error) { setOauthError(error instanceof Error ? error.message : String(error)); }
  };
  const quotaView = quota?.signedIn ? quota : undefined;
  const quotaData = quotaView && "quota" in quotaView ? quotaView.quota : undefined;
  const apiValid = apiStatus?.valid === true;
  const resetLabel = (resetAtMs?: number) => formatResetLabel(resetAtMs, quotaClock);
  // The pill names the source in use, not the panel that happens to be open:
  // on 自定义模型 the source is still the one this button switches, and the
  // badge beside the name says which one that is. Reading the tab instead
  // made the pill claim "MiniMax API" the moment 自定义模型 was opened, and
  // the longer name moved the 自定义模型 button a few pixels to the right.
  // The button also carries a fixed minimum width for the same reason: the
  // two names and the badge are different lengths, and a width that follows
  // the text would move the 自定义模型 button on every switch.
  const source = activeSource ?? (sourceTab === "minimax-api" ? "minimax_api_key" : "token_plan");
  // The plan label is the account's, not a constant: the membership answer
  // says which subscription kind the account has and which tier it is on, and
  // the legacy "Token Plan" name only belongs to the legacy subscription kind.
  // Hard-coding it made an M Plan account read as a Token Plan account.
  const planFacts = quotaView
    ? {
        hasTokenPlan: quotaView.hasTokenPlan,
        tokenPlanTier: quotaView.tokenPlanTier,
        planName: quotaView.planName,
        subscriptionType: quotaView.subscriptionType,
      }
    : undefined;
  const planSourceLabel = formatPlanSourceLabel(planFacts?.subscriptionType);
  const sourceLabel = source === "minimax_api_key" ? "MiniMax API" : planSourceLabel;
  const sourceBadge = getActiveSourceBadge(sourceLoaded, activeSource, quotaView?.hasTokenPlan === true);
  // The credit fallback is the account's own flag. The Desktop shows the row
  // only once the account has produced a verdict, and a signed-out or
  // unanswered account gets no row rather than a switch that says "off".
  const creditFallback = accountState.creditFallback;
  const creditResolved = creditFallback.enabled !== undefined;
  const creditLoading = creditFallback.status === "loading" && !creditResolved;


  return <SettingsPage testId="settings-usage-model">
    <WebuiInline gap="medium" className="h-8">
      <div className="relative">
      <WebuiInline gap="none" className={`h-8 overflow-hidden rounded-[8px] text-[14px] font-medium leading-5 transition-colors ${sourceTab !== "custom" ? "bg-bg_interaction_tertiary_hover text-text_default_primary" : "text-text_default_secondary hover:bg-bg_interaction_tertiary_hover"}`}>
        <WebuiButton variant="segmented" size="compact" aria-pressed={sourceTab !== "custom"} aria-expanded={sourceMenuOpen} data-testid="settings-usage-source-tab" className="h-full min-w-[140px] pl-3 pr-1 text-left" onClick={() => setSourceMenuOpen((open) => !open)}>{sourceLabel}{sourceBadge ? <span className={`rounded-[6px] px-1 py-0.5 text-[12px] leading-4 ${sourceBadge === "使用中" ? "bg-bg_status_positive text-icon_status_success" : "bg-[rgba(10,10,10,0.04)] text-[#666]"}`}>{sourceBadge}</span> : null}</WebuiButton>
        <WebuiButton variant="quiet-action" size="compact" aria-label="选择模型来源" aria-expanded={sourceMenuOpen} className="h-full w-7 justify-center"><ChevronDownIcon /></WebuiButton>
      </WebuiInline>
      {sourceMenuOpen ? <WebuiStack gap="none" className="absolute left-0 top-full z-10 mt-1 min-w-[180px] rounded-[12px] bg-bg_default_primary p-1.5 shadow-lg"><WebuiButton variant="selectable-row" size="compact" className="h-[30px] w-full rounded-[8px] px-3 text-left text-sm" onClick={() => { setSourceMenuOpen(false); void chooseSource("token_plan"); }}>{planSourceLabel}</WebuiButton><WebuiButton variant="selectable-row" size="compact" className="h-[30px] w-full rounded-[8px] px-3 text-left text-sm" onClick={() => { setSourceMenuOpen(false); void chooseSource("minimax_api_key"); }}>MiniMax API</WebuiButton></WebuiStack> : null}
      </div>
      <div className="h-3 w-[0.5px] bg-border_default" />
      <WebuiButton variant="segmented" size="compact" aria-pressed={sourceTab === "custom"} className="h-8 rounded-[8px] px-3 text-[14px] font-medium leading-5" onClick={() => setSourceTab("custom")}>自定义模型</WebuiButton>
    </WebuiInline>

    {sourceTab === "token-plan" ? <WebuiStack as="section" gap="roomy" className="w-full" data-testid="settings-usage-token-plan">
      {quotaLoading ? <p>加载中…</p> : quotaError ? <FeedbackError message="加载失败" layout="inline" action={<WebuiButton variant="quiet-highlight" size="inline" onClick={() => void loadQuota()}>重试</WebuiButton>} /> : !quotaView ? <p>登录后查看用量</p> : <>
        <SettingsSection title="当前套餐" testId="settings-usage-plan">
            <WebuiInline gap="large" className="min-h-[64px] w-full overflow-hidden rounded-[12px] py-2 pl-3 pr-2"><div className="min-w-0"><span className="block text-[14px] leading-5" data-testid="settings-usage-plan-name">{planFacts ? formatPlanName(planFacts) : ""}</span>{quotaView.tokenPlanExpiresAt ? <span className="mt-1 block text-[12px] leading-4 text-text_default_secondary">{new Date(quotaView.tokenPlanExpiresAt < 1e12 ? quotaView.tokenPlanExpiresAt * 1000 : quotaView.tokenPlanExpiresAt).toLocaleDateString("sv-SE").replaceAll("-", ".")}{quotaView.willRenewal ? " 自动续费" : " 到期"}</span> : planFacts && !hasWebuiPlan(planFacts) ? <span className="mt-1 block text-[12px] leading-4 text-text_default_secondary" data-testid="settings-usage-plan-state">未订阅 M Plan</span> : null}</div></WebuiInline>
            <div className="h-[0.5px] bg-border_default" />
            <WebuiInline gap="large" className="min-h-[64px] w-full overflow-hidden rounded-[12px] py-2 pl-3 pr-2"><div><span className="block text-[14px] leading-5">积分</span><span className="mt-1 block text-[12px] leading-4 text-text_default_secondary">剩余 {quotaView.purchasedCredits !== undefined && quotaView.freeCredits !== undefined ? `${formatWebuiCredits(quotaView.purchasedCredits)} + ${formatWebuiCredits(quotaView.freeCredits)}` : formatWebuiCredits(quotaView.creditBalance)}</span></div></WebuiInline>
        </SettingsSection>
        {quotaData ? <SettingsSection title="用量" testId="settings-usage-limits">{([["5 小时限额", quotaData.fiveHour], ["周限额", quotaData.weekly], ...(quotaData.video ? [["视频限额", quotaData.video] as const] : [])] as const).map(([label, window]) => { const value = recordOf(window); const usedPercent = typeof value.usedPercent === "number" ? value.usedPercent : undefined; const usedCount = typeof value.usedCount === "number" ? value.usedCount : undefined; const totalCount = typeof value.totalCount === "number" ? value.totalCount : undefined; const percent = Math.round(usedPercent ?? (totalCount ? (usedCount ?? 0) / totalCount * 100 : 0)); const resetAtMs = typeof value.resetAtMs === "number" ? value.resetAtMs : undefined; const reset = resetLabel(resetAtMs); return <WebuiStack key={label} gap="small" justify="center" className="min-h-[72px] overflow-hidden rounded-[12px] py-2 pl-3 pr-2"><WebuiInline gap="small" justify="between"><span className="text-[14px] font-normal leading-5 text-text_default_primary">{label}</span><span className="shrink-0 text-[13px] leading-5 text-text_default_secondary">{window.unlimited ? "无限制" : usedCount !== undefined ? `${usedCount}/${totalCount ?? 0}` : `${usedPercent ?? 0}% / 100%`}</span></WebuiInline><div className="h-1 w-full overflow-hidden rounded-full bg-bg_interaction_tertiary_press"><div className="h-full rounded-full bg-text_default_primary" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>{reset ? <span className="text-[12px] font-normal leading-4 text-text_default_secondary">{reset}</span> : null}</WebuiStack>; })}</SettingsSection> : null}
        <SettingsSection title={<>积分 <InfoIcon /></>} testId="settings-usage-points">{creditLoading ? <div data-testid="settings-usage-credit-fallback-loading" className="mx-3 h-[36px] w-full animate-pulse rounded-[12px] bg-bg_interaction_tertiary_press" /> : creditResolved ? <WebuiInline gap="medium" justify="between" className="min-h-[48px] w-full px-3 py-1" data-testid="settings-usage-credit-fallback"><span>开启后，可以在对话中消耗你的积分（含赠予积分）。</span><ToggleSwitch checked={creditFallback.enabled === true} label="M Plan 达限后使用积分" disabled={creditFallback.saving} onChange={(next) => { void account?.setCreditFallback(next); }} testId="settings-usage-credit-fallback-toggle" className="shrink-0 disabled:opacity-60" /></WebuiInline> : null}</SettingsSection>
        <UsageResetCards account={account} state={accountState.resetCards} />
      </>}
    </WebuiStack> : null}

    {sourceTab === "minimax-api" ? <WebuiStack as="section" gap="small" className="w-full pt-1" data-testid="settings-minimax-api-panel">
      <WebuiInline gap="small"><span className="text-[14px] font-medium leading-5 text-text_default_primary">API Key</span><span className={`rounded-[6px] px-1 py-0.5 text-[12px] leading-4 ${apiValid ? "bg-bg_status_positive text-icon_status_success" : "bg-[rgba(10,10,10,0.04)] text-[#666]"}`}>{apiValid ? "使用中" : "未启用"}</span></WebuiInline>
      {apiLoading ? <p>加载中…</p> : apiError ? <FeedbackError message={apiError} layout="inline" action={<WebuiButton variant="quiet-highlight" size="inline" onClick={() => void loadApiStatus()}>重试</WebuiButton>} /> : <>
        <WebuiInline gap="medium"><WebuiTextInput controlSize="compact" className="min-w-0 flex-[1_0_0]" aria-label="API Key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={apiValid ? textOf(apiStatus?.maskedApiKey) : "请输入API Key"} /><IconButton label="测试连通性" disabled={testingKey || (!apiKey.trim() && !apiValid)} onClick={() => void testKey()}><RefreshIcon /></IconButton></WebuiInline>
        {/* 保存结果要被听到，播报通道交给共享契约。 */}
        {keyResult ? <FeedbackLiveRegion>{keyResult}</FeedbackLiveRegion> : null}<WebuiButton variant="secondary" size="regular" className="mt-1 w-[116px]" disabled={!apiKey.trim() || savingKey} onClick={() => void saveKey()}>{savingKey ? "保存中…" : "保存并使用"}</WebuiButton>
      </>}
    </WebuiStack> : null}

    {sourceTab === "custom" ? <WebuiStack as="section" gap="medium" className="min-h-0 flex-1" data-testid="settings-custom-models-panel">
      {providerLoading ? <p>模型加载中...</p> : providerError ? <FeedbackError message={providerError} action={<WebuiButton variant="quiet-highlight" size="inline" onClick={() => void loadProviders()}>重试</WebuiButton>} /> : <>
        <ProviderFormPanel
          providers={providers}
          presets={presets}
          commands={models ?? NO_PROVIDER_COMMANDS}
          setProviderActionError={setProviderActionError}
          editor={editor}
          snapshot={providerEditorSnapshot}
          providerPendingDelete={providerPendingDelete}
          setProviderPendingDelete={setProviderPendingDelete}
        />
        {oauthError ? <FeedbackError message={oauthError} /> : oauth?.state === "connected" ? <WebuiInline gap="medium"><span>Codex OAuth 已连接</span><WebuiButton variant="outline" size="inline" disabled={!models?.canManageProviders} onClick={() => void models?.refreshModels?.()}>获取模型列表</WebuiButton></WebuiInline> : <WebuiInline gap="small"><WebuiButton variant="surface-quiet" size="inline" disabled={!settings?.canStartCodexOAuth || Boolean(oauthLoginId)} onClick={() => void beginCodexLogin()}>{oauthLoginId ? "正在连接 Codex OAuth" : "连接 Codex OAuth"}</WebuiButton>{oauthLoginId ? <WebuiButton variant="quiet-secondary" size="inline" disabled={!settings?.canStartCodexOAuth} onClick={() => void cancelCodexLogin()}>取消</WebuiButton> : null}</WebuiInline>}
      </>}
    </WebuiStack> : null}
  </SettingsPage>;
}

export function DisabledBillingActions(): ReactElement {
  const unavailable = "Disabled (not yet wired)";
  const disabledProps = { disabled: true, "aria-disabled": "true" as const, title: unavailable };
  return <WebuiStack gap="none" className="w-full rounded-[16px] bg-bg_grouped_tertiary p-1" aria-label={unavailable}>
    <WebuiInline gap="small" justify="end" className="w-full overflow-hidden rounded-[12px] py-2 pl-3 pr-2">
      <DesktopGrayAction label="升级" {...disabledProps} />
      <DesktopGrayAction label="管理" dropdown {...disabledProps} />
      <DesktopGrayAction label="开启自动续费" {...disabledProps} />
    </WebuiInline>
    <WebuiInline justify="center" className="w-full px-3 py-1.5"><div className="h-px w-full bg-border_light" /></WebuiInline>
    <WebuiInline gap="small" justify="end" className="w-full overflow-hidden rounded-[12px] py-2 pl-3 pr-2">
      <DesktopGrayAction label="去充值" {...disabledProps} />
      <DesktopGrayAction label="管理" dropdown {...disabledProps} />
      <DesktopGrayAction label="明细" {...disabledProps} />
      <ToggleSwitch checked={false} label={unavailable}  {...disabledProps} />
    </WebuiInline>
    <WebuiInline justify="center" className="w-full px-3 py-1.5"><div className="h-px w-full bg-border_light" /></WebuiInline>
    <WebuiInline gap="small" justify="end" className="w-full overflow-hidden rounded-[12px] py-2 pl-3 pr-2"><DesktopGrayAction label="申请" external {...disabledProps} /></WebuiInline>
  </WebuiStack>;
}

function InfoIcon(): ReactElement {
  return <IconInfoCircle aria-hidden="true" size={16} stroke={1.4} className="text-icon_default_secondary" />;
}

function DesktopGrayAction({ label, dropdown = false, external = false, disabled = true, title, "aria-disabled": ariaDisabled = "true" }: { readonly label: string; readonly dropdown?: boolean; readonly external?: boolean; readonly disabled?: boolean; readonly title?: string; readonly "aria-disabled"?: "true" }): ReactElement {
  return <WebuiButton variant="surface-quiet" size="panel" disabled={disabled} aria-disabled={ariaDisabled} title={title}><span className="flex items-center justify-center gap-1">{label}{dropdown ? <ChevronDownIcon className="size-4 text-icon_default_secondary" /> : external ? <ExternalArrowIcon /> : null}</span></WebuiButton>;
}

function ChevronDownIcon({ className = "" }: { readonly className?: string }): ReactElement {
  return <IconChevronDown aria-hidden="true" className={className} size={16} stroke={1.5} />;
}

function ExternalArrowIcon(): ReactElement {
  return <IconExternalLink aria-hidden="true" className="h-4 w-4" size={16} stroke={1.5} />;
}
