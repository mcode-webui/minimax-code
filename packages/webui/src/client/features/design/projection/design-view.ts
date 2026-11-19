import type {
  DesignDocument,
  DesignKind,
  DesignNode,
  DesignNodeMetadata,
  DesignState,
} from "../../../../shared/contracts/design.js";
import { kindOf, runModeOf } from "../../../../shared/design/forms.mjs";
import {
  toolSizeReason,
  planBatchPlacement,
  pushAside,
  TILE_CARD,
  mediaBoxFor,
  planPaste,
} from "../../../../shared/design/tools.mjs";
import type { WebuiQuestionnaireAnswer } from "../../../../shared/contracts/interactions.js";

export const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
export const records = (
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] =>
  Array.isArray(value) ? value.map(record) : [];
export const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.map(String) : [];
export interface DesignProductPlacement {
  readonly ids: readonly string[];
  readonly sourceNodeId: string;
  readonly columns?: number;
  readonly tile?: boolean;
  readonly measured?: boolean;
  readonly origin?: { readonly x: number; readonly y: number };
  /**
   * The cards the board held when this placement was made.
   *
   * A card that is not among them is one the person placed after the
   * placement: it is theirs, and a placement that is laid out again gives
   * way to it — the card in the way steps aside instead. The rule reads the
   * board it is given, so the cards it keeps are the ones that are on the
   * board when the placement is saved.
   */
  readonly known?: readonly string[];
}
export const designCreatedNodeIds = (
  state: DesignState | undefined,
): readonly string[] =>
  strings(record(state?.result).createdNodeIds).filter((id) =>
    state?.document?.nodes.some((node) => node.id === id),
  );
