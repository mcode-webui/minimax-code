import { useEffect, useRef, useState, type ReactElement } from "react";
import type {
  DesignAction,
  DesignDocument,
  DesignExportSource,
  DesignState,
  DesignTemplate,
} from "../../../../shared/contracts/design.js";
import {
  cardTools,
  DATA_KINDS,
  KIND_LABELS,
  kindOf,
} from "../../../../shared/design/forms.mjs";
import {
  readTemplateFile,
  templateFromCanvas,
} from "../../../../shared/design/actions.mjs";
import { modelSummary } from "../../../../shared/design/tools.mjs";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import {
  WebuiDropdown,
  type WebuiDropdownAnchorRect,
} from "../../../ui/Dropdown.js";
import { WebuiDialog } from "../../../ui/dialog.js";
import { WebuiButton, WebuiIconButton } from "../../../ui/button.js";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";
import { useWebuiToastError } from "../../../ui/toast.js";
import { WebuiFileInput, WebuiTextInput } from "../../../ui/field.js";
import {
  connectorDiscoverySummary,
  connectorToolStateLabel,
  designAddedNodeId,
  designToolBlocked,
  records,
  record,
  strings,
  designLibraryPosition,
} from "../projection/design-view.js";
import { DesignLocalSave } from "./DesignLocalSave.js";

export type DesignDialog =
  "templates" | "library" | "tools" | "capabilities" | "delete";
const labels: Record<DesignDialog, string> = {
  templates: "模板",
  library: "资产库",
  tools: "工具",
  capabilities: "能力清单",
  delete: "删除画布",
};

