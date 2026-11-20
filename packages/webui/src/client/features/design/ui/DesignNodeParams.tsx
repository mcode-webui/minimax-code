import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { DesignOwner } from "../application/design-owner.js";
import type {
  DesignAction,
  DesignNode,
  DesignState,
} from "../../../../shared/contracts/design.js";
import {
  modeOf,
  modesOf,
  runModeOf,
} from "../../../../shared/design/forms.mjs";
import { BATCH_COUNTS, BATCH_MODES } from "../../../../shared/design/tools.mjs";
import {
  modeChoice,
  modelRange,
  panelFields,
  paramFields,
  paramSummary,
  ratioGlyph,
  type NodeField,
} from "../../../../shared/design/node-ui.mjs";
import { WebuiDropdown } from "../../../ui/Dropdown.js";
import { WebuiButton } from "../../../ui/button.js";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";
import {
  WebuiField,
  WebuiSelectMenu,
  WebuiTextarea,
} from "../../../ui/field.js";
import {
  designLimits,
  designModels,
  record,
  records,
} from "../projection/design-view.js";

export function DesignNodeParams({
  node,
  data,
  onPatch,
  onAction,
  actions,
  registerPendingEdit,
  onPendingChange,
}: {
  readonly node: DesignNode;
  readonly data: DesignState;
  readonly onPatch: (
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<DesignState | undefined>;
  readonly onAction: (action: DesignAction) => Promise<DesignState | undefined>;
  readonly actions?: ReactNode;
  readonly registerPendingEdit?: DesignOwner["registerPendingEdit"];
  readonly onPendingChange?: (pending: boolean) => void;
}): ReactElement {
  const [panel, setPanel] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const draft = useRef<string>(),
    base = useRef(node),
    live = useRef(true);
  const latest = useRef({ onPatch, onPendingChange });
  latest.current = { onPatch, onPendingChange };
  const flush = async () => {
    const text = draft.current;
    if (text === undefined) return live.current;
    const result = await latest.current.onPatch({
      templateId: "custom",
      templateText: text,
    });
    const committed = result?.document?.nodes.find(
      (item) => item.id === node.id,
    );
    if (committed) base.current = committed;
    live.current = Boolean(result && committed);
    if (result && text === draft.current) {
      draft.current = undefined;
      latest.current.onPendingChange?.(false);
    }
    return live.current;
  };
  const flusher = useRef(flush);
  flusher.current = flush;
  useEffect(
    () =>
      registerPendingEdit?.(
        () => flusher.current(),
        () =>
          draft.current !== undefined
            ? {
                nodeId: node.id,
                baseNode: base.current,
                patch: {
                  metadata: {
                    templateId: "custom",
                    templateText: draft.current,
                  },
                },
              }
            : undefined,
        (edit) => {
          if (edit.patch.metadata?.templateText === draft.current) {
            draft.current = undefined;
            latest.current.onPendingChange?.(false);
          }
        },
      ),
    [registerPendingEdit, node.id],
  );
  useEffect(
    () => () => {
      void flusher.current();
    },
    [],
  );
  const layer = useId();
  const caps = designLimits(data, node);
  const models = designModels(data, node);
  const fields = paramFields(node, caps, {
    models,
    voices: data.voices,
    counts: BATCH_MODES.includes(runModeOf(node))
      ? BATCH_COUNTS.map((value) => ({ value, label: value }))
      : [],
  });
  const mode = modeChoice(node, caps);
  const model = fields.find((field) => field.key === "model");
  const count = fields.find((field) => field.key === "count");
  const shape = panelFields(fields, "params");
  const select = (field: NodeField, value: string) => {
    void onPatch({
      [field.key]:
        field.key === "count" || field.key === "duration"
          ? Number(value)
          : value,
    });
  };
  const chooseModeOrModel = async (
    metadata: Readonly<Record<string, unknown>>,
  ) => {
    const before = data.document?.connections.length ?? 0;
    const result = await onPatch(metadata),
      changed = result?.document?.nodes.find((item) => item.id === node.id);
    if (!changed || !result?.document) return;
    const removed = before - result.document.connections.length;
    if (removed > 0 || (metadata.model && modeOf(changed) !== modeOf(node)))
      setNotice(
        `已切到「${modesOf(changed).find((item) => item.id === modeOf(changed))?.label ?? modeOf(changed)}」${removed > 0 ? `，去掉了 ${removed} 条接不上输入的线` : ""}。`,
      );
  };
  const toggle = (kind: string) => {
    setPanel((current) => (current === kind ? undefined : kind));
    if (
      caps.supportsVoice &&
      data.voiceSource === "not-loaded" &&
      kind === "params"
    )
      void onAction({ type: "list_voices" });
  };
  return (
    <div
      className="webui-design-param-bar"
      data-overlay-layer={layer}
      data-canvas-no-zoom="true"
    >
      {mode ? (
        <WebuiSelectMenu
          aria-label="模式"
          id={`${layer}-mode`}
          labelId={`${layer}-mode-label`}
          value={mode.value}
          options={mode.options}
          onChange={(value) => {
            void chooseModeOrModel({ mode: value });
          }}
          className="webui-design-mode-select"
        />
      ) : null}
      <FeedbackLiveRegion className="webui-design-muted">
        {notice}
      </FeedbackLiveRegion>
      <div className="webui-design-param-bottom">
        <div className="webui-design-param-chips">
          <WebuiDropdown
            managed
            open={panel === "model"}
            onOpen={() => toggle("model")}
            onClose={() => setPanel(undefined)}
            managedLayerId={`${layer}-model`}
            side="top"
            collision="flip"
            ariaLabel="在线模型"
            className="webui-design-model-panel"
            trigger={(trigger) => (
              <WebuiButton
                {...trigger}
                variant="plain"
                size="inline-tiny"
                title="选择在线模型"
              >
                {model?.chip ?? "在线模型"}⌄
              </WebuiButton>
            )}
          >
            <div className="webui-design-panel-title">在线模型</div>
            {models.length ? (
              models.map((item) => {
                const catalogue = records(
                  record(data.capabilities.modes)[runModeOf(node)] &&
                    record(record(data.capabilities.modes)[runModeOf(node)])
                      .models,
                ).find((entry) => entry.id === item.value);
                const hint = catalogue
                  ? modelRange(catalogue)
                  : data.models.find((entry) => entry.key === item.value)
                      ?.label;
                return (
                  <WebuiButton
                    key={item.value}
                    variant="plain"
                    size="inline-dense"
                    className="webui-design-model-option"
                    title={
                      typeof catalogue?.note === "string"
                        ? catalogue.note
                        : item.label
                    }
                    aria-pressed={node.metadata.model === item.value}
                    onClick={() => {
                      void chooseModeOrModel({ model: item.value });
                      setPanel(undefined);
                    }}
                  >
                    <span>
                      <b>
                        {item.label}
                        {catalogue?.badge ? (
                          <small className="webui-design-model-badge">
                            {String(catalogue.badge)}
                          </small>
                        ) : null}
                      </b>
                      {hint && hint !== item.label ? (
                        <small>{hint}</small>
                      ) : null}
                    </span>
                    {node.metadata.model === item.value ? (
                      <span aria-hidden="true">✓</span>
                    ) : null}
                  </WebuiButton>
                );
              })
            ) : (
              <p className="webui-design-muted">暂无可用模型</p>
            )}
          </WebuiDropdown>
          {shape.length || caps.supportsVoice ? (
            <WebuiDropdown
              open={panel === "params"}
              onOpen={() => toggle("params")}
              onClose={() => setPanel(undefined)}
              managedLayerId={`${layer}-params`}
              side="top"
              collision="flip"
              ariaLabel="节点参数"
              className="webui-design-param-panel"
              trigger={(trigger) => (
                <WebuiButton {...trigger} variant="plain" size="inline-tiny">
                  {paramSummary(fields) || "参数"}⌄
                </WebuiButton>
              )}
            >
              {shape.map((field) => (
                <div className="webui-design-param-field" key={field.key}>
                  <span>{field.label}</span>
                  {field.key === "ratio" ? (
                    <div className="webui-design-ratio-grid">
                      {field.options.map((option) => {
                        const glyph = ratioGlyph(option.value);
                        return (
                          <WebuiButton
                            key={option.value}
                            variant="plain"
                            size="inline-dense"
                            className="webui-design-ratio-button"
                            title={option.hint}
                            aria-pressed={field.value === option.value}
                            onClick={() => select(field, option.value)}
                          >
                            <span className="webui-design-ratio-symbol">
                              <i
                                style={{
                                  width: glyph.width,
                                  height: glyph.height,
                                }}
                                data-adaptive={
                                  glyph.adaptive ? "true" : undefined
                                }
                              />
                            </span>
                            <span>{option.label}</span>
                          </WebuiButton>
                        );
                      })}
                    </div>
                  ) : ["voice", "emotion"].includes(field.key) ? (
                    <WebuiSelectMenu
                      id={`${layer}-${field.key}`}
                      labelId={`${layer}-${field.key}-label`}
                      aria-label={field.label}
                      value={field.value}
                      options={field.options}
                      onChange={(value) => select(field, value)}
                    />
                  ) : (
                    <div className="webui-design-param-segments">
                      {field.options.map((option) => (
                        <WebuiButton
                          key={option.value}
                          variant="plain"
                          size="inline-tiny"
                          aria-pressed={field.value === option.value}
                          onClick={() => select(field, option.value)}
                        >
                          {option.label}
                        </WebuiButton>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {caps.supportsVoice && !data.voices?.length ? (
                <p className="webui-design-muted">
                  {data.voiceError ||
                    (data.voiceSource === "not-loaded"
                      ? "正在读取音色目录…"
                      : "暂无可用音色")}
                </p>
              ) : null}
            </WebuiDropdown>
          ) : null}
          {count ? (
            <WebuiDropdown
              open={panel === "count"}
              onOpen={() => toggle("count")}
              onClose={() => setPanel(undefined)}
              managedLayerId={`${layer}-count`}
              side="top"
              collision="flip"
              ariaLabel="生成数量"
              className="webui-design-count-panel"
              trigger={(trigger) => (
                <WebuiButton {...trigger} variant="plain" size="inline-tiny">
                  {count.chip}⌄
                </WebuiButton>
              )}
            >
              <div className="webui-design-panel-title">生成数量</div>
              <div className="webui-design-param-segments">
                {count.options.map((option) => (
                  <WebuiButton
                    key={option.value}
                    variant="plain"
                    size="inline-tiny"
                    aria-pressed={count.value === option.value}
                    onClick={() => {
                      select(count, option.value);
                      setPanel(undefined);
                    }}
                  >
                    {option.label}
                  </WebuiButton>
                ))}
              </div>
            </WebuiDropdown>
          ) : null}
        </div>
        {actions}
      </div>
      {modeOf(node) === "prompt" ? (
        <div className="webui-design-prompt-template">
          <WebuiField
            label="扩写预设"
            control={(field) => (
              <WebuiSelectMenu
                {...field}
                labelId={field.id.replace(/-control$/u, "-label")}
                value={node.metadata.templateId ?? "custom"}
                options={records(data.capabilities.promptTemplates).map(
                  (entry) => ({
                    value: String(entry.id),
                    label: String(entry.label),
                  }),
                )}
                onChange={(templateId) => {
                  const item = records(data.capabilities.promptTemplates).find(
                    (entry) => entry.id === templateId,
                  );
                  void onPatch({
                    templateId,
                    templateText: String(item?.text ?? ""),
                  });
                }}
              />
            )}
          />
          <WebuiField
            label="扩写模板"
            control={(field) => (
              <WebuiTextarea
                {...field}
                key={`${node.id}-${node.metadata.templateId}`}
                defaultValue={node.metadata.templateText ?? ""}
                rows={3}
                onChange={(event) => {
                  if (draft.current === undefined) base.current = node;
                  draft.current = event.currentTarget.value;
                  latest.current.onPendingChange?.(true);
                }}
                onBlur={(event) => {
                  void flush();
                }}
              />
            )}
          />
        </div>
      ) : null}
    </div>
  );
}
