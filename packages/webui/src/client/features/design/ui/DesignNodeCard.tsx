import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type PointerEvent,
} from "react";
import {
  IconArrowsDiagonal,
  IconPlayerPlay,
  IconUpload,
  IconMessage,
  IconLink,
  IconPhoto,
  IconFileText,
  IconVideo,
  IconVolume,
  IconFolder,
  IconDots,
  IconDownload,
} from "@tabler/icons-react";
import type {
  DesignAction,
  DesignDocument,
  DesignMedia,
  DesignNode,
  DesignState,
} from "../../../../shared/contracts/design.js";
import {
  KIND_LABELS,
  NODE_FORMS,
  cardTools,
  kindOf,
  portList,
  roleOf,
  runModeOf,
} from "../../../../shared/design/forms.mjs";
import {
  cardLayers,
  errorActions,
  groupMembers,
  nodeKindLabel,
  opsSide,
} from "../../../../shared/design/node-ui.mjs";
import {
  fitParamsToCaps,
  portState,
} from "../../../../shared/design/tools.mjs";
import { WebuiButton, WebuiIconButton } from "../../../ui/button.js";
import { WebuiFileInput, WebuiTextInput } from "../../../ui/field.js";
import { useWebuiToastError, useWebuiToastSuccess } from "../../../ui/toast.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import {
  copyDesignImage,
  copyDesignText,
  designFileBase64,
  downloadDesignMedia,
  runDesignImageTool,
} from "../bindings/use-design.js";
import {
  designAccept,
  designCreatedNodeIds,
  designFailureReport,
  designLimits,
  designNodeText,
  designReferenceSummary,
  designToolBlocked,
  record,
  records,
} from "../projection/design-view.js";
import { DesignMedia as DesignMaterial } from "./DesignMedia.js";
import { DesignPrompt } from "./DesignPrompt.js";
import { DesignNodeParams } from "./DesignNodeParams.js";
import { DesignTextTemplate } from "./DesignTextTemplate.js";
import { DesignCrop } from "./DesignCrop.js";
import { DesignMenu, type DesignMenuEntry } from "./DesignMenu.js";
import type { WebuiDropdownAnchorRect } from "../../../ui/Dropdown.js";
import type { DesignOwner } from "../application/design-owner.js";

const glyphs = {
  input: IconFileText,
  text: IconFileText,
  image: IconPhoto,
  video: IconVideo,
  audio: IconVolume,
  result: IconPhoto,
  group: IconFolder,
};
export interface DesignCardProps {
  readonly node: DesignNode;
  readonly document: DesignDocument;
  readonly data: DesignState;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly connecting?: string;
  readonly related?: boolean;
  readonly zoom?: number;
  readonly renaming?: boolean;
  readonly getDocument: () => DesignDocument | undefined;
  readonly onRenameEnd: () => void;
  readonly registerPendingEdit?: DesignOwner["registerPendingEdit"];
  readonly onPendingChange?: (nodeId: string, pending: boolean) => void;
  readonly onProducts: (
    input: import("../projection/design-view.js").DesignProductPlacement,
  ) => Promise<void>;
  readonly onFitMedia: DesignOwner["fitMedia"];
  readonly onSelect: (id: string, additive: boolean) => void;
  readonly onGesture: (
    event: PointerEvent<HTMLElement>,
    kind: "move" | "resize",
    id: string,
  ) => void;
  readonly onConnect: (id: string, input: boolean, role?: string) => void;
  readonly onPortStart: (
    event: PointerEvent<HTMLElement>,
    id: string,
    input: boolean,
    kind: import("../../../../shared/contracts/design.js").DesignKind,
    role?: string,
  ) => void;
  readonly onAction: (action: DesignAction) => Promise<DesignState | undefined>;
  readonly onTool: (
    media: DesignMedia,
    toolKey?: string,
    nodeId?: string,
    anchor?: WebuiDropdownAnchorRect,
  ) => void;
  readonly onMenu: (nodeId: string, anchor: WebuiDropdownAnchorRect) => void;
  readonly assetUrl: (url: string) => string;
  readonly openSession?: (id: string) => void;
}

