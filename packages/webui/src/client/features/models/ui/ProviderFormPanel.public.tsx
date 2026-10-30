// The provider form under `models`.
//
// **What the parent keeps, and why it is not a preference.** `UsageModelSettings` stays the
// parent and stays mounted, so it hosts the Models provider editor *above* the
// `sourceTab === "custom"` conditional. The draft, the tested flag and the operation
// state live in that editor, which is what keeps them alive across a sub-tab switch and what makes
// a connection test belong to the draft it tested rather than to whatever the fields hold later.
// The panel is rendered inside the same `sourceTab === "custom"` conditional it occupied before, so
// its own mount and unmount boundary is unchanged — which is also why
// `ProviderPresetPicker`'s `open`/`query` still reset when the form's subtree goes away. The
// session-keyed preload and both intervals stay in the parent; the OAuth surface stays
// there too, because it is `settings`' to render.
//
// This is a **controlled region**: it renders one editor's snapshot and forks no
// state of its own beyond the preset picker's open flag, so nothing here can disagree with what a
// write will actually send. The editor and its commands arrive as props — the provider CRUD
// is `models`' duty, not `settings`'.

import { useRef, useState, type Dispatch, type ReactElement, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconCheck, IconChevronDown, IconEdit, IconGripVertical, IconPlus, IconSearch, IconTrash, IconX } from "@tabler/icons-react";

import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { reorderModelIds } from "../projection/model-reorder.js";
import type {
  WebuiDiscoverUserModelsCandidateRequest,
  WebuiModelProviderModelEntry,
  WebuiModelProviderView,
  WebuiSaveUserModelProviderCandidateRequest,
  WebuiTestUserModelCandidateRequest,
} from "../../../../shared/contracts/models.js";
import type {
  WebuiProviderEditor,
  WebuiProviderEditorSnapshot,
} from "../contracts/provider-editor.js";
import {
  WEBUI_MODEL_ATTACHMENT_MODALITIES,
  WEBUI_MODEL_PROVIDER_APIS,
  type ProviderModelDraft,
  type ProviderModelPatch,
} from "../contracts/provider-editor.js";
import { textOf } from "../../../contracts/value-readers.js";
import { ToggleSwitch } from "../../../ui/ToggleSwitch.js";
import { WebuiDropdown } from "../../../ui/Dropdown.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiField, WebuiFormActions } from "../../../ui/field.js";
import { useDialogLayer } from "../../../ui/overlay-listeners.js";
import { CloseIcon, IconButton, RefreshIcon } from "../../../ui/form-atoms.js";
import { FeedbackError } from "../../../ui/feedback.js";

/** The attachment modalities, in Desktop's own words. */
const ATTACHMENT_LABELS: Readonly<
  Record<(typeof WEBUI_MODEL_ATTACHMENT_MODALITIES)[number], string>
> = {
  image: "图片",
  pdf: "PDF",
  video: "视频",
  audio: "音频",
};

/**
 * The provider commands this panel invokes. They are `models`' rather than
 * `settings`'; the parent hands over the workflows object's members, which is the wiring
 * boundary this panel declares and no longer owns around.
 */export interface WebuiProviderFormCommands {
  readonly canManageProviders: boolean;
  readonly loadProviders: () => Promise<void>;
  readonly loadPresets: () => Promise<void>;
  readonly revealApiKey: (providerId: string) => Promise<string>;
  readonly testModel: (body: { readonly providerId: string; readonly modelId: string }) => Promise<unknown>;
  readonly discoverCandidate: (
    body: WebuiDiscoverUserModelsCandidateRequest,
  ) => Promise<unknown>;
  readonly testCandidate: (body: WebuiTestUserModelCandidateRequest) => Promise<unknown>;
  readonly saveCandidate: (
    body: WebuiSaveUserModelProviderCandidateRequest,
  ) => Promise<unknown>;
  readonly deleteProvider: (providerId: string) => Promise<unknown>;
  /**
   * The two semantic mutations this panel asks for.
   *
   * Neither takes a model array: the panel says what the user meant, and the
   * Models owner resolves it against the list it currently holds. Replacing these
   * with a generic array update is what let a toggle send a list built from
   * rendered props over a list the owner had already changed.
   */
  readonly setProviderModelEnabled: (intent: {
    readonly providerId: string;
    readonly modelId: string;
    readonly enabled: boolean;
  }) => Promise<unknown>;
  readonly reorderProviderModels: (intent: {
    readonly providerId: string;
    readonly orderedModelIds: readonly string[];
  }) => Promise<unknown>;
}