/** Global panels retain the original anchored form; only destructive confirmation is modal. */
export function DesignDialogs({
  kind,
  anchor,
  data,
  document,
  onClose,
  onAction,
  assetUrl,
  onTool,
  selectedNodeId,
  viewportSize,
  viewport,
  onInserted,
}: {
  readonly kind?: DesignDialog;
  readonly anchor: WebuiDropdownAnchorRect;
  readonly data: DesignState;
  readonly document?: DesignDocument;
  readonly onClose: () => void;
  readonly onAction: (action: DesignAction) => Promise<DesignState | undefined>;
  readonly assetUrl: (url: string) => string;
  readonly selectedNodeId?: string;
  readonly viewportSize: { readonly width: number; readonly height: number };
  readonly viewport: DesignDocument["viewport"];
  readonly onInserted: (id: string) => void;
  readonly onTool: (
    nodeId: string,
    toolKey: string,
    anchor: WebuiDropdownAnchorRect,
  ) => void;
}): ReactElement | null {
  const { dom } = useWebuiBrowserCapabilities();
  const retained = useRef(kind);
  if (kind) retained.current = kind;
  const active = kind ?? retained.current;
  const picker = useRef<HTMLInputElement>(null),
    nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(""),
    [naming, setNaming] = useState(false);
  const [local, setLocal] = useState<{
    readonly source: DesignExportSource;
    readonly fileName: string;
  }>();
  const [feedback, setFeedback] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  useWebuiToastError(operationError);
  const [removeTemplate, setRemoveTemplate] = useState<DesignTemplate>();
  useEffect(() => {
    setNaming(false);
    setLocal(undefined);
    setFeedback(undefined);
  }, [kind, document?.id]);
  useEffect(() => {
    setRemoveTemplate(undefined);
  }, [document?.id]);
  useEffect(() => {
    if (kind) setRemoveTemplate(undefined);
  }, [kind]);
  useEffect(() => {
    if (naming) {
      nameInput.current?.focus({ preventScroll: true });
      nameInput.current?.select();
    }
  }, [naming]);
  if (!active) return null;
  const own = data.templates.filter((item) => item.own === true);
  const groups = new Map<string, DesignTemplate[]>();
  if (own.length) groups.set("我的模板", [...own]);
  for (const item of data.templates.filter((template) => !template.own)) {
    const group = String(item.group || "其它");
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  const tools = records(data.capabilities.tools);
  const selected = document?.nodes.find((node) => node.id === selectedNodeId);
  const visibleTools = selected
    ? cardTools(
        selected,
        tools.filter(
          (
            item,
          ): item is Readonly<Record<string, unknown>> & {
            key: string;
            kind: string;
          } => typeof item.key === "string" && typeof item.kind === "string",
        ),
      )
    : [];
  const saveOwn = async () => {
    if (!document || !name.trim()) return;
    if (
      await onAction({
        type: "save_template",
        template: templateFromCanvas(document, {
          id: `user_${Date.now()}`,
          title: name.trim(),
        }),
      })
    ) {
      setNaming(false);
      setFeedback("已保存为我的模板");
    }
  };
  const content = local ? (
    <DesignLocalSave
      data={data}
      {...local}
      onAction={onAction}
      onCancel={() => setLocal(undefined)}
      onSaved={(path) => {
        setLocal(undefined);
        setFeedback(`已保存到 ${path}`);
      }}
    />
  ) : (
    <>
      {active === "templates" ? (
        <>
          <p className="webui-design-muted">
            选中的模板会开一张新画布；当前画布是空的就用它。
          </p>
          {[...groups].map(([group, templates]) => (
            <section className="webui-design-panel-section" key={group}>
              <h3>{group}</h3>
              {templates.map((template) => (
                <div className="webui-design-template-option" key={template.id}>
                  <WebuiButton
                    variant="plain"
                    size="inline-dense"
                    className="webui-design-panel-option"
                    onClick={async () => {
                      if (
                        await onAction({
                          type: "apply_template",
                          templateId: template.id,
                        })
                      )
                        onClose();
                    }}
                  >
                    <span>
                      {template.title ?? template.name ?? template.id}
                    </span>
                    <small>
                      {String(
                        template.description ??
                          `${records(template.actions).length} 个步骤`,
                      )}
                    </small>
                  </WebuiButton>
                  {template.own ? (
                    <WebuiIconButton
                      tone="bare"
                      size="compact"
                      label={`删除模板 ${template.title ?? template.id}`}
                      onClick={() => {
                        setRemoveTemplate(template);
                        onClose();
                      }}
                    >
                      ×
                    </WebuiIconButton>
                  ) : null}
                </div>
              ))}
            </section>
          ))}
          <WebuiButton
            variant="plain"
            size="inline-dense"
            className="webui-design-panel-option"
            onClick={() => picker.current?.click()}
          >
            <span>打开本地模板</span>
            <small>本机任意位置的 .json</small>
          </WebuiButton>
          <WebuiFileInput
            ref={picker}
            accept=".json,application/json"
            aria-label="打开本地模板"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file)
                void (async () => {
                  try {
                    const parsed = readTemplateFile(await file.text());
                    if (!parsed.ok) throw new Error(parsed.error);
                    if (
                      await onAction({
                        type: "apply_template",
                        template: parsed.template,
                      })
                    )
                      onClose();
                  } catch (reason) {
                    setOperationError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                  }
                })();
            }}
          />
          <WebuiButton
            variant="plain"
            size="inline-dense"
            className="webui-design-panel-option"
            disabled={!document?.nodes.length}
            onClick={() => {
              setName(`${document?.title || "画布"} 的模板`);
              setNaming(!naming);
            }}
          >
            <span>保存为我的模板</span>
            <small>只留步骤：生成节点、连线和提示词；结果和素材不留</small>
          </WebuiButton>
          {naming ? (
            <div className="webui-design-template-name">
              <WebuiTextInput
                ref={nameInput}
                aria-label="这个模板叫什么"
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveOwn();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setNaming(false);
                  }
                }}
              />
              <WebuiButton variant="plain" size="inline-tiny" onClick={saveOwn}>
                存下来
              </WebuiButton>
            </div>
          ) : null}
          <WebuiButton
            variant="plain"
            size="inline-dense"
            className="webui-design-panel-option"
            disabled={!document?.nodes.length}
            onClick={() =>
              setLocal({
                source: { type: "document_template" },
                fileName: `${document?.title || "画布"}.模板.json`,
              })
            }
          >
            <span>保存到本地</span>
            <small>写成一个 .json 文件，可以发给别的机器</small>
          </WebuiButton>
        </>
      ) : null}
      {active === "library" ? (
        <>
          <div className="webui-design-library-head">
            <span>{data.library.length} 个</span>
            <WebuiButton
              variant="plain"
              size="inline-tiny"
              title="删掉既没有被节点引用、也不在画布上的素材"
              onClick={async () => {
                const result = await onAction({ type: "gc_library" });
                if (result)
                  setFeedback(
                    `清理了 ${strings(record(result.result).removed).length} 个未引用素材`,
                  );
              }}
            >
              清理未引用
            </WebuiButton>
          </div>
          {data.library.length ? (
            <div className="webui-design-library-grid">
              {data.library.map((asset) => (
                <div className="webui-design-library-item" key={asset.id}>
                  <div className="webui-design-library-thumb">
                    {asset.kind === "image" ? (
                      <img src={assetUrl(asset.url)} alt="" loading="lazy" />
                    ) : asset.kind === "video" ? (
                      <video
                        src={assetUrl(asset.url)}
                        muted
                        playsInline
                        preload="metadata"
                      />
                    ) : (
                      <span aria-hidden="true">♪</span>
                    )}
                  </div>
                  <strong title={asset.title || asset.name}>
                    {asset.title || asset.name}
                  </strong>
                  <small>
                    {KIND_LABELS[asset.kind]}
                    {asset.bytes
                      ? ` · ${Math.max(1, Math.round(asset.bytes / 1024))} KB`
                      : ""}
                    {asset.inUse ? " · 画布在用" : ""}
                  </small>
                  <div className="webui-design-node-actions">
                    <WebuiButton
                      variant="plain"
                      size="inline-tiny"
                      onClick={async () => {
                        const position = designLibraryPosition(
                          viewport,
                          viewportSize,
                        );
                        const created = await onAction({
                          type: "add_node",
                          nodeType: "input",
                          kind: asset.kind,
                          title: asset.title || asset.name,
                          ...position,
                        });
                        const id = designAddedNodeId(created);
                        if (
                          id &&
                          (await onAction({
                            type: "update_node",
                            nodeId: id,
                            patch: {
                              metadata: {
                                output: { media: [asset], status: "success" },
                              },
                            },
                          }))
                        ) {
                          onInserted(id);
                          onClose();
                        }
                      }}
                    >
                      插入
                    </WebuiButton>
                    <WebuiButton
                      variant="plain"
                      size="inline-tiny"
                      onClick={() =>
                        setLocal({
                          source: { type: "media", media: asset },
                          fileName: asset.name,
                        })
                      }
                    >
                      保存
                    </WebuiButton>
                    <WebuiButton
                      variant="plain"
                      size="inline-tiny"
                      title={
                        asset.inUse
                          ? "画布在用，不能从资产库删除"
                          : "从库里删掉这个文件"
                      }
                      disabled={asset.inUse}
                      onClick={() =>
                        onAction({
                          type: "remove_media",
                          name: asset.name,
                        }).then(() => undefined)
                      }
                    >
                      删除
                    </WebuiButton>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="webui-design-muted">
              还没有素材。画布里生成一张，就会自动收进这里。
            </p>
          )}
        </>
      ) : null}
      {active === "tools" ? (
        <>
          <p className="webui-design-muted">
            {selected
              ? `工具 · ${selected.title}`
              : "先选中一个节点，再点这里使用它的工具。"}
          </p>
          {selected && !visibleTools.length ? (
            <p className="webui-design-muted">这个节点类型没有工具。</p>
          ) : null}
          {visibleTools.map((tool) => {
            const blocked = selected
              ? designToolBlocked(tool, selected, data)
              : undefined;
            return (
              <WebuiButton
                key={tool.key}
                variant="plain"
                size="inline-dense"
                className="webui-design-panel-option"
                disabled={Boolean(blocked)}
                title={blocked || String(tool.desc ?? "")}
                onClick={(event) => {
                  if (!selected) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  onClose();
                  onTool(selected.id, tool.key, {
                    left: rect.left,
                    top: rect.bottom,
                    width: rect.width,
                    height: 0,
                  });
                }}
              >
                <span>
                  {String(tool.label)}
                  {tool.status !== "ready" ? "（待接入）" : ""}
                </span>
                <small>{blocked || String(tool.desc ?? "")}</small>
              </WebuiButton>
            );
          })}
        </>
      ) : null}
      {active === "capabilities" ? (
        <>
          {Object.entries(record(data.capabilities.modes)).map(
            ([mode, value]) => {
              const caps = record(value);
              return (
                <section className="webui-design-panel-section" key={mode}>
                  <h3>
                    {mode === "music"
                      ? "音乐"
                      : (KIND_LABELS[mode as keyof typeof KIND_LABELS] ?? mode)}
                  </h3>
                  {[
                    ["比例", strings(caps.ratios).join(" / ") || "—"],
                    ["清晰度", strings(caps.resolutions).join(" / ") || "—"],
                    ["时长", strings(caps.durations).join(" / ") || "—"],
                    [
                      "参考上限",
                      `${caps.maxImages ?? 0} 图 / ${caps.maxVideos ?? 0} 视频 / ${caps.maxAudios ?? 0} 音频`,
                    ],
                    ...records(caps.models).map((model) => [
                      String(model.label),
                      modelSummary(model),
                    ]),
                  ].map(([label, value]) => (
                    <div className="webui-design-cap-row" key={label}>
                      <span>{label}</span>
                      <small>{value}</small>
                    </div>
                  ))}
                </section>
              );
            },
          )}
          <section className="webui-design-panel-section">
            <h3>数据色（节点 / 端口 / 连线 / 插槽共用）</h3>
            {DATA_KINDS.map((value) => (
              <div className="webui-design-cap-row" key={value}>
                <span>
                  <i className="webui-design-kind-dot" data-kind={value} />{" "}
                  {KIND_LABELS[value]}
                </span>
                <small>{value}</small>
              </div>
            ))}
          </section>
          <section className="webui-design-panel-section">
            <h3>云 provider 连接器（按账户连接发现）</h3>
            <p className="webui-design-muted">
              {connectorDiscoverySummary(
                record(data.capabilities.connectorDiscovery),
              )}
            </p>
            {records(data.capabilities.connectorTools).map((tool) => (
              <div
                className="webui-design-cap-row"
                key={String(tool.key ?? tool.tool)}
              >
                <span>{String(tool.label)}</span>
                <small>
                  {String(tool.tool ?? tool.key)} ·{" "}
                  {connectorToolStateLabel(tool)}
                  {tool.drives === false ? " · 本功能不用" : ""}
                </small>
              </div>
            ))}
          </section>
          <section className="webui-design-panel-section">
            <h3>本机媒体能力（不依赖云 provider）</h3>
            <p className="webui-design-muted">
              浏览器上传、裁剪、网格和本地媒体工具由本机执行；FFmpeg{" "}
              {data.mediaStatus.available ? "可用" : "不可用"}。
            </p>
            {[
              ["ffmpeg", "本机 FFmpeg"],
              ["local", "浏览器本地"],
              ["agent", "Agent 回合"],
              ["understand", "provider 理解（需连接器）"],
            ].map(([run, label]) => (
              <div className="webui-design-cap-row" key={run}>
                <span>{label}</span>
                <small>{tools.filter((tool) => tool.run === run).length}</small>
              </div>
            ))}
          </section>
        </>
      ) : null}
    </>
  );
  return active === "delete" ? (
    <WebuiDialog
      open={kind === "delete"}
      dismissOnEscape
      title="删除画布"
      width="compact"
      portalTarget={dom.portalTarget()}
      onClose={onClose}
      testId="design-dialog-delete"
    >
      <p>删除「{document?.title}」？这张画布会从列表里消失。</p>
      <div className="webui-design-node-actions">
        <WebuiButton
          variant="outline-secondary"
          size="regular"
          onClick={onClose}
        >
          取消
        </WebuiButton>
        <WebuiButton
          variant="danger"
          size="regular"
          onClick={async () => {
            if (await onAction({ type: "remove" })) onClose();
          }}
        >
          确认删除画布
        </WebuiButton>
      </div>
    </WebuiDialog>
  ) : (
    <>
      <WebuiDropdown
        managed
        open={Boolean(kind)}
        onOpen={() => undefined}
        onClose={onClose}
        anchorRect={() => anchor}
        managedLayerId="webui-design-global-panel"
        role="dialog"
        ariaLabel={labels[active]}
        className={`webui-design-global-panel webui-design-panel-${active}`}
        side="bottom"
        collision="flip"
        offset={6}
      >
        <div className="webui-design-panel-title">
          {local ? "保存到本地" : labels[active]}
        </div>
        {content}
        <FeedbackLiveRegion className="webui-design-panel-feedback">
          {feedback}
        </FeedbackLiveRegion>
      </WebuiDropdown>
      <WebuiDialog
        open={Boolean(removeTemplate)}
        dismissOnEscape
        title="删除模板"
        width="compact"
        portalTarget={dom.portalTarget()}
        onClose={() => setRemoveTemplate(undefined)}
      >
        <p>
          删除「{removeTemplate?.title ?? removeTemplate?.id}
          」？画布和已生成的素材不受影响。
        </p>
        <div className="webui-design-node-actions">
          <WebuiButton
            variant="outline-secondary"
            size="regular"
            onClick={() => setRemoveTemplate(undefined)}
          >
            取消
          </WebuiButton>
          <WebuiButton
            variant="danger"
            size="regular"
            onClick={async () => {
              if (
                removeTemplate &&
                (await onAction({
                  type: "remove_template",
                  templateId: removeTemplate.id,
                }))
              )
                setRemoveTemplate((current) =>
                  current === removeTemplate ? undefined : current,
                );
            }}
          >
            确认删除模板
          </WebuiButton>
        </div>
      </WebuiDialog>
    </>
  );
}