export function designMediaGeometry(
  node: DesignNode,
  intrinsic: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  const size = mediaBoxFor(
    intrinsic.width / intrinsic.height,
    node.width,
    Boolean(node.metadata.userSized),
  );
  return { width: size.width, height: Math.round(size.height + 20) };
}
export function designPlaceProducts(
  document: DesignDocument,
  input: DesignProductPlacement,
): DesignDocument {
  const source = document.nodes.find((node) => node.id === input.sourceNodeId);
  const products = input.ids
    .map((id) => document.nodes.find((node) => node.id === id))
    .filter((node): node is DesignNode => Boolean(node));
  if (!source || !products.length) return document;
  const sizes = products.map((node) =>
    input.tile && !input.measured
      ? TILE_CARD
      : { width: node.width, height: node.height },
  );
  const plan = planBatchPlacement({
    sizes,
    originX:
      input.origin?.x ??
      source.position.x + source.width + (input.tile ? 60 : 80),
    originY: input.origin?.y ?? source.position.y + 40,
    perRow: input.columns,
  });
  const positions = new Map(
    products.map((node, index) => [
      node.id,
      {
        ...sizes[index]!,
        position: { x: plan.cells[index]!.x, y: plan.cells[index]!.y },
      },
    ]),
  );
  // The cards the person placed after this placement are theirs: the
  // placement gives way to them, and the card in the way steps aside. A
  // product of a run is not theirs — the runtime placed it, and the
  // placement may still move it.
  const known = new Set(input.known ?? []);
  const keep = input.known
    ? document.nodes
        .filter(
          (node) =>
            !known.has(node.id) &&
            node.type !== "result" &&
            !products.some((product) => product.id === node.id),
        )
        .map((node) => node.id)
    : [];
  // The retained collision rule mutates positions, so give it fresh geometry.
  return pushAside(
    {
      ...document,
      nodes: document.nodes.map((node) => ({
        ...node,
        position: { ...node.position },
        ...(positions.get(node.id) ?? {}),
      })),
    },
    products.map((node) => node.id),
    { keepIds: keep },
  );
}
export const designAddedNodeId = (
  state: DesignState | undefined,
): string | undefined => {
  const id = record(state?.result).id;
  return typeof id === "string" ? id : undefined;
};
export function designPromptPatch(
  segments: DesignNodeMetadata["segments"],
): Pick<DesignNodeMetadata, "prompt" | "segments" | "mentions"> {
  return {
    segments,
    prompt: segments
      .map((part) =>
        part.type === "text" ? part.text : `[[cw:${part.kind}:${part.nodeId}]]`,
      )
      .join(""),
    mentions: segments
      .filter((part) => part.type === "mention")
      .map((part) => ({ nodeId: part.nodeId, kind: part.kind })),
  };
}
export function designToolBlocked(
  tool: Readonly<Record<string, unknown>>,
  node: DesignNode,
  data: DesignState,
): string | undefined {
  if (node.metadata.output.missing)
    return "这张素材已经不在了，重新生成上游那一步，或者从资产库把它插回来";
  if (tool.status !== "ready") return String(tool.pendingReason ?? "尚未接入");
  if (tool.run === "ffmpeg" && !data.mediaStatus.available)
    return "本机没有找到 ffmpeg";
  if (
    ["understand", "connector"].includes(String(tool.run)) &&
    data.mediaStatus.canUpload === false
  )
    return "当前客户端没有提供素材上传能力，provider 读不到这段素材";
  const media = node.metadata.output.media[0];
  if (tool.run === "connector") {
    const reason = toolSizeReason(tool, {
      width: Number(media?.width ?? node.metadata.output.width ?? 0),
      height: Number(media?.height ?? node.metadata.output.height ?? 0),
      bytes: media?.bytes,
    });
    if (reason) return reason;
  }
  if (tool.needs && !media) return "这个节点还没有素材，先生成一张再用工具";
}
export function designReferenceSummary(
  document: DesignDocument,
  nodeId: string,
): string {
  const ids = new Set(
    document.connections
      .filter((line) => line.toNodeId === nodeId)
      .map((line) => line.fromNodeId),
  );
  const kinds = document.nodes
    .filter((node) => ids.has(node.id))
    .map((node) => node.metadata.output.media[0]?.kind);
  return (
    [
      ["image", "图"],
      ["video", "视频"],
      ["audio", "音频"],
    ] as const
  )
    .map(([kind, label]) => {
      const count = kinds.filter((item) => item === kind).length;
      return count ? `${count} ${label}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}
export function designRelatedToSelection(
  document: DesignDocument | undefined,
  selected: readonly string[],
  nodeId: string,
): boolean {
  return (
    !selected.length ||
    selected.includes(nodeId) ||
    Boolean(
      document?.connections.some(
        (line) =>
          (selected.includes(line.fromNodeId) && line.toNodeId === nodeId) ||
          (selected.includes(line.toNodeId) && line.fromNodeId === nodeId),
      ),
    )
  );
}

/** The runtime's extracted palette is the authority for model parameters. */
export function designLimits(
  data: DesignState,
  node: DesignNode,
): Readonly<Record<string, unknown>> {
  const mode = runModeOf(node);
  const byModel = record(record(data.capabilities.modesByModel)[mode]);
  const model = node.metadata.model;
  return model && byModel[model]
    ? record(byModel[model])
    : record(record(data.capabilities.modes)[mode]);
}

export function designModels(
  data: DesignState,
  node: DesignNode,
): readonly { readonly value: string; readonly label: string }[] {
  const models = records(
    record(record(data.capabilities.modes)[runModeOf(node)]).models,
  );
  return runModeOf(node) === "text"
    ? data.models.map((model) => ({ value: model.key, label: model.label }))
    : models.map((model) => ({
        value: String(model.id),
        label: String(model.label ?? model.id),
      }));
}

export function designNodeText(
  document: DesignDocument,
  node: DesignNode,
): { readonly text: string; readonly inherited: boolean } {
  const source = document.connections
    .filter((line) => line.toNodeId === node.id)
    .map((line) =>
      document.nodes.find((candidate) => candidate.id === line.fromNodeId),
    )
    .filter(
      (candidate): candidate is DesignNode =>
        Boolean(candidate) && kindOf(candidate!) === "text",
    );
  const text = source
    .map(
      (candidate) =>
        candidate.metadata.output.text ||
        (candidate.type === "input" ? candidate.metadata.prompt : ""),
    )
    .filter(Boolean)
    .join("\n\n");
  return text
    ? { text, inherited: true }
    : { text: node.metadata.prompt, inherited: false };
}

export function designWorldPoint(
  x: number,
  y: number,
  viewport: DesignDocument["viewport"],
): { readonly x: number; readonly y: number } {
  return {
    x: Math.round((x - viewport.x) / viewport.k),
    y: Math.round((y - viewport.y) / viewport.k),
  };
}
export function designLibraryPosition(
  viewport: DesignDocument["viewport"],
  size: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const center = designWorldPoint(size.width / 2, size.height / 2, viewport);
  return { x: center.x - 150, y: center.y - 90 };
}
export function designFailureReport(node: DesignNode): string {
  return `节点：${node.title}\nID：${node.id}\n错误：${node.metadata.output.error}`;
}

export function designZoom(
  viewport: DesignDocument["viewport"],
  delta: number,
  point: { readonly x: number; readonly y: number },
): DesignDocument["viewport"] {
  const k = Math.max(0.05, Math.min(5, viewport.k * Math.exp(-delta * 0.0015)));
  const factor = k / viewport.k;
  return {
    k,
    x: point.x - (point.x - viewport.x) * factor,
    y: point.y - (point.y - viewport.y) * factor,
  };
}

export function designEdgePath(
  from: DesignNode,
  to: DesignNode,
  portIndex = 0,
  portCount = 1,
): string {
  const x1 = from.position.x + from.width;
  const y1 = from.position.y + from.height / 2;
  const x2 = to.position.x;
  const y2 =
    to.position.y + to.height / 2 + (portIndex - (portCount - 1) / 2) * 30;
  const bend = Math.max(72, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export function designDownstreamTypes(
  kind: DesignKind,
  capabilities: DesignState["capabilities"],
): readonly ("text" | "image" | "video" | "audio")[] {
  const modes = record(capabilities.modes);
  return [
    ...new Set(
      strings(record(capabilities.upstreamAccepts)[kind])
        .filter((mode) => Boolean(modes[mode]))
        .map((mode) => (mode === "music" ? "audio" : mode))
        .filter((mode): mode is "text" | "image" | "video" | "audio" =>
          ["text", "image", "video", "audio"].includes(mode),
        ),
    ),
  ];
}

export function designMinimap(
  nodes: readonly DesignNode[],
  viewport: DesignDocument["viewport"],
  size: { readonly width: number; readonly height: number },
) {
  const view = {
    x: -viewport.x / viewport.k,
    y: -viewport.y / viewport.k,
    width: size.width / viewport.k,
    height: size.height / viewport.k,
  };
  const left = Math.min(view.x, ...nodes.map((node) => node.position.x)) - 60;
  const top = Math.min(view.y, ...nodes.map((node) => node.position.y)) - 60;
  const right =
    Math.max(
      view.x + view.width,
      ...nodes.map((node) => node.position.x + node.width),
    ) + 60;
  const bottom =
    Math.max(
      view.y + view.height,
      ...nodes.map((node) => node.position.y + node.height),
    ) + 60;
  return { x: left, y: top, width: right - left, height: bottom - top, view };
}

export function designCenterView(
  point: { readonly x: number; readonly y: number },
  viewport: DesignDocument["viewport"],
  size: { readonly width: number; readonly height: number },
): DesignDocument["viewport"] {
  return {
    x: size.width / 2 - point.x * viewport.k,
    y: size.height / 2 - point.y * viewport.k,
    k: viewport.k,
  };
}

export function designAccept(kind: DesignKind): string {
  return kind === "text" ? ".txt,text/plain" : `${kind}/*`;
}

export function designNewNodePosition(document: DesignDocument): {
  readonly x: number;
  readonly y: number;
} {
  const origin = designWorldPoint(80, 60, document.viewport);
  for (let index = 0; index <= document.nodes.length; index += 1) {
    const candidate = {
      x: origin.x + (index % 3) * 380,
      y: origin.y + Math.floor(index / 3) * 480,
    };
    if (
      !document.nodes.some(
        (node) =>
          node.type !== "group" &&
          candidate.x < node.position.x + node.width + 32 &&
          candidate.x + 320 + 32 > node.position.x &&
          candidate.y < node.position.y + node.height + 32 &&
          candidate.y + 400 + 32 > node.position.y,
      )
    )
      return candidate;
  }
  return {
    x:
      Math.max(
        0,
        ...document.nodes.map((node) => node.position.x + node.width),
      ) + 64,
    y: origin.y,
  };
}

/** A gesture changes geometry; a run may have changed the same card's product. */
export function mergeDesignGesture(
  document: DesignDocument,
  preview: readonly DesignNode[],
  movingIds: readonly string[],
  resizeId?: string,
): DesignDocument {
  const affected = new Set(movingIds);
  const previews = new Map(preview.map((node) => [node.id, node]));
  return {
    ...document,
    nodes: document.nodes.map((node) => {
      const geometry = affected.has(node.id)
        ? previews.get(node.id)
        : undefined;
      if (!geometry) return node;
      if (resizeId)
        return node.id === resizeId
          ? {
              ...node,
              width: geometry.width,
              height: geometry.height,
              metadata: { ...node.metadata, userSized: true },
            }
          : node;
      return { ...node, position: geometry.position };
    }),
  };
}

export function designPromptSegments(prompt: string): readonly (
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "mention";
      readonly nodeId: string;
      readonly kind: DesignKind;
    }
)[] {
  const pieces: (
    | { type: "text"; text: string }
    | { type: "mention"; nodeId: string; kind: DesignKind }
  )[] = [];
  const token = /\[\[cw:(text|image|video|audio):([^\]]+)\]\]/gu;
  let cursor = 0;
  for (const match of prompt.matchAll(token)) {
    const offset = match.index!;
    if (offset > cursor)
      pieces.push({ type: "text", text: prompt.slice(cursor, offset) });
    pieces.push({
      type: "mention",
      kind: match[1] as DesignKind,
      nodeId: match[2]!,
    });
    cursor = offset + match[0].length;
  }
  if (cursor < prompt.length)
    pieces.push({ type: "text", text: prompt.slice(cursor) });
  return pieces;
}

/** A copy keeps media products but receives new graph and execution identities. */
export function cloneDesignSelection(
  selection: {
    readonly nodes: readonly DesignNode[];
    readonly connections: DesignDocument["connections"];
  },
  idFor: (kind: "node" | "connection") => string,
  placement?: {
    readonly viewport: DesignDocument["viewport"];
    readonly viewportSize: { readonly width: number; readonly height: number };
  },
): {
  readonly nodes: readonly DesignNode[];
  readonly connections: DesignDocument["connections"];
} {
  const ids = new Map(selection.nodes.map((node) => [node.id, idFor("node")]));
  const remap = (id: string) => ids.get(id) ?? id;
  const nodes = selection.nodes.map((node) => {
    const {
      taskId: _task,
      runId: _run,
      sessionId: _session,
      ...output
    } = node.metadata.output;
    const metadata = node.metadata;
    return {
      ...node,
      id: remap(node.id),
      position: { x: node.position.x + 64, y: node.position.y + 64 },
      metadata: {
        ...metadata,
        sessionId: null,
        sourceTaskId: "",
        ...(metadata.sourceNodeId
          ? { sourceNodeId: remap(metadata.sourceNodeId) }
          : {}),
        prompt: metadata.prompt.replace(
          /\[\[cw:(text|image|video|audio):([^\]]+)\]\]/gu,
          (_match, kind: string, id: string) => `[[cw:${kind}:${remap(id)}]]`,
        ),
        segments: metadata.segments.map((part) =>
          part.type === "mention"
            ? { ...part, nodeId: remap(part.nodeId) }
            : part,
        ),
        mentions: metadata.mentions.map((mention) => ({
          ...mention,
          nodeId: remap(mention.nodeId),
        })),
        output: {
          ...output,
          status:
            output.status === "loading" ? ("idle" as const) : output.status,
          media: output.media.map(({ taskId: _mediaTask, ...media }) => ({
            ...media,
            ...(media.nodeId && ids.has(media.nodeId)
              ? { nodeId: remap(media.nodeId) }
              : {}),
          })),
        },
      },
    };
  });
  return {
    nodes: placement ? planPaste({ clip: { nodes }, ...placement }) : nodes,
    connections: selection.connections.map((line) => ({
      ...line,
      id: idFor("connection"),
      fromNodeId: remap(line.fromNodeId),
      toNodeId: remap(line.toNodeId),
    })),
  };
}