/**
 * The drafts, the tested flag and the operation state belong to the Models editor, which
 * the parent hosts above the custom-tab conditional so a sub-tab switch does not lose them.
 * The panel is a view over that editor's snapshot and calls its commands; the delete
 * *confirmation* stays here, because asking before deleting is the list's question.
 */
export interface WebuiProviderFormPanelProps {
  readonly providers: readonly WebuiModelProviderView[];
  readonly presets: readonly Record<string, unknown>[];
  readonly commands: WebuiProviderFormCommands;
  /** The list-level error channel the parent owns, so a failed write lands where its retry is. */
  readonly setProviderActionError: (message?: string) => void;
  readonly editor: WebuiProviderEditor;
  readonly snapshot: WebuiProviderEditorSnapshot;
  readonly providerPendingDelete?: WebuiModelProviderView;
  readonly setProviderPendingDelete: Dispatch<SetStateAction<WebuiModelProviderView | undefined>>;
}

function providerModels(provider?: WebuiModelProviderView): readonly WebuiModelProviderModelEntry[] {
  return provider?.models ?? [];
}

/**
 * The provider picker.
 *
 * Desktop's own shape: one field that is both the selection and the search —
 * it shows the chosen provider, and typing in it filters the list. The suffix
 * icon says which of the two it is doing (a magnifier while the list is open,
 * a chevron while it is closed), and `其他` is pinned to the bottom of the list
 * behind a divider rather than scrolling with the presets.
 */
