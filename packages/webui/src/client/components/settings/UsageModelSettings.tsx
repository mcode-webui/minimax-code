import { useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { WebuiUsageQuotaResult } from "../../../shared/contracts/usage-quota.js";
import type { WebuiSettingsModalCapabilities } from "../SettingsModal.js";
import { ToggleSwitch } from "../ToggleSwitch.js";
import { reorderModelIds } from "../../projection/model-reorder.js";
import { formatResetLabel, getActiveSourceBadge, projectProviderHeaders, type ProviderHeaderDraft } from "../../projection/usage-settings.js";

type Props = {
  readonly capabilities: WebuiSettingsModalCapabilities;
  readonly sessionId?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function providerModels(provider: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(provider.models) ? provider.models.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object") : [];
}

function ProviderPresetPicker({ presets, selected, selectedName, onSelect }: { readonly presets: readonly Record<string, unknown>[]; readonly selected: string; readonly selectedName: string; readonly onSelect: (preset?: Record<string, unknown>) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visible = presets.filter((preset) => `${text(preset.name)} ${text(preset.providerId)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="webui-provider-picker" data-testid="settings-provider-preset-picker">
    <button type="button" aria-label="提供商" aria-expanded={open} className="webui-provider-picker-trigger" onClick={() => { setOpen((value) => !value); setQuery(""); }}>
      <span>{selectedName || <span className="webui-provider-picker-placeholder">请选择提供商</span>}</span>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="7.8" cy="7.8" r="5.5" stroke="currentColor" /><path d="m12 12 4 4" stroke="currentColor" strokeLinecap="round" /></svg>
    </button>
    {open ? <div className="webui-provider-picker-menu" role="listbox" aria-label="提供商列表">
      <label className="webui-provider-picker-search"><input autoFocus aria-label="搜索提供商" placeholder="搜索提供商..." value={query} onChange={(event) => setQuery(event.target.value)} /><svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" /><path d="m12 12 4 4" stroke="currentColor" strokeLinecap="round" /></svg></label>
      <div className="webui-provider-picker-options">{visible.length ? visible.map((preset) => {
        const id = text(preset.providerId);
        const name = text(preset.name) || id;
        const iconUrl = text(preset.iconUrl);
        return <button key={id} type="button" role="option" aria-selected={selected === id} className="webui-provider-picker-option" onClick={() => { onSelect(preset); setOpen(false); setQuery(""); }}><span className="webui-provider-picker-icon">{iconUrl ? <img src={iconUrl} alt="" /> : name.slice(0, 1)}</span><span>{name}</span>{selected === id ? <span className="webui-provider-picker-check" aria-hidden="true">✓</span> : null}</button>;
      }) : <p className="webui-provider-picker-empty" role="status">没有匹配的提供商</p>}</div>
      <div className="webui-provider-picker-other"><button type="button" role="option" aria-selected={selected === "__other__"} onClick={() => { onSelect(); setOpen(false); setQuery(""); }}><span aria-hidden="true">＋</span>其他</button></div>
    </div> : null}
  </div>;
}

export function UsageModelSettings({ capabilities, sessionId }: Props): ReactElement {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [sourceTab, setSourceTab] = useState<"token-plan" | "minimax-api" | "custom">("token-plan");
  const [activeSource, setActiveSource] = useState<"token_plan" | "minimax_api_key">();
  const [sourceLoaded, setSourceLoaded] = useState(false);
  const [quota, setQuota] = useState<WebuiUsageQuotaResult>();
  const [quotaLoading, setQuotaLoading] = useState(true);
  const [quotaError, setQuotaError] = useState<string>();
  const [apiStatus, setApiStatus] = useState<Record<string, unknown>>();
  const [apiLoading, setApiLoading] = useState(true);
  const [apiError, setApiError] = useState<string>();
  const [apiKey, setApiKey] = useState("");
  const [quotaClock, setQuotaClock] = useState(() => Date.now());
  const [savingKey, setSavingKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyResult, setKeyResult] = useState<string>();
  const [providers, setProviders] = useState<readonly Record<string, unknown>[]>([]);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [providerLoading, setProviderLoading] = useState(true);
  const [providerError, setProviderError] = useState<string>();
  const [oauth, setOauth] = useState<Record<string, unknown>>();
  const [oauthError, setOauthError] = useState<string>();
  const [oauthLoginId, setOauthLoginId] = useState<string>();
  const [editingProvider, setEditingProvider] = useState<string>();
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [providerPendingDelete, setProviderPendingDelete] = useState<Record<string, unknown>>();
  const [draftName, setDraftName] = useState("");
  const [draftBaseUrl, setDraftBaseUrl] = useState("");
  const [draftApiKey, setDraftApiKey] = useState("");
  const [draftModelId, setDraftModelId] = useState("");
  const [draftApiFormat, setDraftApiFormat] = useState("openai-completions");
  const [draftHeaders, setDraftHeaders] = useState<readonly ProviderHeaderDraft[]>([]);
  const [originalHeaderNames, setOriginalHeaderNames] = useState<readonly string[]>([]);
  const [draftTested, setDraftTested] = useState(false);
  const [skipTest, setSkipTest] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [presets, setPresets] = useState<readonly Record<string, unknown>[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>();

  const loadQuota = async () => {
    setQuotaLoading(true); setQuotaError(undefined);
    try { const result = await capabilities.getUsageQuota?.(); if (!result) throw new Error("Usage quota capability unavailable"); setQuota(result); }
    catch (error) { setQuotaError(error instanceof Error ? error.message : String(error)); }
    finally { setQuotaLoading(false); }
  };
  const loadApiStatus = async () => {
    setApiLoading(true); setApiError(undefined);
    try { const result = await capabilities.getMiniMaxApiKeyStatus?.(); if (!result) throw new Error("MiniMax API key status unavailable"); setApiStatus(result); }
    catch (error) { setApiError(error instanceof Error ? error.message : String(error)); }
    finally { setApiLoading(false); }
  };
  const loadProviders = async () => {
    setProviderLoading(true); setProviderError(undefined);
    try { setProviders(await capabilities.listUserModelProviders?.() ?? []); }
    catch (error) { setProviderError(error instanceof Error ? error.message : String(error)); }
    finally { setProviderLoading(false); }
  };
  useEffect(() => {
    void loadQuota(); void loadApiStatus(); void loadProviders();
    void capabilities.getMiniMaxModelSource?.().then((source) => { setActiveSource(source); setSourceLoaded(true); }).catch(() => setSourceLoaded(false));
    void capabilities.getCodexOAuthStatus?.().then(setOauth).catch((error) => setOauthError(error instanceof Error ? error.message : String(error)));
  // Calls are stable bound functions from the modal's transport object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  useEffect(() => {
    const timer = setInterval(() => setQuotaClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!oauthLoginId || !capabilities.getCodexOAuthStatus) return;
    const timer = setInterval(() => {
      void capabilities.getCodexOAuthStatus?.().then((status) => {
        setOauth(status);
        if (status.state === "connected") setOauthLoginId(undefined);
      }).catch((error) => setOauthError(error instanceof Error ? error.message : String(error)));
    }, 1000);
    return () => clearInterval(timer);
  }, [capabilities.getCodexOAuthStatus, oauthLoginId]);

  const chooseSource = async (source: "token_plan" | "minimax_api_key") => {
    setSourceTab(source === "token_plan" ? "token-plan" : "minimax-api");
    if (source === activeSource || !capabilities.setMiniMaxModelSource) return;
    if (source === "minimax_api_key" && apiStatus?.valid !== true) return;
    try { setActiveSource(await capabilities.setMiniMaxModelSource(source)); }
    catch (error) { setKeyResult(error instanceof Error ? error.message : String(error)); }
  };
  const testKey = async () => {
    if ((!apiKey.trim() && !apiValid) || !capabilities.testUserModelProvider) return;
    setTestingKey(true); setKeyResult(undefined);
    try {
      const result = record(await capabilities.testUserModelProvider({ providerId: "minimax_api", ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }));
      setKeyResult(result.success === true ? "连接成功" : text(record(result.status).lastErrorMessage) || "连接失败");
    } catch (error) { setKeyResult(error instanceof Error ? error.message : String(error)); }
    finally { setTestingKey(false); }
  };
  const saveKey = async () => {
    if (!apiKey.trim() || !capabilities.upsertMiniMaxApiKey) return;
    setSavingKey(true); setKeyResult(undefined);
    try { await capabilities.upsertMiniMaxApiKey({ apiKey: apiKey.trim(), saveAndUse: true }); setActiveSource("minimax_api_key"); await loadApiStatus(); }
    catch (error) { setKeyResult(error instanceof Error ? error.message : String(error)); }
    finally { setSavingKey(false); }
  };
  const beginCodexLogin = async () => {
    if (!capabilities.startCodexOAuthLogin) return;
    const popup = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    setOauthError(undefined);
    try {
      const result = record(await capabilities.startCodexOAuthLogin({}));
      const loginId = text(result.loginId);
      const authUrl = text(result.authUrl);
      if (loginId) setOauthLoginId(loginId);
      if (authUrl && popup) popup.location.replace(authUrl);
      else if (popup) popup.close();
      const status = record(result.status);
      if (Object.keys(status).length) setOauth(status);
    } catch (error) {
      popup?.close();
      setOauthError(error instanceof Error ? error.message : String(error));
    }
  };
  const cancelCodexLogin = async () => {
    if (!oauthLoginId || !capabilities.cancelCodexOAuthLogin) return;
    try { setOauth(await capabilities.cancelCodexOAuthLogin({ loginId: oauthLoginId }) as Record<string, unknown>); setOauthLoginId(undefined); }
    catch (error) { setOauthError(error instanceof Error ? error.message : String(error)); }
  };
  const openProviderForm = async (provider?: Record<string, unknown>) => {
    setFormError(undefined); setDraftTested(false); setSkipTest(false);
    setEditingProvider(provider ? text(provider.providerId) : undefined);
    setSelectedPresetId(undefined);
    setDraftName(text(provider?.name)); setDraftBaseUrl(text(provider?.baseUrl));
    setDraftApiFormat(text(provider?.apiFormat) || "openai-completions"); setDraftModelId(providerModels(provider ?? {}).map((model) => text(model.modelId)).filter(Boolean).join("\n"));
    const entries = Object.entries(record(provider?.headers));
    setOriginalHeaderNames(entries.map(([name]) => name));
    setDraftHeaders(entries.map(([name, value], index) => ({ id: `${text(provider?.providerId) || "new"}-${index}`, name, value: String(value), persistedName: name })));
    setDraftApiKey(""); setShowProviderForm(true);
    try { setPresets(await capabilities.listProviderPresets?.() ?? []); }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)); }
    if (provider && capabilities.revealModelProviderApiKey) {
      try { setDraftApiKey(await capabilities.revealModelProviderApiKey({ providerId: text(provider.providerId) })); }
      catch (error) { setFormError(error instanceof Error ? error.message : String(error)); }
    }
  };
  const draftCandidate = () => {
    const headerProjection = projectProviderHeaders(draftHeaders, originalHeaderNames);
    return {
      ...(editingProvider ? { providerId: editingProvider } : {}),
      ...(editingProvider && typeof providers.find((provider) => provider.providerId === editingProvider)?.revision === "string" ? { expectedRevision: text(providers.find((provider) => provider.providerId === editingProvider)?.revision) } : {}),
      name: draftName.trim(), baseUrl: draftBaseUrl.trim(), apiKey: draftApiKey,
      apiFormat: draftApiFormat,
      ...headerProjection,
      models: draftModelId.split("\n").map((modelId) => modelId.trim()).filter(Boolean).map((modelId) => ({ modelId })),
    };
  };
  const runCandidateTest = async () => {
    if (!capabilities.testUserModelCandidate || !draftModelId.trim()) return;
    const headers = projectProviderHeaders(draftHeaders, originalHeaderNames);
    if (headers.error) { setFormError(headers.error === "duplicate-name" ? "Header 名称不能重复" : "新增 Header 必须填写值"); return; }
    setFormBusy(true); setFormError(undefined); setDraftTested(false);
    try { const result = record(await capabilities.testUserModelCandidate({ candidate: draftCandidate(), modelId: draftModelId.split("\n")[0]!.trim() })); if (result.ok !== true && result.success !== true) throw new Error(text(record(result.status).lastErrorMessage) || "连接失败"); setDraftTested(true); }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)); }
    finally { setFormBusy(false); }
  };
  const saveProvider = async () => {
    if (!capabilities.saveUserModelProviderCandidate || (!draftTested && !skipTest)) return;
    const headers = projectProviderHeaders(draftHeaders, originalHeaderNames);
    if (headers.error) { setFormError(headers.error === "duplicate-name" ? "Header 名称不能重复" : "新增 Header 必须填写值"); return; }
    setFormBusy(true); setFormError(undefined);
    try { const result = record(await capabilities.saveUserModelProviderCandidate({ candidate: draftCandidate(), modelId: draftModelId.split("\n")[0]?.trim(), saveAndUse: false, skipConnectionTest: skipTest })); if (result.success !== true) throw new Error("保存失败"); setShowProviderForm(false); await loadProviders(); }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)); }
    finally { setFormBusy(false); }
  };
  const confirmDeleteProvider = async () => {
    const id = text(providerPendingDelete?.providerId);
    if (!id || !capabilities.deleteUserModelProvider) return;
    setFormBusy(true);
    try { await capabilities.deleteUserModelProvider(id); setProviderPendingDelete(undefined); await loadProviders(); }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)); }
    finally { setFormBusy(false); }
  };
  const toggleModel = async (providerId: string, model: Record<string, unknown>, enabled: boolean) => {
    const nextModels = providerModels(providers.find((provider) => provider.providerId === providerId) ?? {}).map((candidate) =>
      candidate.modelId === model.modelId ? { ...candidate, enabled } : candidate,
    );
    setProviders((items) => items.map((provider) => provider.providerId === providerId ? { ...provider, models: nextModels } : provider));
    try { await capabilities.updateUserModelProvider?.({ providerId, models: nextModels }); }
    catch (error) { setProviderError(error instanceof Error ? error.message : String(error)); await loadProviders(); }
  };
  const quotaView = quota?.signedIn ? quota : undefined;
  const quotaData = quotaView && "quota" in quotaView ? quotaView.quota : undefined;
  const apiValid = apiStatus?.valid === true;
  const resetLabel = (resetAtMs?: number) => formatResetLabel(resetAtMs, quotaClock);
  const sourceLabel = sourceTab === "token-plan" ? "Token Plan" : "MiniMax API";
  const sourceBadge = getActiveSourceBadge(sourceLoaded, activeSource, quotaView?.hasTokenPlan === true);

  return <div className="mx-auto flex min-h-0 w-full max-w-[704px] flex-1 flex-col gap-4" data-testid="settings-usage-model">
    <div className="flex h-8 items-center gap-3">
      <div className="relative">
      <div className={`flex h-8 items-center overflow-hidden rounded-[8px] text-[14px] font-medium leading-5 transition-colors ${sourceTab !== "custom" ? "bg-bg_interaction_tertiary_hover text-text_default_primary" : "text-text_default_secondary hover:bg-bg_interaction_tertiary_hover"}`}>
        <button type="button" data-testid="settings-usage-source-tab" className="flex h-full pl-3 pr-1 items-center" onClick={() => setSourceMenuOpen((open) => !open)}>{sourceLabel}{sourceBadge ? <span className={`rounded-[6px] px-1 py-0.5 text-[12px] leading-4 ${sourceBadge === "使用中" ? "bg-bg_status_positive text-icon_status_success" : "bg-[rgba(10,10,10,0.04)] text-[#666]"}`}>{sourceBadge}</span> : null}</button>
        <button type="button" aria-label="选择模型来源" className="flex h-full w-7 items-center justify-center hover:bg-bg_interaction_tertiary_hover" onClick={() => setSourceMenuOpen((open) => !open)}><ChevronDownIcon /></button>
      </div>
      {sourceMenuOpen ? <div className="absolute left-0 top-full z-10 mt-1 flex min-w-[180px] flex-col rounded-[12px] bg-bg_default_primary p-1.5 shadow-lg"><button type="button" className="flex h-[30px] items-center rounded-[8px] px-3 text-left text-sm hover:bg-bg_interaction_tertiary_hover" onClick={() => { setSourceMenuOpen(false); void chooseSource("token_plan"); }}>Token Plan</button><button type="button" className="flex h-[30px] items-center rounded-[8px] px-3 text-left text-sm hover:bg-bg_interaction_tertiary_hover" onClick={() => { setSourceMenuOpen(false); void chooseSource("minimax_api_key"); }}>MiniMax API</button></div> : null}
      </div>
      <div className="h-3 w-[0.5px] bg-border_default" />
      <button type="button" className={`h-8 rounded-[8px] px-3 text-[14px] font-medium leading-5 transition-colors ${sourceTab === "custom" ? "bg-bg_interaction_tertiary_hover text-text_default_primary" : "text-text_default_secondary hover:bg-bg_interaction_tertiary_hover"}`} onClick={() => setSourceTab("custom")}>自定义模型</button>
    </div>

    {sourceTab === "token-plan" ? <section className="flex w-full flex-col gap-4" data-testid="settings-usage-token-plan">
      {quotaLoading ? <p>加载中…</p> : quotaError ? <div role="alert" className="flex items-center gap-3"><span>加载失败</span><button type="button" onClick={() => void loadQuota()}>重试</button></div> : !quotaView ? <p>登录后查看用量</p> : <>
        <section className="flex w-full flex-col gap-2" data-testid="settings-usage-plan">
          <h3 className="px-4 text-[14px] font-medium leading-5">当前套餐</h3>
          <div className="flex w-full flex-col rounded-[16px] bg-bg_grouped_tertiary p-1">
            <div className="flex min-h-[64px] w-full items-center gap-6 overflow-hidden rounded-[12px] py-2 pl-3 pr-2"><div className="min-w-0"><span className="block text-[14px] leading-5">{quotaView.tokenPlanTier || (quotaView.hasTokenPlan ? "Token Plan" : "未订阅 Token Plan")}</span>{quotaView.tokenPlanExpiresAt ? <span className="mt-1 block text-[12px] leading-4 text-text_default_secondary">{new Date(quotaView.tokenPlanExpiresAt < 1e12 ? quotaView.tokenPlanExpiresAt * 1000 : quotaView.tokenPlanExpiresAt).toLocaleDateString("sv-SE").replaceAll("-", ".")}{quotaView.willRenewal ? " 自动续费" : ""}</span> : null}</div></div>
            <div className="h-[0.5px] bg-border_default" />
            <div className="flex min-h-[64px] w-full items-center gap-6 overflow-hidden rounded-[12px] py-2 pl-3 pr-2"><div><span className="block text-[14px] leading-5">积分</span><span className="mt-1 block text-[12px] leading-4 text-text_default_secondary">剩余 {quotaView.purchasedCredits !== undefined && quotaView.freeCredits !== undefined ? `${formatCredits(quotaView.purchasedCredits)} + ${formatCredits(quotaView.freeCredits)}` : formatCredits(quotaView.creditBalance)}</span></div></div>
          </div>
        </section>
        {quotaData ? <section className="flex w-full flex-col gap-2" data-testid="settings-usage-limits"><h3 className="px-4 text-[14px] font-medium leading-5">用量</h3><div className="flex w-full flex-col rounded-[16px] bg-bg_grouped_tertiary p-1">{([["5 小时限额", quotaData.fiveHour], ["周限额", quotaData.weekly], ...(quotaData.video ? [["视频限额", quotaData.video] as const] : [])] as const).map(([label, window]) => { const value = record(window); const usedPercent = typeof value.usedPercent === "number" ? value.usedPercent : undefined; const usedCount = typeof value.usedCount === "number" ? value.usedCount : undefined; const totalCount = typeof value.totalCount === "number" ? value.totalCount : undefined; const percent = Math.round(usedPercent ?? (totalCount ? (usedCount ?? 0) / totalCount * 100 : 0)); const resetAtMs = typeof value.resetAtMs === "number" ? value.resetAtMs : undefined; const reset = resetLabel(resetAtMs); return <div key={label} className="flex min-h-[72px] flex-col justify-center gap-2 overflow-hidden rounded-[12px] py-2 pl-3 pr-2"><div className="flex items-center justify-between gap-3"><span className="text-[14px] font-normal leading-5 text-text_default_primary">{label}</span><span className="shrink-0 text-[13px] leading-5 text-text_default_secondary">{window.unlimited ? "无限制" : usedCount !== undefined ? `${usedCount}/${totalCount ?? 0}` : `${usedPercent ?? 0}% / 100%`}</span></div><div className="h-1 w-full overflow-hidden rounded-full bg-bg_interaction_tertiary_press"><div className="h-full rounded-full bg-text_default_primary" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>{reset ? <span className="text-[12px] font-normal leading-4 text-text_default_secondary">{reset}</span> : null}</div>; })}</div></section> : null}
        <section className="flex w-full flex-col gap-2" data-testid="settings-usage-points"><h3 className="flex items-center gap-2 px-4 text-[14px] font-medium leading-5">积分 <InfoIcon /></h3><div className="flex min-h-[48px] w-full items-center justify-between gap-4 rounded-[16px] bg-bg_grouped_tertiary px-4 py-2"><span>开启后，可以在对话中消耗你的积分（含赠予积分）。</span><ToggleSwitch checked={false} label="消耗积分" disabled title="Disabled (not yet wired)" className="shrink-0 disabled:opacity-60" /></div></section>
      </>}
    </section> : null}

    {sourceTab === "minimax-api" ? <section className="flex w-full flex-col gap-2 pt-1" data-testid="settings-minimax-api-panel">
      <div className="flex items-center gap-2"><label className="text-[14px] font-medium leading-5 text-text_default_primary">API Key</label><span className={`rounded-[6px] px-1 py-0.5 text-[12px] leading-4 ${apiValid ? "bg-bg_status_positive text-icon_status_success" : "bg-[rgba(10,10,10,0.04)] text-[#666]"}`}>{apiValid ? "使用中" : "未启用"}</span></div>
      {apiLoading ? <p>加载中…</p> : apiError ? <div role="alert" className="flex items-center gap-3"><span>{apiError}</span><button type="button" onClick={() => void loadApiStatus()}>重试</button></div> : <>
        <div className="flex items-center gap-3"><input aria-label="API Key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={apiValid ? text(apiStatus?.maskedApiKey) : "请输入API Key"} className="min-w-0 flex-[1_0_0] rounded-[8px] border border-border_default bg-bg_default_primary px-3 py-2 text-[14px]" /><IconButton label="测试连通性" disabled={testingKey || (!apiKey.trim() && !apiValid)} onClick={() => void testKey()} viewBox="0 0 20 20" svgFill="none"><RefreshIcon /></IconButton></div>
        {keyResult ? <p role="status">{keyResult}</p> : null}<button type="button" disabled={!apiKey.trim() || savingKey} className="mt-1 h-9 w-[116px] rounded-[8px] bg-bg_interaction_tertiary_hover px-3 text-[14px] disabled:opacity-60" onClick={() => void saveKey()}>{savingKey ? "保存中…" : "保存并使用"}</button>
      </>}
    </section> : null}

    {sourceTab === "custom" ? <section className="flex min-h-0 flex-1 flex-col gap-3" data-testid="settings-custom-models-panel">
      {providerLoading ? <p>模型加载中...</p> : providerError ? <div role="alert"><span>{providerError}</span><button type="button" onClick={() => void loadProviders()}>重试</button></div> : <>
        {providers.length === 0 ? <p>暂未添加自定义模型</p> : providers.map((provider) => {
          const id = text(provider.providerId);
          const models = providerModels(provider);
          const ids = models.map((model, index) => text(model.modelId) || `${id}-${index}`);
          return <div key={id} className="flex w-full flex-col gap-2">
            <div className="flex h-6 items-center justify-between pl-4 pr-3">
              <div className="flex min-w-0 items-center gap-2"><span className="truncate text-[14px] font-medium leading-5 text-text_default_primary">{text(provider.name) || id}</span>{provider.kind === "oauth" ? <span className="rounded-[6px] bg-bg_interaction_tertiary_press px-1 text-[12px]">OAuth</span> : null}</div>
              <div className="flex items-center gap-2">
                <IconButton label="编辑提供商" onClick={() => void openProviderForm(provider)}><path d="M9.47052 2.9037C10.4714 1.9029 12.0945 1.90312 13.0955 2.9037C14.0963 3.9047 14.0964 5.52775 13.0955 6.5287L6.76935 12.8559C6.37727 13.2479 5.86805 13.5029 5.31915 13.5814L3.54767 13.8344C2.74184 13.9495 2.05079 13.2583 2.16583 12.4525L2.41876 10.681C2.49721 10.132 2.7522 9.623 3.14435 9.23085L9.47052 2.9037ZM3.92169 10.0092C3.69798 10.2329 3.55245 10.5231 3.50763 10.8363L3.2547 12.6078C3.24339 12.6875 3.31173 12.7566 3.39142 12.7455L5.1629 12.4926C5.47619 12.4478 5.76722 12.3023 5.99103 12.0785L10.9813 7.0873L8.91193 5.01796L3.92169 10.0092ZM12.3182 3.68202C11.7468 3.11062 10.8203 3.11066 10.2488 3.68202L9.68927 4.24062L11.7586 6.30995L12.3182 5.75136C12.8895 5.18001 12.8893 4.25345 12.3182 3.68202Z" /></IconButton>
                <IconButton label="删除" disabled={!capabilities.deleteUserModelProvider} onClick={() => { setFormError(undefined); setProviderPendingDelete(provider); }}><path d="M9.80273 1.80527C10.605 1.80541 11.2549 2.45615 11.2549 3.2584V4.35606H14.666C14.9422 4.35606 15.166 4.57991 15.166 4.85606C15.1658 5.132 14.942 5.35606 14.666 5.35606H12.8096L12.7861 5.68027L12.3281 11.9645C12.2362 13.2214 11.1891 14.1948 9.92871 14.1949H5.99414C4.72231 14.1949 3.67 13.2045 3.59277 11.9352L3.21387 5.67442L3.19434 5.35606H1.33301C1.05715 5.3559 0.833241 5.1319 0.833008 4.85606C0.833008 4.58001 1.057 4.35622 1.33301 4.35606H4.74512V3.2584C4.74512 2.45607 5.39591 1.80527 6.19824 1.80527H9.80273ZM4.21191 5.61387L4.59082 11.8746C4.63603 12.6162 5.25109 13.1949 5.99414 13.1949H9.92871C10.6649 13.1948 11.2761 12.6263 11.3301 11.8922L11.7891 5.60801L11.8076 5.35606H4.19629L4.21191 5.61387ZM6.19824 2.80527C5.9482 2.80527 5.74512 3.00835 5.74512 3.2584V4.35606H10.2549V3.2584C10.2549 3.00844 10.0527 2.80541 9.80273 2.80527H6.19824Z" /></IconButton>
              </div>
            </div>
            {models.length ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={async (event: DragEndEvent) => {
              const over = event.over?.id; const active = event.active.id;
              if (!over || active === over) return;
              const orderedIds = reorderModelIds(ids, String(active), String(over));
              const nextModels = orderedIds.map((modelId) => models[ids.indexOf(modelId)]).filter((model): model is Record<string, unknown> => model !== undefined);
              setProviders((items) => items.map((item) => item.providerId === id ? { ...item, models: nextModels } : item));
              await capabilities.updateUserModelProvider?.({ providerId: id, models: nextModels });
            }}><SortableContext items={ids} strategy={verticalListSortingStrategy}><div className="w-full rounded-[16px] bg-bg_grouped_tertiary p-1">{models.map((model, index) => <SortableModelRow key={ids[index]} id={ids[index]!} model={model} onTest={() => void capabilities.testUserModel?.({ providerId: id, modelId: text(model.modelId) })} onToggle={(enabled) => void toggleModel(id, model, enabled)} />)}</div></SortableContext></DndContext> : null}
          </div>;
        })}
        <button type="button" disabled={!capabilities.saveUserModelProviderCandidate} className="h-9 w-fit rounded-[8px] px-3" onClick={() => void openProviderForm()}>添加模型</button>
        {showProviderForm && typeof document !== "undefined" ? createPortal(<div role="dialog" aria-modal="true" aria-label={editingProvider ? "编辑提供商" : "添加模型"} className="webui-provider-dialog-backdrop"><form className="webui-provider-form" onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
          <header className="webui-provider-form-header"><h3>{editingProvider ? "编辑提供商" : "添加模型"}</h3><button type="button" aria-label="关闭" onClick={() => setShowProviderForm(false)}><CloseIcon /></button></header>
          <div className="webui-provider-form-body">
            {!editingProvider ? <div className="webui-provider-form-provider-grid"><label className="webui-provider-form-field">提供商<ProviderPresetPicker presets={presets} selected={selectedPresetId ?? ""} selectedName={selectedPresetId && selectedPresetId !== "__other__" ? draftName : ""} onSelect={(preset) => { if (!preset) { setSelectedPresetId("__other__"); setDraftName(""); setDraftBaseUrl(""); setDraftApiFormat("openai-completions"); setDraftModelId(""); return; } setSelectedPresetId(text(preset.providerId)); setDraftName(text(preset.name)); setDraftBaseUrl(text(preset.baseUrl)); setDraftApiFormat(text(preset.apiFormat)); setDraftModelId(""); }} /></label>{selectedPresetId === "__other__" ? <label className="webui-provider-form-field">提供商名称<input aria-label="提供商名称" value={draftName} onChange={(event) => setDraftName(event.target.value)} required /></label> : null}</div> : null}
            {editingProvider ? <label className="webui-provider-form-field">提供商名称<input value={draftName} onChange={(event) => setDraftName(event.target.value)} required /></label> : null}
            <div className="webui-provider-form-provider-grid"><label className="webui-provider-form-field">API 格式<input value={draftApiFormat} onChange={(event) => setDraftApiFormat(event.target.value)} /></label><label className="webui-provider-form-field">接口地址<input value={draftBaseUrl} onChange={(event) => setDraftBaseUrl(event.target.value)} required />{editingProvider && providers.find((provider) => provider.providerId === editingProvider)?.revision ? <button type="button" disabled={!capabilities.discoverUserModelsCandidate || formBusy} onClick={async () => { const provider = providers.find((item) => item.providerId === editingProvider); try { const result = await capabilities.discoverUserModelsCandidate?.({ providerId: editingProvider, expectedRevision: text(provider?.revision), baseUrl: draftBaseUrl }); if (Array.isArray(result) && result.length) setDraftModelId(result.map((item) => text(record(item).modelId)).filter(Boolean).join("\n")); } catch (error) { setFormError(error instanceof Error ? error.message : String(error)); } }}>自动获取</button> : null}</label></div>
            <label className="webui-provider-form-field">API Key<input type="password" value={draftApiKey} onChange={(event) => { setDraftApiKey(event.target.value); setDraftTested(false); }} placeholder={editingProvider ? "留空保留原值" : ""} required={!editingProvider} /></label>
            <label className="webui-provider-form-field">模型名称<textarea value={draftModelId} onChange={(event) => { setDraftModelId(event.target.value); setDraftTested(false); }} required /></label>
            <div className="webui-provider-form-headers"><div className="text-[13px] font-medium leading-5 text-text_default_primary">自定义 Headers</div>{draftHeaders.map((header) => <div key={header.id} className="webui-provider-form-header-row"><input aria-label="Header 名称" placeholder="Header 名称" value={header.name} onChange={(event) => setDraftHeaders((items) => items.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))} /><input aria-label="Header 值" placeholder={header.persistedName ? "留空保留原值" : "Header 值"} value={header.value} onChange={(event) => setDraftHeaders((items) => items.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))} /><IconButton label="移除 Header" onClick={() => setDraftHeaders((items) => items.filter((item) => item.id !== header.id))}><path d="M9.80273 1.80527C10.605 1.80541 11.2549 2.45615 11.2549 3.2584V4.35606H14.666C14.9422 4.35606 15.166 4.57991 15.166 4.85606C15.1658 5.132 14.942 5.35606 14.666 5.35606H12.8096L12.7861 5.68027L12.3281 11.9645C12.2362 13.2214 11.1891 14.1948 9.92871 14.1949H5.99414C4.72231 14.1949 3.67 13.2045 3.59277 11.9352L3.21387 5.67442L3.19434 5.35606H1.33301C1.05715 5.3559 0.833241 5.1319 0.833008 4.85606C0.833008 4.58001 1.057 4.35622 1.33301 4.35606H4.74512V3.2584C4.74512 2.45607 5.39591 1.80527 6.19824 1.80527H9.80273ZM4.21191 5.61387L4.59082 11.8746C4.63603 12.6162 5.25109 13.1949 5.99414 13.1949H9.92871C10.6649 13.1948 11.2761 12.6263 11.3301 11.8922L11.7891 5.60801L11.8076 5.35606H4.19629L4.21191 5.61387ZM6.19824 2.80527C5.9482 2.80527 5.74512 3.00835 5.74512 3.2584V4.35606H10.2549V3.2584C10.2549 3.00844 10.0527 2.80541 9.80273 2.80527H6.19824Z" /></IconButton></div>)}<button type="button" className="webui-provider-form-add-header" onClick={() => setDraftHeaders((items) => [...items, { id: `new-${Date.now()}-${items.length}`, name: "", value: "" }])}>＋ 添加 Header</button></div>
            {formError ? <p role="alert" className="webui-provider-form-error">{formError}</p> : null}
          </div>
          <footer className="webui-provider-form-actions"><label><input type="checkbox" checked={skipTest} onChange={(event) => setSkipTest(event.target.checked)} />跳过连通检测</label><span /><button type="button" disabled={formBusy || !draftModelId.trim()} onClick={() => void runCandidateTest()}>连通检测</button><button type="button" disabled={formBusy} onClick={() => setShowProviderForm(false)}>取消</button><button type="submit" disabled={formBusy || (!draftTested && !skipTest)}>{formBusy ? "加载中…" : "保存"}</button></footer>
        </form></div>, document.body) : null}
        {providerPendingDelete ? <div role="dialog" aria-modal="true" aria-label={`删除供应商${text(providerPendingDelete.name)}`} className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.25)]"><div className="w-[480px] overflow-clip rounded-[20px] bg-bg_grouped_secondary p-6" style={{ boxShadow: "0 4px 10px 0 rgba(0,0,0,0.04)" }}><div className="flex flex-col gap-6"><div className="flex flex-col gap-4"><div className="flex items-center justify-between"><h3 className="text-[18px] font-medium leading-[26px] text-text_default_primary">删除供应商"{text(providerPendingDelete.name)}"吗？</h3><button type="button" aria-label="关闭" className="flex size-[22px] items-center justify-center text-icon_default_tertiary hover:text-icon_default_secondary" onClick={() => setProviderPendingDelete(undefined)}><CloseIcon /></button></div><p className="text-[14px] leading-5 text-text_default_secondary">删除后将移除该供应商下的所有模型选项。</p></div>{formError ? <p role="alert">{formError}</p> : null}<div className="flex justify-end gap-4"><button type="button" disabled={formBusy} className="h-9 min-w-[68px] rounded-[8px] px-4" onClick={() => setProviderPendingDelete(undefined)}>取消</button><button type="button" disabled={formBusy} className="h-9 min-w-[68px] rounded-[8px] bg-bg_status_error px-4" onClick={() => void confirmDeleteProvider()}>{formBusy ? "删除中…" : "删除"}</button></div></div></div></div> : null}
        {oauthError ? <p role="alert">{oauthError}</p> : oauth?.state === "connected" ? <div className="flex items-center gap-3"><span>Codex OAuth 已连接</span><button type="button" disabled={!capabilities.refreshModels} onClick={() => void capabilities.refreshModels?.()}>获取模型列表</button></div> : <div className="flex items-center gap-2"><button type="button" disabled={!capabilities.startCodexOAuthLogin || Boolean(oauthLoginId)} onClick={() => void beginCodexLogin()}>{oauthLoginId ? "正在连接 Codex OAuth" : "连接 Codex OAuth"}</button>{oauthLoginId ? <button type="button" disabled={!capabilities.cancelCodexOAuthLogin} onClick={() => void cancelCodexLogin()}>取消</button> : null}</div>}
      </>}
    </section> : null}
  </div>;
}

export function DisabledBillingActions(): ReactElement {
  const unavailable = "Disabled (not yet wired)";
  const disabledProps = { disabled: true, "aria-disabled": "true" as const, title: unavailable };
  return <div className="flex w-full flex-col rounded-[16px] bg-bg_grouped_tertiary p-1" aria-label={unavailable}>
    <div className="flex w-full items-center justify-end gap-2 overflow-hidden rounded-[12px] py-2 pl-3 pr-2">
      <DesktopGrayAction label="升级" {...disabledProps} />
      <DesktopGrayAction label="管理" dropdown {...disabledProps} />
      <DesktopGrayAction label="开启自动续费" {...disabledProps} />
    </div>
    <div className="flex w-full items-center justify-center px-3 py-1.5"><div className="h-px w-full bg-border_light" /></div>
    <div className="flex w-full items-center justify-end gap-2 overflow-hidden rounded-[12px] py-2 pl-3 pr-2">
      <DesktopGrayAction label="去充值" {...disabledProps} />
      <DesktopGrayAction label="管理" dropdown {...disabledProps} />
      <DesktopGrayAction label="明细" {...disabledProps} />
      <ToggleSwitch checked={false} label={unavailable} className="disabled:opacity-60" {...disabledProps} />
    </div>
    <div className="flex w-full items-center justify-center px-3 py-1.5"><div className="h-px w-full bg-border_light" /></div>
    <div className="flex w-full items-center justify-end gap-2 overflow-hidden rounded-[12px] py-2 pl-3 pr-2"><DesktopGrayAction label="申请" external {...disabledProps} /></div>
  </div>;
}


function formatCredits(value: string | undefined): string {
  if (value === undefined) return "—";
  const numeric = Number(value.replace(/,/gu, ""));
  return Number.isFinite(numeric) && value.trim() ? Math.trunc(numeric).toLocaleString("en-US") : value;
}

function InfoIcon(): ReactElement {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-icon_default_secondary"><circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1" /><path d="M8 7.25v3.5M8 5.25h.01" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>;
}

function DesktopGrayAction({ label, dropdown = false, external = false, disabled = true, title, "aria-disabled": ariaDisabled = "true" }: { readonly label: string; readonly dropdown?: boolean; readonly external?: boolean; readonly disabled?: boolean; readonly title?: string; readonly "aria-disabled"?: "true" }): ReactElement {
  return <button type="button" disabled={disabled} aria-disabled={ariaDisabled} title={title} className="h-8 shrink-0 !px-3 !py-0 !font-medium !leading-5 text-[14px] text-text_default_primary disabled:opacity-60"><span className="flex items-center justify-center gap-1">{label}{dropdown ? <ChevronDownIcon className="size-4 text-icon_default_secondary" /> : external ? <ExternalArrowIcon /> : null}</span></button>;
}

function IconButton({ label, disabled = false, onClick, children, viewBox = "0 0 16 16", svgFill = "currentColor" }: { readonly label: string; readonly disabled?: boolean; readonly onClick: () => void; readonly children: React.ReactNode; readonly viewBox?: "0 0 16 16" | "0 0 20 20"; readonly svgFill?: "none" | "currentColor" }): ReactElement {
  return <button type="button" aria-label={label} disabled={disabled} className="flex size-7 items-center justify-center text-icon_default_tertiary hover:text-icon_default_secondary disabled:cursor-default disabled:opacity-60" onClick={onClick}><svg aria-hidden="true" width="16" height="16" viewBox={viewBox} fill={svgFill}>{children}</svg></button>;
}

function CloseIcon(): ReactElement {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11.2636 4.02491C11.4587 3.82986 11.7754 3.83007 11.9706 4.02491C12.1658 4.22015 12.1658 4.5367 11.9706 4.73194L8.7099 7.99268L11.9706 11.2534C12.1657 11.4487 12.1659 11.7652 11.9706 11.9605C11.7754 12.1556 11.4589 12.1555 11.2636 11.9605L8.00287 8.69971L4.74213 11.9605C4.54688 12.1556 4.23033 12.1556 4.0351 11.9605C3.84027 11.7652 3.84008 11.4486 4.0351 11.2534L7.29584 7.99268L4.0351 4.73194C3.84024 4.53666 3.84 4.22004 4.0351 4.02491C4.23022 3.82978 4.54683 3.83005 4.74213 4.02491L8.00287 7.28565L11.2636 4.02491Z" fill="currentColor" /></svg>;
}

function ChevronDownIcon({ className = "" }: { readonly className?: string }): ReactElement {
  return <svg aria-hidden="true" className={className} width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 6L8 10L4 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ExternalArrowIcon(): ReactElement {
  return <svg aria-hidden="true" className="h-4 w-4" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.40497 4.24121C6.12883 4.24121 5.90497 4.46507 5.90497 4.74121C5.90497 5.01735 6.12883 5.24121 6.40497 5.24121H10.196L4.64618 10.791C4.45124 10.9862 4.45124 11.3028 4.64618 11.498C4.84144 11.6933 5.15893 11.6933 5.35419 11.498L10.905 5.94629V9.74121C10.905 10.0174 11.1288 10.2412 11.405 10.2412C11.6811 10.2412 11.905 10.0174 11.905 9.74121V4.94141C11.905 4.55481 11.5914 4.24121 11.2048 4.24121H6.40497Z" /></svg>;
}

function RefreshIcon(): ReactElement {
  return <path d="M17.1134 2.28793C17.4446 2.28807 17.714 2.55625 17.714 2.88754V6.83871C17.7139 6.90647 17.6986 6.97031 17.6778 7.0311C17.6737 7.04327 17.672 7.05627 17.6671 7.06821C17.6211 7.17887 17.543 7.2721 17.4444 7.33774C17.4279 7.34876 17.41 7.35685 17.3927 7.36606C17.3761 7.37488 17.3603 7.38516 17.3429 7.39243C17.3232 7.40058 17.3025 7.405 17.2823 7.41098C17.2645 7.41626 17.2471 7.42299 17.2286 7.42661C17.1905 7.43409 17.152 7.43925 17.1134 7.4393H13.1622C12.8309 7.4393 12.5627 7.17002 12.5626 6.83871C12.5627 6.50747 12.8309 6.23911 13.1622 6.23911H15.6641L14.9024 5.47739V5.47641C13.5816 4.21108 11.8278 3.48724 10.0001 3.48715C8.71218 3.48721 7.4528 3.86932 6.38192 4.58481C5.311 5.30039 4.47641 6.31773 3.98348 7.50766C3.49059 8.69761 3.36214 10.0071 3.61337 11.2704C3.86468 12.5336 4.48483 13.6946 5.39559 14.6053C6.30627 15.5158 7.46655 16.1363 8.72958 16.3875C9.99263 16.6387 11.3025 16.5101 12.4923 16.0174C13.6822 15.5245 14.6996 14.6889 15.4151 13.618C16.1306 12.5471 16.5128 11.2878 16.5128 9.99985C16.5129 9.66861 16.7821 9.40024 17.1134 9.40024C17.4443 9.40061 17.7128 9.66885 17.713 9.99985C17.7129 11.5252 17.2606 13.0167 16.4132 14.285C15.5658 15.5532 14.3613 16.5421 12.9522 17.1258C11.5432 17.7095 9.99206 17.8617 8.49618 17.5643C7.00027 17.2667 5.62552 16.5323 4.54696 15.4539C3.46838 14.3754 2.73325 13.0008 2.43563 11.5047C2.13807 10.0087 2.29135 8.45793 2.87508 7.04868C3.45884 5.63941 4.44759 4.4352 5.71591 3.58774C6.9841 2.74043 8.47489 2.28799 10.0001 2.28793C12.1508 2.28802 14.2035 3.14088 15.7423 4.61996L16.5138 5.39145V2.88754C16.5138 2.55626 16.7821 2.28808 17.1134 2.28793Z" fill="currentColor" />;
}

function SortableModelRow({ id, model, onTest, onToggle }: { readonly id: string; readonly model: Record<string, unknown>; readonly onTest: () => void; readonly onToggle: (enabled: boolean) => void }): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const enabled = model.enabled !== false;
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.55 : undefined, position: "relative", zIndex: isDragging ? 1 : undefined }} data-testid={`settings-custom-model-row-${text(model.modelId)}`}>
    <div className="flex items-center gap-3 overflow-hidden rounded-[12px] py-2 pl-3 pr-3">
      <button type="button" aria-label={`调整 ${text(model.displayName) || text(model.modelId)} 顺序`} className="flex size-4 shrink-0 touch-none cursor-grab items-center justify-center text-icon_default_tertiary hover:text-icon_interaction_tertiary_hover active:cursor-grabbing" {...attributes} {...listeners}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3.3335 9C3.88552 9.00018 4.33332 9.44797 4.3335 10C4.3335 10.5522 3.88563 10.9998 3.3335 11C2.78121 11 2.3335 10.5523 2.3335 10C2.33367 9.44786 2.78132 9 3.3335 9ZM7.99951 9C8.55169 9 8.99934 9.44786 8.99951 10C8.99951 10.5523 8.5518 11 7.99951 11C7.44738 10.9998 6.99951 10.5522 6.99951 10C6.99968 9.44797 7.44749 9.00018 7.99951 9ZM12.6665 9C13.2187 9 13.6663 9.44786 13.6665 10C13.6665 10.5523 13.2188 11 12.6665 11C12.1142 11 11.6665 10.5523 11.6665 10C11.6667 9.44786 12.1143 9 12.6665 9ZM3.3335 5C3.88552 5.00018 4.33332 5.44797 4.3335 6C4.3335 6.55217 3.88563 6.99982 3.3335 7C2.78121 7 2.3335 6.55228 2.3335 6C2.33367 5.44786 2.78132 5 3.3335 5ZM7.99951 5C8.55169 5 8.99934 5.44786 8.99951 6C8.99951 6.55228 8.5518 7 7.99951 7C7.44738 6.99982 6.99951 6.55217 6.99951 6C6.99968 5.44797 7.44749 5.00018 7.99951 5ZM12.6665 5C13.2187 5 13.6663 5.44786 13.6665 6C13.6665 6.55228 13.2188 7 12.6665 7C12.1142 7 11.6665 6.55228 11.6665 6C11.6667 5.44786 12.1143 5 12.6665 5Z" fill="currentColor" /></svg></button>
      <span className={`min-w-0 flex-1 truncate text-[14px] leading-5 text-text_default_primary ${enabled ? "" : "opacity-50"}`}>{text(model.displayName) || text(model.modelId)}</span>
      <IconButton label="测试模型连通性" onClick={onTest} viewBox="0 0 20 20" svgFill="none"><RefreshIcon /></IconButton>
      <ToggleSwitch checked={enabled} label={`${enabled ? "禁用" : "启用"} ${text(model.displayName) || text(model.modelId)}`} onChange={onToggle} />
    </div>
  </div>;
}