/** Original card-layer rules keep material on the card and editing on its selected surface. */
export function DesignNodeCard(props: DesignCardProps): ReactElement {
  const { node, document, data, onAction } = props;
  const { dom } = useWebuiBrowserCapabilities();
  const card = useRef<HTMLElement>(null),
    ops = useRef<HTMLDivElement>(null),
    file = useRef<HTMLInputElement>(null),
    title = useRef<HTMLInputElement>(null);
  const [draftTitle, setDraftTitle] = useState(node.title);
  const [materialMenu, setMaterialMenu] = useState<WebuiDropdownAnchorRect>();
  const [side, setSide] = useState<"above" | "below">("below");
  const [offset, setOffset] = useState(0),
    [opsWidth, setOpsWidth] = useState(620);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useWebuiToastError(error);
  useWebuiToastSuccess(notice);
  const [cropping, setCropping] = useState(false);
  const kind = kindOf(node),
    role = roleOf(node),
    generating = role === "generate";
  const output = node.metadata.output,
    media = output.media[0];
  const ports = portList(node, designLimits(data, node));
  const tools = records(data.capabilities.tools).filter(
    (
      tool,
    ): tool is Readonly<Record<string, unknown>> & {
      key: string;
      kind: string;
    } => typeof tool.key === "string" && typeof tool.kind === "string",
  );
  const layers = cardLayers(node, { tools }),
    dock = cardTools(node, tools);
  const Glyph = glyphs[node.type],
    inherited = designNodeText(document, node),
    sessionId = node.metadata.sessionId;
  const isRunning =
    output.status === "loading" ||
    data.tasks.some(
      (task) =>
        task.nodeId === node.id &&
        [
          "running",
          "queued",
          "pending",
          "waiting_permission",
          "waiting_input",
        ].includes(task.status),
    );
  const currentNode = () =>
    props.getDocument()?.nodes.find((item) => item.id === node.id);
  useEffect(() => {
    const width = Number(media?.width ?? output.width),
      height = Number(media?.height ?? output.height);
    if (media?.url && width > 0 && height > 0)
      void props.onFitMedia({
        nodeId: node.id,
        sourceUrl: media.url,
        width,
        height,
      });
  }, [
    node.width,
    node.metadata.userSized,
    media?.url,
    media?.width,
    media?.height,
    output.width,
    output.height,
  ]);
  const patch = async (metadata: Readonly<Record<string, unknown>>) => {
    const current = currentNode();
    if (!current) return;
    const next = { ...current.metadata, ...metadata },
      fitted = fitParamsToCaps(
        next,
        designLimits(data, { ...current, metadata: next }),
      );
    const normalized = Object.fromEntries(
      ["ratio", "resolution", "duration"]
        .filter((key) => fitted[key] !== current.metadata[key])
        .map((key) => [key, fitted[key]]),
    );
    return onAction({
      type: "update_node",
      nodeId: node.id,
      patch: { metadata: { ...metadata, ...normalized } },
    });
  };
  useEffect(() => {
    if (props.renaming) {
      setDraftTitle(node.title);
      title.current?.focus({ preventScroll: true });
      title.current?.select();
    }
  }, [props.renaming]);
  useEffect(() => {
    if (!props.selected || !card.current || !ops.current) return;
    const position = () => {
      const element = card.current,
        panel = ops.current,
        view = element?.closest("[aria-label='Design 节点画布']");
      if (!element || !panel || !view) return;
      const rect = element.getBoundingClientRect(),
        bounds = view.getBoundingClientRect(),
        width = Math.min(620, Math.max(220, bounds.width - 40));
      setOpsWidth(width);
      setSide(
        opsSide({
          nodeTop: rect.top,
          nodeBottom: rect.bottom,
          panelHeight: panel.getBoundingClientRect().height,
          viewTop: bounds.top,
          viewBottom: bounds.bottom,
        }),
      );
      const middle = (rect.left + rect.right) / 2;
      setOffset(
        Math.min(
          Math.max(middle, bounds.left + width / 2 + 8),
          bounds.right - width / 2 - 8,
        ) - middle,
      );
    };
    position();
    const stopPanel = dom.observeSize(ops.current, position),
      view = card.current.closest<HTMLElement>(
        "[aria-label='Design 节点画布']",
      ),
      stopView = view ? dom.observeSize(view, position) : undefined;
    return () => {
      stopPanel();
      stopView?.();
    };
  }, [
    props.selected,
    node.position.x,
    node.position.y,
    node.width,
    node.height,
    props.zoom,
    dom,
    layers.ops.length,
  ]);
  const commitTitle = () => {
    const value = draftTitle.trim();
    if (value && value !== node.title)
      void onAction({
        type: "update_node",
        nodeId: node.id,
        patch: { title: value },
      });
    props.onRenameEnd();
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const incoming: DesignMedia[] = [];
    for (const chosen of Array.from(files)) {
      const result = await onAction({
        type: "upload",
        name: chosen.name,
        kind,
        base64: await designFileBase64(chosen),
      });
      const asset = record(result?.result);
      if (typeof asset.url !== "string")
        throw new Error(`上传「${chosen.name}」失败，原素材保持不变。`);
      incoming.push({ ...asset, url: asset.url, kind });
    }
    const current = currentNode();
    if (current && incoming.length)
      await patch({
        output: {
          ...current.metadata.output,
          status: "success",
          media: [...current.metadata.output.media, ...incoming],
          text: "",
          error: "",
        },
      });
  };
  const safely = (operation: Promise<unknown>) => {
    void operation.catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  };
  const menuEntries: readonly DesignMenuEntry[] = [
    { action: "replace", label: "换个素材" },
    { action: "copy", label: "复制素材" },
    ...output.media.map((item, index) => ({
      action: `remove:${index}`,
      label: `移除 ${item.name || "这个素材"}`,
      danger: true,
    })),
  ];
  const zoom = props.zoom || 1;
  const sourceTitle = document.connections
    .filter((line) => line.toNodeId === node.id)
    .map((line) => document.nodes.find((item) => item.id === line.fromNodeId))
    .filter((item) => item && kindOf(item) === "text")
    .map((item) => item!.title)
    .join("、");
  const references = designReferenceSummary(document, node.id);
  const actionBar = (
    <div className="webui-design-node-actions">
      {references ? (
        <span className="webui-design-muted">引用 {references}</span>
      ) : null}
      {sessionId ? (
        <>
          <WebuiButton
            variant="plain"
            size="inline-tiny"
            onClick={() => props.openSession?.(sessionId)}
          >
            <IconMessage size={14} />
            对话
          </WebuiButton>
          <WebuiButton
            variant="plain"
            size="inline-tiny"
            disabled={isRunning}
            title={isRunning ? "生成期间不能新建会话" : "下一次生成使用新会话"}
            onClick={() => patch({ sessionId: null }).then(() => undefined)}
          >
            新会话
          </WebuiButton>
        </>
      ) : null}
      <WebuiButton
        variant="primary"
        size="inline-dense"
        disabled={
          isRunning || (runModeOf(node) === "text" && !data.models.length)
        }
        title={
          runModeOf(node) === "text" && !data.models.length
            ? "没有可用的文本模型，请先配置模型"
            : "自动补齐缺少产物的上游节点"
        }
        onClick={() =>
          onAction({ type: "run", nodeId: node.id }).then(() => undefined)
        }
      >
        <IconPlayerPlay size={14} />
        {isRunning ? "生成中…" : "生成"}
      </WebuiButton>
    </div>
  );
  const failure = output.error ? (
    <div className="webui-design-node-error" data-canvas-no-zoom="true">
      <div>{output.error}</div>
      <div className="webui-design-error-actions">
        {errorActions(node).map((action) => (
          <WebuiButton
            key={action.key}
            variant="plain"
            size="inline-tiny"
            onClick={() => {
              if (action.key === "retry")
                void onAction({ type: "run", nodeId: node.id });
              else if (action.key === "delete")
                void onAction({ type: "remove_node", nodeId: node.id });
              else if (action.key === "report")
                safely(
                  copyDesignText(designFailureReport(node)).then(() =>
                    setNotice("已复制节点信息，可以贴出来上报"),
                  ),
                );
              else void patch({ output: { error: "", status: "idle" } });
            }}
          >
            {action.label}
          </WebuiButton>
        ))}
      </div>
    </div>
  ) : null;
  return (
    <article
      ref={card}
      className="webui-design-node"
      data-design-node={node.id}
      data-design-node-type={node.type}
      data-selected={props.selected ? "true" : "false"}
      data-dimmed={props.related === false ? "true" : undefined}
      data-kind={kind}
      data-has-output={output.media.length || output.text ? "true" : "false"}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: node.width,
        height: node.height,
      }}
      aria-label={`${NODE_FORMS[node.type].label}：${node.title}${props.selected ? "（已选中）" : ""}`}
      onPointerDown={(event) => {
        if (
          !event.currentTarget.contains(event.target as Node) ||
          event.button !== 0 ||
          (event.target as HTMLElement).closest(
            "a,[role=link],button,input,textarea,select,[contenteditable=true],.webui-design-node-ops,.webui-design-node-rail,.webui-design-material-strip",
          )
        )
          return;
        props.onSelect(
          node.id,
          event.shiftKey || event.ctrlKey || event.metaKey,
        );
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey)
          props.onGesture(event, "move", node.id);
      }}
    >
      <header className="webui-design-node-header">
        {props.renaming ? (
          <WebuiTextInput
            ref={title}
            aria-label="节点名称"
            appearance="bare"
            textSize="small"
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitTitle();
              } else if (event.key === "Escape") {
                event.preventDefault();
                props.onRenameEnd();
              }
            }}
          />
        ) : null}
      </header>
      {role === "group" ? (
        <div className="webui-design-group-note">
          {groupMembers(node, document.nodes).length} 个节点
        </div>
      ) : (
        <>
          {ports.map((port, index) => (
            <WebuiIconButton
              key={`${port.kind}-${port.role ?? ""}`}
              tone="bare"
              size="compact"
              className="webui-design-port webui-design-port-input"
              style={{
                top:
                  node.height / 2 + (index - (ports.length - 1) / 2) * 30 - 12,
              }}
              label={`连接到 ${node.title} 的 ${port.label ?? KIND_LABELS[port.kind]}${port.role ?? ""}输入`}
              data-design-port="input"
              data-port-kind={port.kind}
              data-port-role={port.role ?? ""}
              data-port-state={portState(document, node, port)}
              onPointerDown={(event) =>
                props.onPortStart(event, node.id, true, port.kind, port.role)
              }
              onClick={(event) => {
                if (event.detail === 0)
                  props.onConnect(node.id, true, port.role);
              }}
            >
              <IconLink size={14} />
            </WebuiIconButton>
          ))}
          <WebuiIconButton
            tone="bare"
            size="compact"
            className="webui-design-port webui-design-port-output"
            style={{ top: node.height / 2 - 12 }}
            label={`从 ${node.title} 连接`}
            data-design-port="output"
            data-port-kind={kind}
            onPointerDown={(event) =>
              props.onPortStart(event, node.id, false, kind)
            }
            onClick={(event) => {
              if (event.detail === 0) props.onConnect(node.id, false);
            }}
          >
            <IconLink size={14} />
          </WebuiIconButton>
          <div
            className="webui-design-card-body"
            data-has-message={output.error ? "true" : undefined}
          >
            <div className="webui-design-card-material">
              {media ? (
                <DesignMaterial
                  node={node}
                  assetUrl={props.assetUrl}
                  overlay={
                    cropping ? (
                      <DesignCrop
                        onCancel={() => setCropping(false)}
                        onApply={async (rect) => {
                          const products = await runDesignImageTool(
                            dom,
                            props.assetUrl(media.url),
                            "crop",
                            { rect },
                          );
                          const ids: string[] = [];
                          for (const product of products) {
                            const result = await onAction({
                              type: "publish",
                              ...product,
                              sourceNodeId: node.id,
                            });
                            if (!result) throw new Error("裁剪结果未保存");
                            ids.push(...designCreatedNodeIds(result));
                          }
                          if (ids.length)
                            await props.onProducts({
                              ids,
                              sourceNodeId: node.id,
                            });
                          setCropping(false);
                        }}
                      />
                    ) : undefined
                  }
                  onPoster={async ({ sourceUrl, base64 }) => {
                    if (
                      currentNode()?.metadata.output.media[0]?.url === sourceUrl
                    )
                      return await onAction({
                        type: "set_media_poster",
                        nodeId: node.id,
                        sourceUrl,
                        base64,
                      });
                  }}
                  onOutputMetadata={(metadata) => {
                    if (
                      currentNode()?.metadata.output.media[0]?.url === media.url
                    )
                      void patch({ output: metadata });
                  }}
                  onFit={(size) => {
                    void props.onFitMedia({
                      nodeId: node.id,
                      sourceUrl: media.url,
                      width: Number(media.width ?? output.width) || size.width,
                      height:
                        Number(media.height ?? output.height) || size.height,
                    });
                  }}
                />
              ) : layers.material.includes("text") || output.text ? (
                <div
                  className="webui-design-text-output"
                  data-input-editing={
                    props.selected && role === "input" ? "true" : undefined
                  }
                >
                  {output.text || node.metadata.prompt || "写要送进去的内容"}
                </div>
              ) : (
                <div className="webui-design-media-empty">
                  <Glyph size={36} stroke={1.2} />
                  <span>
                    {isRunning
                      ? "生成中…"
                      : nodeKindLabel(node, { inputKindLabels: KIND_LABELS })}
                  </span>
                </div>
              )}
              {output.media.length > 1 ? (
                <div
                  className="webui-design-material-strip"
                  data-canvas-no-zoom="true"
                >
                  {output.media.map((item, index) => (
                    <div key={item.url}>
                      {item.kind === "image" ? (
                        <img
                          src={props.assetUrl(item.url)}
                          alt={item.name ?? `素材 ${index + 1}`}
                          draggable={false}
                        />
                      ) : (
                        <span>{item.name ?? KIND_LABELS[item.kind]}</span>
                      )}
                      <WebuiIconButton
                        tone="bare"
                        size="compact"
                        className="webui-design-material-strip-button"
                        label={`移除素材 ${index + 1}`}
                        onClick={() => {
                          const current = currentNode();
                          if (current)
                            void patch({
                              output: {
                                ...current.metadata.output,
                                media: current.metadata.output.media.filter(
                                  (asset) => asset.url !== item.url,
                                ),
                              },
                            });
                        }}
                      >
                        ×
                      </WebuiIconButton>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            {failure}
          </div>
          <WebuiFileInput
            ref={file}
            multiple={kind === "image"}
            accept={designAccept(kind)}
            aria-label={`上传${KIND_LABELS[kind]}`}
            onChange={(event) => {
              const files = event.currentTarget.files;
              safely(upload(files));
              event.currentTarget.value = "";
            }}
          />
          {props.selected && layers.above.length ? (
            <div
              className="webui-design-node-rail"
              data-canvas-no-zoom="true"
              style={{
                transform: `scale(${1 / zoom}) translate(-50%, -100%)`,
                top: -10 / zoom,
              }}
            >
              {layers.above.includes("upload") ? (
                <WebuiButton
                  variant="outline-secondary"
                  size="inline-dense"
                  onClick={() => file.current?.click()}
                >
                  <IconUpload size={15} />
                  上传{KIND_LABELS[kind]}
                </WebuiButton>
              ) : null}
              {layers.above.includes("tools")
                ? dock.map((tool) => (
                    <WebuiButton
                      key={tool.key}
                      variant="plain"
                      size="inline-tiny"
                      disabled={Boolean(designToolBlocked(tool, node, data))}
                      title={
                        designToolBlocked(tool, node, data) ??
                        String(tool.desc ?? tool.label ?? tool.key)
                      }
                      onClick={(event) => {
                        const rect =
                          event.currentTarget.getBoundingClientRect();
                        if (tool.key === "crop") setCropping(!cropping);
                        else if (media)
                          props.onTool(media, tool.key, node.id, {
                            left: rect.left,
                            top: rect.top,
                            width: rect.width,
                            height: rect.height,
                          });
                      }}
                      data-design-tool={tool.key}
                    >
                      {String(tool.label ?? tool.key)}
                      {tool.status !== "ready" ? "（待接入）" : ""}
                    </WebuiButton>
                  ))
                : null}
              {layers.above.includes("save") && media ? (
                <WebuiIconButton
                  tone="bare"
                  size="compact"
                  label="保存到本地"
                  onClick={() =>
                    safely(
                      downloadDesignMedia(
                        dom,
                        props.assetUrl(media.url),
                        media.name ?? node.title,
                      ),
                    )
                  }
                >
                  <IconDownload size={16} />
                </WebuiIconButton>
              ) : null}
              {layers.above.includes("menu") ? (
                <WebuiIconButton
                  tone="bare"
                  size="compact"
                  label="素材菜单"
                  onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setMaterialMenu({
                      left: box.left,
                      top: box.bottom,
                      width: box.width,
                      height: 0,
                    });
                  }}
                >
                  <IconDots size={16} />
                </WebuiIconButton>
              ) : null}
            </div>
          ) : null}
          {props.selected && layers.ops.length ? (
            <div
              ref={ops}
              className="webui-design-node-ops"
              data-side={side}
              data-canvas-no-zoom="true"
              style={{
                width: opsWidth,
                left: node.width / 2 + offset / zoom,
                ...(side === "below"
                  ? { top: node.height + 10 / zoom }
                  : { bottom: node.height + 10 / zoom }),
                transform: `scale(${1 / zoom}) translateX(-50%)`,
                transformOrigin: side === "below" ? "0 0" : "0 100%",
              }}
            >
              {layers.ops.includes("style") ? (
                <DesignTextTemplate
                  node={node}
                  data={data}
                  onPatch={patch}
                  registerPendingEdit={props.registerPendingEdit}
                  onPendingChange={(pending) =>
                    props.onPendingChange?.(`${node.id}:template`, pending)
                  }
                />
              ) : null}
              {layers.ops.includes("composer") ? (
                <DesignPrompt
                  registerPendingEdit={props.registerPendingEdit}
                  onPendingChange={(pending) =>
                    props.onPendingChange?.(`${node.id}:prompt`, pending)
                  }
                  node={node}
                  document={document}
                  assetUrl={props.assetUrl}
                  inherited={
                    inherited.inherited
                      ? { text: inherited.text, title: sourceTitle }
                      : undefined
                  }
                  onSave={(segments) =>
                    patch({
                      segments,
                      prompt: segments
                        .map((part) =>
                          part.type === "text"
                            ? part.text
                            : `[[cw:${part.kind}:${part.nodeId}]]`,
                        )
                        .join(""),
                      mentions: segments
                        .filter((part) => part.type === "mention")
                        .map((part) => ({
                          nodeId: part.nodeId,
                          kind: part.kind,
                        })),
                    })
                  }
                />
              ) : null}
              {layers.ops.includes("params") ? (
                <DesignNodeParams
                  registerPendingEdit={props.registerPendingEdit}
                  onPendingChange={(pending) =>
                    props.onPendingChange?.(`${node.id}:preset`, pending)
                  }
                  node={node}
                  data={data}
                  onPatch={patch}
                  onAction={onAction}
                  actions={generating ? actionBar : undefined}
                />
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {props.selected ? (
        <WebuiIconButton
          tone="bare"
          size="compact"
          className="webui-design-node-more"
          label={`节点菜单 ${node.title}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            props.onMenu(node.id, {
              left: rect.left,
              top: rect.bottom,
              width: rect.width,
              height: 0,
            });
          }}
        >
          <IconDots size={14} />
        </WebuiIconButton>
      ) : null}
      {props.selected ? (
        <WebuiIconButton
          tone="bare"
          size="compact"
          className="webui-design-resize"
          label={`调整 ${node.title} 大小`}
          onPointerDown={(event) => props.onGesture(event, "resize", node.id)}
        >
          <IconArrowsDiagonal size={14} />
        </WebuiIconButton>
      ) : null}
      <DesignMenu
        open={Boolean(materialMenu)}
        anchor={materialMenu ?? { left: 0, top: 0, width: 0, height: 0 }}
        label="素材操作"
        entries={menuEntries}
        onClose={() => setMaterialMenu(undefined)}
        onChoose={(action) => {
          setMaterialMenu(undefined);
          if (action === "replace") {
            file.current?.click();
          } else if (action === "copy" && media)
            safely(copyDesignImage(dom, props.assetUrl(media.url)));
          else if (action.startsWith("remove:")) {
            const removing = output.media[Number(action.slice(7))];
            const current = currentNode();
            if (current && removing)
              void patch({
                output: {
                  media: current.metadata.output.media.filter(
                    (item) => item.url !== removing.url,
                  ),
                  ...(current.metadata.output.media.length === 1
                    ? { text: "", status: "idle" }
                    : {}),
                },
              });
          }
        }}
      />
    </article>
  );
}