function ProviderPresetPicker({ presets, selected, selectedName, onSelect }: { readonly presets: readonly Record<string, unknown>[]; readonly selected: string; readonly selectedName: string; readonly onSelect: (preset?: Record<string, unknown>) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  /** The field's visible frame — the anchor the popup hangs off. */
  const frameRef = useRef<HTMLDivElement | null>(null);
  const visible = presets.filter((preset) => `${textOf(preset.name)} ${textOf(preset.providerId)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  // `其他` is the value the field carries once it is chosen, so the field has to
  // show the word and not the marker.
  const label = selected === "__other__" ? "其他" : selectedName;
  return <WebuiDropdown
          managed
          managedLayerId="provider-form-preset"
    open={open}
    onOpen={() => { setOpen(true); setQuery(""); }}
    onClose={() => { setOpen(false); setQuery(""); }}
    role="listbox"
    ariaLabel="提供商列表"
    width="content"
    wrapperClassName="webui-provider-picker"
    className="webui-provider-picker-menu"
    testId="settings-provider-preset-picker"
    // The popup hangs off the FIELD'S FRAME, not off the text cursor inside
    // it: the frame is the box the reader sees, and it is what the list has
    // to line up with. The input keeps the skeleton's trigger ref, so Escape
    // returns the focus to the field the reader was typing in.
    anchorElementRef={frameRef}
    trigger={(triggerProps) => {
      const { ref, ...inputProps } = triggerProps;
      return <div ref={frameRef} className={`webui-provider-picker-trigger${open ? " webui-provider-picker-trigger-open" : ""}`}>
      <input
        {...inputProps}
        ref={ref}
        role="combobox"
        aria-label="提供商"
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="请选择提供商"
        value={open ? query || label : label}
        onFocus={(event) => {
          // The field shows the selection until it is typed into, so the first
          // keystroke replaces it rather than appending to it. Opening is the
          // trigger's own business: the skeleton toggles it on the click, and
          // opening it here as well would cancel that toggle.
          event.currentTarget.select();
        }}
        onKeyDown={(event) => {
          triggerProps.onKeyDown(event);
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              setQuery("");
            }
          }
        }}
        onChange={(event) => {
          setOpen(true);
          setQuery(event.target.value);
        }}
      />
      <span className="webui-provider-picker-suffix" data-state={open ? "search" : "arrow"}>
        {open
          ? <IconSearch aria-hidden="true" size={16} stroke={1.7} />
          : <IconChevronDown aria-hidden="true" size={16} stroke={1.7} />}
      </span>
    </div>;
    }}
  >
    <div className="webui-provider-picker-options" onMouseDown={(event) => event.preventDefault()}>
      {visible.length ? visible.map((preset) => {
        const id = textOf(preset.providerId);
        const name = textOf(preset.name) || id;
        const iconUrl = textOf(preset.iconUrl);
        return <button key={id} type="button" role="option" aria-selected={selected === id} className="webui-provider-picker-option" onClick={() => { onSelect(preset); setOpen(false); setQuery(""); }}><span className="webui-provider-picker-icon">{iconUrl ? <img src={iconUrl} alt="" /> : name.slice(0, 1)}</span><span className="webui-provider-picker-option-name">{name}</span>{selected === id ? <span className="webui-provider-picker-check" aria-hidden="true"><IconCheck size={14} stroke={1.7} /></span> : null}</button>;
      }) : <p className="webui-provider-picker-empty" role="status">没有匹配的提供商</p>}
    </div>
    <div className="webui-provider-picker-other">
      <button type="button" role="option" aria-selected={selected === "__other__"} data-testid="settings-provider-other-option" onMouseDown={(event) => event.preventDefault()} onClick={() => { onSelect(); setOpen(false); setQuery(""); }}><span className="webui-provider-picker-other-icon" aria-hidden="true"><IconPlus size={16} stroke={1.7} /></span><span>其他</span></button>
    </div>
  </WebuiDropdown>;
}

export function ProviderFormPanel({
  providers, presets, commands, setProviderActionError,
  editor, snapshot,
  providerPendingDelete, setProviderPendingDelete,
}: WebuiProviderFormPanelProps): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  const portalTarget = dom.portalTarget();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  // The markup below reads the editor's snapshot under the names it always used, so this stays a
  // view: every draft, the tested flag, the busy flag and the error come from the editor, and each
  // control calls one of its commands.
  const {
    open: showProviderForm, editingProviderId: editingProvider,
    name: draftName, baseUrl: draftBaseUrl, apiKey: draftApiKey,
    models: draftModels, apiFormat: draftApiFormat,
    headers: draftHeaders, tested: draftTested, skipConnectionTest: skipTest,
    busy: formBusy, error: formError,
  } = snapshot;
  // Two modal layers: the provider form and the delete confirmation it can raise.
  // Without them a press inside the form counts as a press outside the settings
  // modal that holds it, and the modal would close under the user.
  const formLayerId = useDialogLayer({ id: "provider-form", active: showProviderForm, onClose: () => editor.close() });
  const deleteLayerId = useDialogLayer({
    id: "provider-delete",
    order: 10,
    active: providerPendingDelete !== undefined,
    onClose: () => setProviderPendingDelete(undefined),
  });
  const [selectedPresetId, setSelectedPresetId] = useState<string>();
  const [apiFormatOpen, setApiFormatOpen] = useState(false);
  // The API formats the runtime accepts, plus whatever a saved provider carries
  // if this build does not know it: an edit must not silently rewrite it.
  // A field error the view can decide on its own: the endpoint is a URL, and a
  // draft that is not one is worth saying so before the save round-trips. It is
  // shown through the field contract, so the control carries `aria-invalid` and
  // points at the message.
  const baseUrlError =
    draftBaseUrl.trim() && !/^https?:\/\/[^\s]+$/u.test(draftBaseUrl.trim())
      ? "请输入以 http:// 或 https:// 开头的地址"
      : undefined;
  const apiFormatOptions = WEBUI_MODEL_PROVIDER_APIS.includes(
    draftApiFormat as (typeof WEBUI_MODEL_PROVIDER_APIS)[number],
  )
    ? WEBUI_MODEL_PROVIDER_APIS
    : [draftApiFormat, ...WEBUI_MODEL_PROVIDER_APIS];
  const hasModelId = draftModels.some((model) => model.modelId.trim().length > 0);

    // Opening is the editor's: it seeds the draft from the view (including the
    // header rows, which start blank over their persisted names because the read
    // carries names only) and reveals a saved key. The preset list is the list's,
    // so it is loaded here and its failure is reported on the list channel.
    const openProviderForm = async (provider?: WebuiModelProviderView) => {
      setSelectedPresetId(undefined);
      if (provider) await editor.openExisting(provider);
      else editor.openNew();
      try { await commands.loadPresets(); }
      catch (error) { setProviderActionError(error instanceof Error ? error.message : String(error)); }
    };
    // The dialog closes only on a successful delete; a refusal stays beside it,
    // in the editor's error channel.
    const confirmDeleteProvider = async () => {
      await editor.remove();
      if (!editor.getSnapshot().error) setProviderPendingDelete(undefined);
    };
    const toggleModel = async (providerId: string, model: WebuiModelProviderModelEntry, enabled: boolean) => {
      // The intent, not the array: the owner applies it to its own pending
      // projection and serializes the write per provider, so a toggle cannot
      // resurrect a list that a newer local change has already replaced.
      const outcome = await commands.setProviderModelEnabled({
        providerId,
        modelId: textOf(model.modelId),
        enabled,
      });
      if (outcome && typeof outcome === "object" && "status" in outcome && outcome.status === "failed") {
        const failure = outcome as { readonly error?: unknown };
        setProviderActionError(failure.error instanceof Error ? failure.error.message : String(failure.error));
      }
    };
  return <>
      {providers.length === 0 ? <p>暂未添加自定义模型</p> : providers.map((provider) => {
        const id = textOf(provider.providerId);
        const models = providerModels(provider);
        const ids = models.map((model, index) => textOf(model.modelId) || `${id}-${index}`);
        return <div key={id} className="flex w-full flex-col gap-2">
          <div className="flex h-6 items-center justify-between pl-4 pr-3">
            <div className="flex min-w-0 items-center gap-2"><span className="truncate text-[14px] font-medium leading-5 text-text_default_primary">{textOf(provider.name) || id}</span>{provider.kind === "oauth" ? <span className="rounded-[6px] bg-bg_interaction_tertiary_press px-1 text-[12px]">OAuth</span> : null}</div>
            <div className="flex items-center gap-2">
              <IconButton label="编辑提供商" onClick={() => void openProviderForm(provider)}><IconEdit aria-hidden="true" size={16} stroke={1.7} /></IconButton>
              <IconButton label="删除" disabled={!commands.canManageProviders} onClick={() => { editor.clearError(); setProviderPendingDelete(provider); }}><IconTrash aria-hidden="true" size={16} stroke={1.7} /></IconButton>
            </div>
          </div>
          {models.length ? <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={async (event: DragEndEvent) => {
            const over = event.over?.id; const active = event.active.id;
            if (!over || active === over) return;
            const orderedIds = reorderModelIds(ids, String(active), String(over));
            // Ordered identities again: the owner resolves them against what it
            // holds, so the row moves at once and the write carries the owner's
            // own view rather than this render's array.
            const outcome = await commands.reorderProviderModels({
              providerId: id,
              orderedModelIds: orderedIds,
            });
            if (outcome && typeof outcome === "object" && "status" in outcome && outcome.status === "failed") {
              const failure = outcome as { readonly error?: unknown };
              setProviderActionError(failure.error instanceof Error ? failure.error.message : String(failure.error));
            }
          }}><SortableContext items={ids} strategy={verticalListSortingStrategy}><div className="w-full rounded-[16px] bg-bg_grouped_tertiary p-1">{models.map((model, index) => <SortableModelRow key={ids[index]} id={ids[index]!} model={model} onTest={() => void commands.testModel({ providerId: id, modelId: textOf(model.modelId) })} onToggle={(enabled) => void toggleModel(id, model, enabled)} />)}</div></SortableContext></DndContext> : null}
        </div>;
      })}
      <WebuiButton variant="plain" className="h-9 w-fit rounded-[8px] px-3" disabled={!commands.canManageProviders} onClick={() => void openProviderForm()}>添加模型</WebuiButton>
      {showProviderForm && portalTarget ? createPortal(<div data-overlay-layer={formLayerId} role="dialog" aria-modal="true" aria-label={editingProvider ? "编辑提供商" : "添加模型"} className="webui-provider-dialog-backdrop"><form className="webui-provider-form" onSubmit={(event) => { event.preventDefault(); void editor.save(); }}>
        <header className="webui-provider-form-header"><h3>{editingProvider ? "编辑提供商" : "添加模型"}</h3><button type="button" aria-label="关闭" onClick={() => editor.close()}><CloseIcon /></button></header>
        <div className="webui-provider-form-body">
          {!editingProvider ? <div className="webui-provider-form-provider-grid"><label className="webui-provider-form-field">提供商<ProviderPresetPicker presets={presets} selected={selectedPresetId ?? ""} selectedName={selectedPresetId && selectedPresetId !== "__other__" ? draftName : ""} onSelect={(preset) => { if (!preset) { setSelectedPresetId("__other__"); editor.changeField("name", ""); editor.changeField("baseUrl", ""); editor.changeField("apiFormat", "openai-completions"); editor.clearModels(); return; } setSelectedPresetId(textOf(preset.providerId)); editor.changeField("name", textOf(preset.name)); editor.changeField("baseUrl", textOf(preset.baseUrl)); editor.changeField("apiFormat", textOf(preset.apiFormat)); editor.clearModels(); }} /></label>{selectedPresetId === "__other__" ? <WebuiField className="webui-provider-form-field" label="提供商名称" required control={(props) => <input {...props} value={draftName} onChange={(event) => editor.changeField("name", event.target.value)} required />} /> : null}</div> : null}
          {editingProvider ? <WebuiField className="webui-provider-form-field" label="提供商名称" required control={(props) => <input {...props} value={draftName} onChange={(event) => editor.changeField("name", event.target.value)} required />} /> : null}
          <div className="webui-provider-form-provider-grid"><WebuiField className="webui-provider-form-field" label="API 格式" control={(props, field) => <WebuiDropdown
          managed
          managedLayerId="provider-form-format" open={apiFormatOpen} onOpen={() => setApiFormatOpen(true)} onClose={() => setApiFormatOpen(false)} role="listbox" ariaLabel="API 格式" width="match" wrapperClassName="webui-provider-format" className="webui-provider-format-menu" trigger={(triggerProps) => {
            // Named by the field's label and by the value it shows: a name that
            // restates the value alone would not match the visible text.
            const valueId = `${props.id}-value`;
            return <button type="button" {...triggerProps} id={props.id} aria-labelledby={`${field.labelId} ${valueId}`} className="webui-provider-format-trigger"><span id={valueId}>{draftApiFormat}</span><IconChevronDown aria-hidden="true" size={16} stroke={1.7} /></button>;
          }}>{apiFormatOptions.map((option) => <button key={option} type="button" role="option" aria-selected={draftApiFormat === option} className="webui-provider-format-option" onClick={() => { editor.changeField("apiFormat", option); setApiFormatOpen(false); }}>{option}</button>)}</WebuiDropdown>} /><WebuiField className="webui-provider-form-field" label="接口地址" required error={baseUrlError} control={(props) => <input {...props} placeholder="https://api.example.com/v1" value={draftBaseUrl} onChange={(event) => editor.changeField("baseUrl", event.target.value)} required />} /></div>
          <WebuiField className="webui-provider-form-field" label="API Key" required={!editingProvider} description={editingProvider ? "留空则保留原值" : undefined} control={(props) => <input {...props} type="password" placeholder={editingProvider ? "留空保留原值" : "请输入API Key"} value={draftApiKey} onChange={(event) => editor.changeField("apiKey", event.target.value)} required={!editingProvider} />} />
          <div className="webui-provider-form-models">
            <div className="webui-provider-form-models-header"><span className="text-[14px] font-medium leading-5 text-text_default_primary">模型</span><div className="webui-provider-form-models-actions"><button type="button" className="webui-provider-form-add-model" onClick={() => editor.addModel()}>添加模型</button><button type="button" className="webui-provider-form-discover" disabled={!snapshot.canDiscover || formBusy} onClick={() => void editor.discover()}>自动获取</button></div></div>
            {draftModels.length ? draftModels.map((model, index) => <ProviderModelCard key={model.id} model={model} index={index} busy={formBusy} onChange={(patch) => editor.changeModel(model.id, patch)} onTest={() => void editor.testModel(model.id)} onRemove={() => editor.removeModel(model.id)} />) : <p className="webui-provider-form-models-empty">请至少添加一个模型</p>}
          </div>
          <div className="webui-provider-form-headers"><div className="text-[13px] font-medium leading-5 text-text_default_primary">自定义 Headers</div>{draftHeaders.map((header) => <div key={header.id} className="webui-provider-form-header-row"><input aria-label="Header 名称" placeholder="Header 名称" value={header.name} onChange={(event) => editor.setHeaders(draftHeaders.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))} /><input aria-label="Header 值" placeholder={header.persistedName ? "留空保留原值" : "Header 值"} value={header.value} onChange={(event) => editor.setHeaders(draftHeaders.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))} /><IconButton label="移除 Header" onClick={() => editor.removeHeader(header.id)}><IconTrash aria-hidden="true" size={16} stroke={1.7} /></IconButton></div>)}<button type="button" className="webui-provider-form-add-header" onClick={() => editor.addHeader()}><IconPlus aria-hidden="true" size={16} stroke={1.7} /> 添加 Header</button></div>
          {formError ? <FeedbackError message={formError} className="webui-provider-form-error" /> : null}
        </div>
        <footer className="webui-provider-form-actions"><label><input type="checkbox" checked={skipTest} onChange={(event) => editor.setSkipConnectionTest(event.target.checked)} />跳过连通检测</label><span /><WebuiButton variant="secondary" disabled={formBusy || !hasModelId} onClick={() => void editor.test()}>连通检测</WebuiButton><WebuiButton variant="secondary" disabled={formBusy} onClick={() => editor.close()}>取消</WebuiButton><WebuiButton variant="muted" type="submit" disabled={formBusy || (!draftTested && !skipTest)}>{formBusy ? "加载中…" : "保存"}</WebuiButton></footer>
      </form></div>, portalTarget) : null}
      {providerPendingDelete ? <div data-overlay-layer={deleteLayerId} role="dialog" aria-modal="true" aria-label={`删除供应商${textOf(providerPendingDelete.name)}`} className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.25)]"><div className="w-[480px] overflow-clip rounded-[20px] bg-bg_grouped_secondary p-6" style={{ boxShadow: "0 4px 10px 0 rgba(0,0,0,0.04)" }}><div className="flex flex-col gap-6"><div className="flex flex-col gap-4"><div className="flex items-center justify-between"><h3 className="text-[18px] font-medium leading-[26px] text-text_default_primary">删除供应商"{textOf(providerPendingDelete.name)}"吗？</h3><button type="button" aria-label="关闭" className="flex size-[22px] items-center justify-center text-icon_default_tertiary hover:text-icon_default_secondary" onClick={() => setProviderPendingDelete(undefined)}><CloseIcon /></button></div><p className="text-[14px] leading-5 text-text_default_secondary">删除后将移除该供应商下的所有模型选项。</p></div>{formError ? <p role="alert">{formError}</p> : null}<div className="flex justify-end gap-4"><button type="button" disabled={formBusy} className="h-9 min-w-[68px] rounded-[8px] px-4" onClick={() => setProviderPendingDelete(undefined)}>取消</button><button type="button" disabled={formBusy} className="h-9 min-w-[68px] rounded-[8px] bg-bg_status_error px-4" onClick={() => void confirmDeleteProvider()}>{formBusy ? "删除中…" : "删除"}</button></div></div></div></div> : null}
  </>;
}

/**
 * One model card: the model name, the limits, the reasoning levels and the
 * attachments it takes.
 *
 * Desktop's own card, transcribed: a header carrying the model's number and its
 * own connectivity probe, and a bordered body holding one field per row.
 */
function ProviderModelCard({ model, index, busy, onChange, onTest, onRemove }: { readonly model: ProviderModelDraft; readonly index: number; readonly busy: boolean; readonly onChange: (patch: ProviderModelPatch) => void; readonly onTest: () => void; readonly onRemove: () => void }): ReactElement {
  return <div className="webui-provider-form-model">
    <div className="webui-provider-form-model-header">
      <span className="text-[13px] font-medium leading-5 text-text_default_primary">模型 {String(index + 1).padStart(2, "0")}</span>
      <div className="webui-provider-form-model-tools">
        <IconButton label="测试模型连通性" disabled={busy || !model.modelId.trim()} onClick={onTest}><RefreshIcon /></IconButton>
        <IconButton label="移除模型" disabled={busy} onClick={onRemove}><IconTrash aria-hidden="true" size={16} stroke={1.7} /></IconButton>
      </div>
    </div>
    <div className="webui-provider-form-model-body">
      <WebuiField className="webui-provider-form-field" label="模型名称" control={(props) => <input {...props} value={model.modelId} onChange={(event) => onChange({ modelId: event.target.value })} />} />
      <div className="webui-provider-form-provider-grid">
        <WebuiField className="webui-provider-form-field" label="上下文窗口" description="留空按供应商默认值处理" control={(props) => <input {...props} inputMode="numeric" placeholder="留空按供应商默认值处理" value={model.contextLimit} onChange={(event) => onChange({ contextLimit: event.target.value })} />} />
        <WebuiField className="webui-provider-form-field" label="最大输出 Token" description="留空按供应商默认值处理" control={(props) => <input {...props} inputMode="numeric" placeholder="留空按供应商默认值处理" value={model.maxOutputTokens} onChange={(event) => onChange({ maxOutputTokens: event.target.value })} />} />
      </div>
      <div className="webui-provider-form-field">
        <span>推理等级</span>
        <EffortOptionsField value={model.effortOptions} onChange={(effortOptions) => onChange({ effortOptions })} />
        <p className="webui-provider-form-hint">请确保输入模型原生支持的推理等级，留空按供应商默认值处理。</p>
      </div>
      <div className="webui-provider-form-field">
        <span>支持的附件</span>
        <AttachmentField value={model.modalities} onChange={(modalities) => onChange({ modalities })} />
        <p className="webui-provider-form-hint">所选附件将默认直接发送给模型处理，请确保模型原生支持。其余类型由平台工具处理，需消耗平台积分。</p>
      </div>
      {model.error ? <FeedbackError message={model.error} className="webui-provider-form-error" /> : null}
    </div>
  </div>;
}

/**
 * The reasoning levels of one model, as Desktop's tag input: a level is
 * committed with Enter and appears as a chip that can be taken away again.
 */
function EffortOptionsField({ value, onChange }: { readonly value: readonly string[]; readonly onChange: (next: readonly string[]) => void }): ReactElement {
  const [text, setText] = useState("");
  const commit = () => {
    const level = text.trim();
    if (!level || value.includes(level)) {
      setText("");
      return;
    }
    onChange([...value, level]);
    setText("");
  };
  return <div className="webui-provider-form-effort">
    {value.map((level) => <span key={level} className="webui-provider-form-chip">{level}<button type="button" aria-label={`移除 ${level}`} onClick={() => onChange(value.filter((item) => item !== level))}><IconX aria-hidden="true" size={14} stroke={1.7} /></button></span>)}
    <input aria-label="推理等级" placeholder="输入档位后按 Enter，如 low、high、max" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} onBlur={commit} />
  </div>;
}

/** The attachment modalities one model takes, as Desktop's multiple selection. */
function AttachmentField({ value, onChange }: { readonly value: readonly string[]; readonly onChange: (next: readonly string[]) => void }): ReactElement {
  return <div className="webui-provider-form-attachments">
    {WEBUI_MODEL_ATTACHMENT_MODALITIES.map((modality) => <label key={modality} className="webui-provider-form-attachment"><input type="checkbox" checked={value.includes(modality)} onChange={(event) => onChange(event.target.checked ? [...value, modality] : value.filter((item) => item !== modality))} />{ATTACHMENT_LABELS[modality]}</label>)}
  </div>;
}

function SortableModelRow({ id, model, onTest, onToggle }: { readonly id: string; readonly model: WebuiModelProviderModelEntry; readonly onTest: () => void; readonly onToggle: (enabled: boolean) => void }): ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const enabled = model.enabled !== false;
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.55 : undefined, position: "relative", zIndex: isDragging ? 1 : undefined }} data-testid={`settings-custom-model-row-${textOf(model.modelId)}`}>
    <div className="flex items-center gap-3 overflow-hidden rounded-[12px] py-2 pl-3 pr-3">
      <button type="button" aria-label={`调整 ${textOf(model.displayName) || textOf(model.modelId)} 顺序`} className="flex size-4 shrink-0 touch-none cursor-grab items-center justify-center text-icon_default_tertiary hover:text-icon_interaction_tertiary_hover active:cursor-grabbing" {...attributes} {...listeners}><IconGripVertical aria-hidden="true" size={16} stroke={1.7} /></button>
      <span className={`min-w-0 flex-1 truncate text-[14px] leading-5 text-text_default_primary ${enabled ? "" : "opacity-50"}`}>{textOf(model.displayName) || textOf(model.modelId)}</span>
      <IconButton label="测试模型连通性" onClick={onTest}><RefreshIcon /></IconButton>
      <ToggleSwitch checked={enabled} label={`${enabled ? "禁用" : "启用"} ${textOf(model.displayName) || textOf(model.modelId)}`} onChange={onToggle} />
    </div>
  </div>;
}