/**
 * What one connector row really says.
 *
 * A tool that is absent is not automatically "not granted": the account may be
 * logged out, the login may have expired, or the provider inventory may have
 * failed. Only a successful discovery that omits the tool means the account does
 * not offer it.
 */
export function connectorToolStateLabel(tool: Readonly<Record<string, unknown>>): string {
  if (tool.granted === true) return "可用";
  const state = String(tool.state ?? "");
  if (state === "not-connected") return "未连接账户";
  if (state === "auth-failed") return "登录已失效";
  if (state === "discovery-failed") return "发现失败";
  if (state === "unavailable") return "宿主无连接器";
  if (state === "partial") return "部分可用";
  if (state === "unsupported") return "账户未提供";
  return "状态未知";
}

/** The one-line discovery summary above the connector table. */
export function connectorDiscoverySummary(
  discovery: Readonly<Record<string, unknown>> | undefined,
): string {
  const status = String(discovery?.status ?? "unknown");
  const failures = Array.isArray(discovery?.providerFailures)
    ? discovery.providerFailures
        .map((failure) => {
          const row = record(failure);
          return [row.provider, row.code].filter(Boolean).join(": ");
        })
        .filter(Boolean)
    : [];
  const base =
    status === "ready"
      ? "账户连接器已发现"
      : status === "partial"
        ? "账户连接器部分可用"
        : status === "not-connected"
          ? "未连接账户：登录后才能发现云 provider 工具"
          : status === "auth-failed"
            ? "登录已失效：重新登录后才能发现云 provider 工具"
            : status === "discovery-failed"
              ? `连接器发现失败${discovery?.message ? `：${String(discovery.message)}` : ""}`
              : status === "unavailable"
                ? "当前宿主没有连接器访问能力"
                : "连接器状态未知";
  return failures.length > 0 ? `${base}；未就绪：${failures.join("、")}` : base;
}

export function designQuestionChoice(
  current: WebuiQuestionnaireAnswer,
  optionId: string,
  multiple: boolean,
): WebuiQuestionnaireAnswer {
  const previous = current.selectedOptionIds ?? [];
  return {
    ...current,
    selectedOptionIds: multiple
      ? previous.includes(optionId)
        ? previous.filter((id) => id !== optionId)
        : [...previous, optionId]
      : [optionId],
    selectedOther: multiple ? current.selectedOther === true : false,
  };
}
export function designQuestionOther(
  current: WebuiQuestionnaireAnswer,
  multiple: boolean,
  selected: boolean,
  text = current.otherText ?? "",
): WebuiQuestionnaireAnswer {
  return {
    ...current,
    selectedOptionIds:
      selected && !multiple ? [] : (current.selectedOptionIds ?? []),
    selectedOther: selected,
    otherText: text,
  };
}
export function designQuestionAnswered(
  current: WebuiQuestionnaireAnswer,
): boolean {
  return Boolean(
    current.selectedOptionIds?.length ||
    (current.selectedOther === true && current.otherText?.trim()),
  );
}
