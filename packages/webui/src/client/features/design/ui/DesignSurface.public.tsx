import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { IconPlus, IconHierarchy } from "@tabler/icons-react";
import type {
  DesignAction,
  DesignDocument,
  DesignKind,
  DesignNode,
  DesignState,
  GetDesignStateRequest,
} from "../../../../shared/contracts/design.js";
import {
  kindOf,
  NODE_FORMS,
  NODE_KINDS,
  portList,
} from "../../../../shared/design/forms.mjs";
import { nodeMenuEntries } from "../../../../shared/design/node-ui.mjs";
import {
  bandSelection,
  dragPositions,
} from "../../../../shared/design/tools.mjs";
import { WebuiPage } from "../../../ui/page.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiSelectMenu, WebuiTextInput } from "../../../ui/field.js";
import { FeedbackEmpty, FeedbackLiveRegion } from "../../../ui/feedback.js";
import { useWebuiToastError, useWebuiToastSuccess } from "../../../ui/toast.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import {
  useDesign,
  openDesignTab,
  updateDesignTabDocument,
  useDesignAppearance,
  useDesignPageLifecycle,
  copyDesignText,
  copyDesignImage,
  downloadDesignMedia,
} from "../bindings/use-design.js";
import {
  cloneDesignSelection,
  designAddedNodeId,
  designCenterView,
  designDownstreamTypes,
  designEdgePath,
  designLimits,
  designMinimap,
  designRelatedToSelection,
  designPlaceProducts,
  type DesignProductPlacement,
  designWorldPoint,
  designZoom,
  mergeDesignGesture,
  record,
  records,
} from "../projection/design-view.js";
import {
  designHitNode,
  designHitPort,
  designSvgPoint,
} from "../bindings/design-hit.js";
import {
  designFitView,
  designGroupSelection,
  designNextTitle,
  designRemoveSelection,
} from "../projection/design-commands.js";
import { DesignNodeCard } from "./DesignNodeCard.js";
import { DesignDialogs, type DesignDialog } from "./DesignDialogs.js";
import { DesignMenu, type DesignMenuEntry } from "./DesignMenu.js";
import { DesignTaskPanel } from "./DesignTaskPanel.js";
import {
  DesignToolPanel,
  type DesignToolSelection,
} from "./DesignToolPanel.js";
import type { WebuiDropdownAnchorRect } from "../../../ui/Dropdown.js";

interface Gesture {
  readonly kind: "pan" | "move" | "resize" | "band";
  readonly x: number;
  readonly y: number;
  readonly viewport: DesignDocument["viewport"];
  readonly nodes: readonly DesignNode[];
  readonly nodeId?: string;
}
interface LinkGesture {
  readonly nodeId: string;
  readonly input: boolean;
  readonly kind: DesignKind;
  readonly role?: string;
  readonly x: number;
  readonly y: number;
  readonly origin: { readonly x: number; readonly y: number };
  readonly moved: boolean;
}

/** A native graph business rendered both in the workspace and its own browser tab. */
export function DesignSurface({
  sessionId,
  documentId,
  standalone = false,
  openSession,
}: GetDesignStateRequest & {
  readonly standalone?: boolean;
  readonly openSession?: (id: string) => void;
}): ReactElement {
  const { owner, snapshot } = useDesign({ sessionId, documentId });
  const { dom } = useWebuiBrowserCapabilities();
  const data = snapshot.data;
  const document = data?.document;
  const [dialog, setDialog] = useState<DesignDialog>();
  const [panelAnchor, setPanelAnchor] = useState<WebuiDropdownAnchorRect>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const [toolSelection, setToolSelection] = useState<DesignToolSelection>();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [pendingEditors, setPendingEditors] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const productGroups = useRef(
    new Map<string, { input: DesignProductPlacement; sizes: string }>(),
  );
  const reportPending = (nodeId: string, pending: boolean): void =>
    setPendingEditors((current) => {
      if (current.has(nodeId) === pending) return current;
      const next = new Set(current);
      if (pending) next.add(nodeId);
      else next.delete(nodeId);
      return next;
    });
  useDesignPageLifecycle({
    pending: pendingEditors.size > 0,
    flush: () => owner?.flushEdits() ?? Promise.resolve(),
    preserve: () => owner?.preserveEdits() ?? Promise.resolve(false),
  });
  const [edge, setEdge] = useState<string>();
  const [connecting, setConnecting] = useState<string>();
  const [viewport, setViewport] = useState<DesignDocument["viewport"]>({
    x: 80,
    y: 60,
    k: 1,
  });
  const [previewNodes, setPreviewNodes] = useState<readonly DesignNode[]>();
  const [band, setBand] = useState<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  }>();
  const [minimap, setMinimap] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [menu, setMenu] = useState<{
    readonly kind: "node" | "edge" | "blank" | "add" | "downstream";
    readonly anchor: WebuiDropdownAnchorRect;
    readonly nodeId?: string;
    readonly edgeId?: string;
  }>();
  const link = useRef<LinkGesture>();
  const [linkEnd, setLinkEnd] = useState<{
    readonly x: number;
    readonly y: number;
  }>();
  const [rename, setRename] = useState<string>();
  const [renamingNode, setRenamingNode] = useState<string>();
  const renameInput = useRef<HTMLInputElement>(null);
  const renaming = useRef(false);
  const appearance = useDesignAppearance();
  const gesture = useRef<Gesture>();
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const clipboard = useRef<{
    readonly nodes: readonly DesignNode[];
    readonly connections: DesignDocument["connections"];
  }>();
  const wheelSave = useRef<ReturnType<typeof setTimeout>>();
  useWebuiToastError(localError ?? snapshot.error);
  useWebuiToastSuccess(notice);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () =>
      setStageSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    measure();
    return dom.observeSize(element, measure);
  }, [dom, snapshot.status]);
  useEffect(() => {
    if (rename !== undefined && !renaming.current) {
      renaming.current = true;
      renameInput.current?.focus({ preventScroll: true });
      renameInput.current?.select();
    } else if (rename === undefined) renaming.current = false;
  }, [rename]);
  useEffect(() => {
    if (standalone && document?.id) updateDesignTabDocument(document.id);
  }, [standalone, document?.id]);
  useEffect(() => {
    setViewport(document?.viewport ?? { x: 80, y: 60, k: 1 });
    setSelected([]);
    setPendingEditors(new Set());
    productGroups.current.clear();
    setEdge(undefined);
    setConnecting(undefined);
    setPreviewNodes(undefined);
    setDialog(undefined);
    setToolSelection(undefined);
    setMenu(undefined);
    setRename(undefined);
    setRenamingNode(undefined);
    link.current = undefined;
    setLinkEnd(undefined);
    return () => {
      if (wheelSave.current) clearTimeout(wheelSave.current);
    };
  }, [document?.id]);
  const act = (action: DesignAction): Promise<DesignState | undefined> => {
    // An upload or browser transform may settle after the user changed boards.
    if (owner?.getSnapshot().data?.document?.id !== document?.id)
      return Promise.resolve(undefined);
    return owner?.act(action) ?? Promise.resolve(undefined);
  };
  const placeProducts = async (
    input: DesignProductPlacement,
  ): Promise<void> => {
    const latest = owner?.getSnapshot().data?.document;
    const source = latest?.nodes.find((node) => node.id === input.sourceNodeId);
    if (!owner || !latest || latest.id !== document?.id || !source) return;
    const placement = {
      ...input,
      origin: {
        x: source.position.x + source.width + (input.tile ? 60 : 80),
        y: source.position.y + 40,
      },
    };
    productGroups.current.set(input.ids.join(","), {
      input: placement,
      sizes: "",
    });
    const result = await owner.placeProducts(placement);
    if (!result)
      throw new Error("结果已生成，但排布尚未保存，请保留此页面并重试。");
    if (owner.getSnapshot().documentId === latest.id) setSelected(input.ids);
  };
  useEffect(() => {
    if (!document || !owner) return;
    for (const group of productGroups.current.values()) {
      const sizes = group.input.ids
        .map((id) => {
          const node = document.nodes.find((item) => item.id === id);
          return `${id}:${node?.width}:${node?.height}`;
        })
        .join(";");
      if (sizes === group.sizes) continue;
      group.sizes = sizes;
      const input = { ...group.input, measured: true };
      const placed = designPlaceProducts(document, input);
      if (
        placed.nodes.some(
          (node, index) =>
            node.position.x !== document.nodes[index]!.position.x ||
            node.position.y !== document.nodes[index]!.position.y,
        )
      )
        void owner.placeProducts(input);
    }
  }, [document, owner]);
  const navigateSession = (id: string): void => {
    void (owner?.flushEdits() ?? Promise.resolve())
      .then(() => {
        if (openSession) {
          openSession(id);
          return;
        }
        const href = owner?.sessionUrl(id);
        if (href) openDesignTab(href);
        else setLocalError("当前连接无法打开运行会话。");
      })
      .catch((reason: unknown) =>
        setLocalError(
          reason instanceof Error ? reason.message : String(reason),
        ),
      );
  };
  const openPanel = (kind: DesignDialog, target: HTMLElement): void => {
    const box = target.getBoundingClientRect();
    setPanelAnchor({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    });
    setToolSelection(undefined);
    setDialog((current) => (current === kind ? undefined : kind));
  };
  const openTool = (
    nodeId: string,
    toolKey: string,
    anchor: WebuiDropdownAnchorRect,
  ): void => {
    const tool = records(data?.capabilities.tools).find(
      (item) => item.key === toolKey,
    );
    const card =
      tool?.ui === "clip"
        ? stage.current
            ?.querySelector<HTMLElement>(`[data-design-node="${nodeId}"]`)
            ?.getBoundingClientRect()
        : undefined;
    setToolSelection({
      nodeId,
      toolKey,
      anchor: card
        ? {
            left: card.left,
            top: card.top,
            width: card.width,
            height: card.height,
          }
        : anchor,
    });
    setDialog(undefined);
  };
  const saveView = (next: DesignDocument["viewport"]): void => {
    void owner?.setViewport(next);
  };
  const nodes = previewNodes ?? document?.nodes ?? [];
  const begin = (
    event: PointerEvent<HTMLElement>,
    kind: Gesture["kind"],
    nodeId?: string,
  ): void => {
    if (!document || event.button !== 0 || snapshot.busy) return;
    event.stopPropagation();
    event.preventDefault();
    const chosen = nodeId
      ? selected.includes(nodeId)
        ? selected
        : [nodeId]
      : [];
    if (nodeId) setSelected(chosen);
    const moving = document.nodes.filter((node) => chosen.includes(node.id));
    gesture.current = {
      kind,
      nodeId,
      x: event.clientX,
      y: event.clientY,
      viewport,
      nodes: moving,
    };
    stage.current?.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const drawing = link.current,
      bounds = stage.current?.getBoundingClientRect();
    if (drawing && bounds && stage.current) {
      if (
        !drawing.moved &&
        Math.hypot(event.clientX - drawing.x, event.clientY - drawing.y) < 3
      )
        return;
      link.current = { ...drawing, moved: true };
      const snap = designHitPort(
        stage.current,
        event.clientX,
        event.clientY,
        !drawing.input,
        drawing.nodeId,
      );
      setLinkEnd(
        designWorldPoint(
          (snap?.x ?? event.clientX) - bounds.left,
          (snap?.y ?? event.clientY) - bounds.top,
          viewport,
        ),
      );
      return;
    }
    const active = gesture.current;
    if (!active || !document) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    if (active.kind === "pan") {
      setViewport({
        ...active.viewport,
        x: active.viewport.x + dx,
        y: active.viewport.y + dy,
      });
      return;
    }
    if (active.kind === "band") {
      const box = stage.current?.getBoundingClientRect();
      if (!box) return;
      const rectangle = {
        left: Math.min(active.x, event.clientX) - box.left,
        top: Math.min(active.y, event.clientY) - box.top,
        right: Math.max(active.x, event.clientX) - box.left,
        bottom: Math.max(active.y, event.clientY) - box.top,
      };
      setBand(rectangle);
      setSelected(
        bandSelection({
          band: rectangle,
          viewport: active.viewport,
          nodes: document.nodes,
        }),
      );
      return;
    }
    const positions = dragPositions(
      active.nodes.map((node) => ({ id: node.id, ...node.position })),
      dx,
      dy,
      active.viewport.k,
    );
    setPreviewNodes(
      document.nodes.map((node) => {
        const origin = active.nodes.find(
          (candidate) => candidate.id === node.id,
        );
        if (!origin) return node;
        if (active.kind === "resize" && active.nodeId !== node.id) return node;
        const position = positions.find(
          (candidate) => candidate.id === node.id,
        )!;
        return active.kind === "resize"
          ? {
              ...node,
              width: Math.round(
                Math.min(
                  1200,
                  Math.max(200, origin.width + dx / active.viewport.k),
                ),
              ),
              height: Math.round(
                Math.min(
                  2000,
                  Math.max(140, origin.height + dy / active.viewport.k),
                ),
              ),
            }
          : { ...node, position: { x: position.x, y: position.y } };
      }),
    );
  };
  const finish = (event: PointerEvent<HTMLElement>): void => {
    const drawing = link.current;
    if (drawing) {
      link.current = undefined;
      setLinkEnd(undefined);
      if (stage.current?.hasPointerCapture(event.pointerId))
        stage.current.releasePointerCapture(event.pointerId);
      if (!drawing.moved || !stage.current) return;
      setConnecting(undefined);
      const root = stage.current,
        snap = designHitPort(
          root,
          event.clientX,
          event.clientY,
          !drawing.input,
          drawing.nodeId,
        ),
        body = designHitNode(root, event.clientX, event.clientY);
      const latest = owner?.getSnapshot().data?.document,
        target = latest?.nodes.find(
          (node) => node.id === (snap?.nodeId ?? body),
        );
      if (target?.id === drawing.nodeId) return;
      if (target) {
        if (drawing.input) {
          if (kindOf(target) === drawing.kind)
            void act({
              type: "connect",
              from: target.id,
              to: drawing.nodeId,
              role: drawing.role,
            });
          else setLocalError("端口的数据类型不匹配。");
        } else {
          const port = portList(
            target,
            data ? designLimits(data, target) : undefined,
          ).find(
            (entry) =>
              entry.kind === drawing.kind &&
              (!snap?.role || entry.role === snap.role),
          );
          void act({
            type: "connect",
            from: drawing.nodeId,
            to: target.id,
            ...(port?.role ? { role: port.role } : {}),
          });
        }
      } else if (drawing.input) {
        const box = root.getBoundingClientRect(),
          point = designWorldPoint(
            event.clientX - box.left,
            event.clientY - box.top,
            viewport,
          );
        void act({
          type: "add_node",
          nodeType: "input",
          kind: drawing.kind,
          title: "输入",
          x: point.x - 140,
          y: point.y - 90,
        }).then(async (created) => {
          const id = designAddedNodeId(created);
          if (id) {
            await act({
              type: "connect",
              from: id,
              to: drawing.nodeId,
              role: drawing.role,
            });
            setSelected([id]);
          }
        });
      } else
        setMenu({
          kind: "downstream",
          nodeId: drawing.nodeId,
          anchor: {
            left: event.clientX,
            top: event.clientY,
            width: 0,
            height: 0,
          },
        });
      return;
    }
    const active = gesture.current;
    gesture.current = undefined;
    if (stage.current?.hasPointerCapture(event.pointerId))
      stage.current.releasePointerCapture(event.pointerId);
    if (!active || !document) return;
    if (active.kind === "pan") saveView(viewport);
    else if (active.kind !== "band" && previewNodes) {
      const latest = owner?.getSnapshot().data?.document;
      if (latest?.id === document.id)
        void act({
          type: "save",
          document: mergeDesignGesture(
            latest,
            previewNodes,
            active.nodes.map((node) => node.id),
            active.kind === "resize" ? active.nodeId : undefined,
          ),
        }).then(() => setPreviewNodes(undefined));
    }
    setBand(undefined);
  };
  const connect = (id: string, input: boolean, role?: string): void => {
    if (!input) {
      setConnecting((current) => (current === id ? undefined : id));
      return;
    }
    if (!connecting || connecting === id) return;
    const from = connecting;
    setConnecting(undefined);
    void act({ type: "connect", from, to: id, role });
  };
  const startPort = (
    event: PointerEvent<HTMLElement>,
    nodeId: string,
    input: boolean,
    kind: DesignKind,
    role?: string,
  ): void => {
    if (event.button !== 0 || !stage.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (input && connecting && connecting !== nodeId) {
      connect(nodeId, true, role);
      return;
    }
    const box = stage.current.getBoundingClientRect(),
      port = event.currentTarget.getBoundingClientRect();
    link.current = {
      nodeId,
      input,
      kind,
      role,
      x: event.clientX,
      y: event.clientY,
      origin: designWorldPoint(
        port.left + port.width / 2 - box.left,
        port.top + port.height / 2 - box.top,
        viewport,
      ),
      moved: false,
    };
    if (!input) setConnecting(nodeId);
    stage.current.setPointerCapture(event.pointerId);
  };
  const newNodeAt = (x: number, y: number): void => {
    const point = designWorldPoint(x, y, viewport);
    void act({
      type: "add_node",
      nodeType: "image",
      title: NODE_FORMS.image.label,
      x: point.x,
      y: point.y,
    }).then((created) => {
      const id = designAddedNodeId(created);
      if (id) setSelected([id]);
    });
  };
  const removeSelection = (): void => {
    if (edge) {
      void act({ type: "disconnect", connectionId: edge });
      setEdge(undefined);
      return;
    }
    const latest = owner?.getSnapshot().data?.document;
    if (!document || latest?.id !== document.id || !selected.length) return;
    void act({
      type: "save",
      document: designRemoveSelection(latest, selected),
    }).then(() => setSelected([]));
  };
  const copy = (): void => {
    if (document) {
      clipboard.current = {
        nodes: document.nodes.filter((node) => selected.includes(node.id)),
        connections: document.connections.filter(
          (line) =>
            selected.includes(line.fromNodeId) &&
            selected.includes(line.toNodeId),
        ),
      };
      setNotice(`已复制 ${clipboard.current.nodes.length} 个节点`);
    }
  };
  const fit = (selection = false): void => {
    const box = stage.current?.getBoundingClientRect();
    const latest = owner?.getSnapshot().data?.document;
    if (!box || !latest) return;
    const next = designFitView(
      selection
        ? latest.nodes.filter((node) => selected.includes(node.id))
        : latest.nodes,
      box,
      selection ? viewport.k : undefined,
    );
    setViewport(next);
    saveView(next);
  };
  const commitRename = (): void => {
    const title = rename?.trim();
    setRename(undefined);
    const latest = owner?.getSnapshot().data?.document;
    if (latest && title && title !== latest.title)
      void act({ type: "save", document: { ...latest, title } });
  };
  const create = async (): Promise<void> => {
    const result = await act({
      type: "create",
      title: designNextTitle(data?.documents ?? []),
    });
    if (result?.document) setRename(result.document.title);
  };
  const pointAnchor = (x: number, y: number): WebuiDropdownAnchorRect => ({
    left: x,
    top: y,
    width: 0,
    height: 0,
  });
  const addKind = async (action: string): Promise<void> => {
    const entry = NODE_KINDS.find(
      (item) => action === `add:${item.type}:${item.kind ?? ""}`,
    );
    const box = stage.current?.getBoundingClientRect();
    if (!entry || !box) return;
    if (!owner?.getSnapshot().data?.document)
      await act({
        type: "create",
        title: designNextTitle(data?.documents ?? []),
      });
    const center = designWorldPoint(
      menu?.kind === "downstream" || menu?.kind === "blank"
        ? menu.anchor.left - box.left
        : box.width / 2,
      menu?.kind === "downstream" || menu?.kind === "blank"
        ? menu.anchor.top - box.top
        : box.height / 2,
      viewport,
    );
    const result = await owner?.act({
      type: "add_node",
      nodeType: entry.type,
      title: NODE_FORMS[entry.type].label,
      ...(entry.kind ? { kind: entry.kind } : {}),
      x: center.x - 140,
      y: center.y - 90,
    });
    const id = designAddedNodeId(result);
    if (typeof id === "string") {
      if (menu?.kind === "downstream" && menu.nodeId)
        await owner?.act({ type: "connect", from: menu.nodeId, to: id });
      setSelected([id]);
    }
  };
  const menuNode = document?.nodes.find((node) => node.id === menu?.nodeId);
  const kindEntries: readonly DesignMenuEntry[] = NODE_KINDS.map((item) => ({
    label: item.label,
    action: `add:${item.type}:${item.kind ?? ""}`,
    kind: item.kind,
  }));
  const menuEntries: readonly DesignMenuEntry[] =
    menu?.kind === "node" && menuNode
      ? nodeMenuEntries(menuNode, {
          selectedCount: selected.length,
          isGroup: menuNode.type === "group",
          canPaste: Boolean(clipboard.current?.nodes.length),
        }).map((entry) =>
          entry !== "-" && entry.disabled
            ? { ...entry, hint: "剪贴板是空的" }
            : entry,
        )
      : menu?.kind === "edge"
        ? [{ label: "删除连接", action: "disconnect", danger: true }]
        : menu?.kind === "downstream" && menuNode && data
          ? kindEntries.filter(
              (entry) =>
                entry !== "-" &&
                NODE_KINDS.some(
                  (kind) =>
                    entry.action === `add:${kind.type}:${kind.kind ?? ""}` &&
                    kind.role === "generate" &&
                    designDownstreamTypes(
                      kindOf(menuNode),
                      data.capabilities,
                    ).includes(
                      kind.type as "text" | "image" | "video" | "audio",
                    ),
                ),
            )
          : menu?.kind === "blank"
            ? [
                ...kindEntries,
                "-",
                { label: "重置视图", action: "reset" },
                {
                  label: "恢复草稿",
                  action: "restore-draft",
                  disabled: !data?.draft,
                  hint: data?.draft ? undefined : "当前画布没有未保存的草稿",
                },
              ]
            : kindEntries;
  const chooseMenu = async (action: string): Promise<void> => {
    setLocalError(undefined);
    setNotice(undefined);
    try {
      if (action.startsWith("add:")) {
        await addKind(action);
        return;
      }
      if (action === "reset") {
        fit();
        return;
      }
      if (action === "disconnect" && menu?.edgeId) {
        await act({ type: "disconnect", connectionId: menu.edgeId });
        return;
      }
      if (action === "restore-draft" && data?.draft) {
        await act({
          type: "restore_draft",
          draftRevision: data.draft.revision,
        });
        return;
      }
      const latest = owner?.getSnapshot().data?.document;
      const node = latest?.nodes.find((item) => item.id === menu?.nodeId);
      if (!latest || !node) return;
      if (action === "rename") setRenamingNode(node.id);
      else if (action === "copy") copy();
      else if (action === "paste") paste();
      else if (action === "cut") {
        copy();
        await act({
          type: "save",
          document: designRemoveSelection(latest, selected),
        });
        setSelected([]);
      } else if (action === "duplicate") {
        const duplicate = cloneDesignSelection(
          { nodes: [node], connections: [] },
          (kind) => `${kind === "node" ? "n" : "c"}_${crypto.randomUUID()}`,
        );
        await act({
          type: "save",
          document: { ...latest, nodes: [...latest.nodes, ...duplicate.nodes] },
        });
        setSelected(duplicate.nodes.map((item) => item.id));
      } else if (action === "group") {
        const id = `n_${crypto.randomUUID()}`;
        await act({
          type: "save",
          document: designGroupSelection(latest, selected, id),
        });
        setSelected([id]);
      } else if (action === "ungroup" || action === "delete") {
        await act({ type: "remove_node", nodeId: node.id });
        setSelected((current) => current.filter((id) => id !== node.id));
      } else if (action === "focus") fit(true);
      else if (action === "clear")
        await act({
          type: "update_node",
          nodeId: node.id,
          patch: {
            metadata: {
              output: {
                status: "idle",
                text: "",
                media: [],
                error: "",
                posterUrl: "",
                durationMs: 0,
                width: 0,
                height: 0,
                missing: false,
                updatedAt: "",
              },
            },
          },
        });
      else if (action === "copy-text") {
        await copyDesignText(node.metadata.output.text);
        setNotice("文本已复制");
      } else if (action === "copy-media" && node.metadata.output.media[0]) {
        await copyDesignImage(
          dom,
          owner?.assetUrl(node.metadata.output.media[0].url) ??
            node.metadata.output.media[0].url,
        );
        setNotice("素材已复制（PNG）");
      } else if (action === "save-local" && node.metadata.output.media[0]) {
        const media = node.metadata.output.media[0];
        await downloadDesignMedia(
          dom,
          owner?.assetUrl(media.url) ?? media.url,
          `${node.title}${/\.[A-Za-z0-9]{2,5}$/u.exec(media.url)?.[0] ?? ""}`,
        );
      }
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const paste = (): void => {
    const latest = owner?.getSnapshot().data?.document;
    if (
      !document ||
      latest?.id !== document.id ||
      !clipboard.current?.nodes.length
    )
      return;
    const { nodes: pasted, connections } = cloneDesignSelection(
      clipboard.current,
      (kind) => `${kind === "node" ? "n" : "c"}_${crypto.randomUUID()}`,
      { viewport, viewportSize: stageSize },
    );
    void act({
      type: "save",
      document: {
        ...latest,
        nodes: [...latest.nodes, ...pasted],
        connections: [...latest.connections, ...connections],
      },
    }).then((result) => {
      if (result?.document?.id === document.id)
        setSelected(pasted.map((node) => node.id));
    });
  };
  const map = designMinimap(nodes, viewport, stageSize);
  const keyboard = (event: KeyboardEvent<HTMLElement>): void => {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      !event.currentTarget.contains(event.target as Node) ||
      (event.target as HTMLElement).closest(
        "input,textarea,[contenteditable=true]",
      )
    )
      return;
    const modifier = event.ctrlKey || event.metaKey,
      key = event.key.toLowerCase();
    if (modifier && key === "z") {
      event.preventDefault();
      void (event.shiftKey ? owner?.redo() : owner?.undo());
    } else if (modifier && key === "y") {
      event.preventDefault();
      void owner?.redo();
    } else if (modifier && key === "c") {
      event.preventDefault();
      copy();
    } else if (modifier && key === "x") {
      event.preventDefault();
      copy();
      removeSelection();
    } else if (modifier && key === "v") {
      event.preventDefault();
      paste();
    } else if (modifier && key === "a") {
      event.preventDefault();
      setSelected(nodes.map((node) => node.id));
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeSelection();
    } else if (event.key === "Escape") {
      if (menu) setMenu(undefined);
      else if (toolSelection) setToolSelection(undefined);
      else if (dialog) setDialog(undefined);
      else if (connecting || link.current) {
        setConnecting(undefined);
        link.current = undefined;
        setLinkEnd(undefined);
      } else {
        setSelected([]);
        setEdge(undefined);
      }
    } else if (
      event.key.startsWith("Arrow") &&
      document &&
      selected.length &&
      !(event.target as HTMLElement).closest("a,[role=link],button")
    ) {
      event.preventDefault();
      const distance = event.shiftKey ? 40 : 10;
      const latest = owner?.getSnapshot().data?.document;
      if (latest?.id === document.id)
        void act({
          type: "save",
          document: {
            ...latest,
            nodes: latest.nodes.map((node) =>
              selected.includes(node.id)
                ? {
                    ...node,
                    position: {
                      x:
                        node.position.x +
                        (event.key === "ArrowRight"
                          ? distance
                          : event.key === "ArrowLeft"
                            ? -distance
                            : 0),
                      y:
                        node.position.y +
                        (event.key === "ArrowDown"
                          ? distance
                          : event.key === "ArrowUp"
                            ? -distance
                            : 0),
                    },
                  }
                : node,
            ),
          },
        });
    }
  };
  return (
    <WebuiPage
      as="main"
      kind={standalone ? "content" : "panel"}
      className={`webui-design ${standalone ? "webui-design-standalone" : "webui-design-panel"}`}
      loading={snapshot.status === "loading" && !data}
      data-testid="design-surface"
      data-design-document={document?.id}
      onKeyDown={keyboard}
    >
      <header className="webui-design-toolbar">
        <div className="webui-design-toolbar-primary">
          <div className="webui-design-brand">
            <IconHierarchy size={19} />
            <strong>Design</strong>
          </div>
          {rename !== undefined ? (
            <WebuiTextInput
              ref={renameInput}
              aria-label="画布名称"
              value={rename}
              maxLength={120}
              className="webui-design-rename"
              onChange={(event) => setRename(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setRename(undefined);
                }
              }}
            />
          ) : (
            <div className="webui-design-board-picker">
              <WebuiSelectMenu
                id="design-board-select"
                labelId="design-board-label"
                aria-label="选择画布"
                options={(data?.documents ?? []).map((item) => ({
                  value: item.id,
                  label: `${item.title}（${item.id === document?.id ? document.nodes.length : item.nodeCount} 节点）`,
                }))}
                value={document?.id ?? ""}
                onChange={(id) => {
                  void owner?.load({ documentId: id, sessionId });
                }}
                className="webui-design-board-select"
              />
            </div>
          )}
          <span className="webui-design-save-state">
            {snapshot.error
              ? "操作未完成"
              : pendingEditors.size > 0
                ? "编辑待保存"
                : snapshot.activity === "content"
                  ? "保存中…"
                  : snapshot.activity === "view"
                    ? "保存视图…"
                    : snapshot.activity === "operation"
                      ? "处理中…"
                      : document
                        ? "已保存"
                        : ""}
          </span>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            aria-label="新建画布"
            onClick={create}
          >
            新建
          </WebuiButton>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            aria-label="重命名画布"
            disabled={!document}
            onClick={() => setRename(document?.title)}
          >
            重命名
          </WebuiButton>
          <span className="webui-design-toolbar-separator" aria-hidden="true" />
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            data-overlay-layer="webui-design-global-panel"
            aria-expanded={dialog === "templates"}
            onClick={(event) => openPanel("templates", event.currentTarget)}
          >
            模板
          </WebuiButton>
          <WebuiButton
            variant="danger"
            size="inline-dense"
            aria-label="删除画布"
            disabled={!document}
            onClick={() => setDialog("delete")}
          >
            删除
          </WebuiButton>
        </div>
        <div className="webui-design-toolbar-secondary">
          <span
            className="webui-design-build"
            title={
              snapshot.versionError ??
              `WebUI 原生 Design · 协议 ${snapshot.runtimeVersion?.protocolVersion ?? "—"}`
            }
          >
            {snapshot.runtimeVersion
              ? `v${snapshot.runtimeVersion.version}`
              : "Native"}
          </span>
          <span className="webui-design-zoom">
            {Math.round(viewport.k * 100)}%
          </span>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            title={snapshot.historyResetReason ?? "撤销 (Ctrl+Z)"}
            disabled={!snapshot.canUndo || snapshot.busy}
            onClick={() => owner?.undo()}
          >
            撤销
          </WebuiButton>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            title={
              snapshot.historyResetReason ?? "重做 (Ctrl+Shift+Z / Ctrl+Y)"
            }
            disabled={!snapshot.canRedo || snapshot.busy}
            onClick={() => owner?.redo()}
          >
            重做
          </WebuiButton>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            data-overlay-layer="webui-design-global-panel"
            aria-expanded={dialog === "capabilities"}
            onClick={(event) => openPanel("capabilities", event.currentTarget)}
          >
            能力清单
          </WebuiButton>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            data-overlay-layer="webui-design-global-panel"
            aria-expanded={dialog === "tools"}
            onClick={(event) => openPanel("tools", event.currentTarget)}
          >
            工具
          </WebuiButton>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            data-overlay-layer="webui-design-global-panel"
            aria-expanded={dialog === "library"}
            onClick={(event) => openPanel("library", event.currentTarget)}
          >
            资产库
          </WebuiButton>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            aria-pressed={minimap}
            onClick={() => setMinimap(!minimap)}
          >
            {minimap ? "小地图：开" : "小地图"}
          </WebuiButton>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            onClick={() =>
              document
                ? act({
                    type: "save",
                    document: {
                      ...document,
                      backgroundMode:
                        document.backgroundMode === "lines" ? "dots" : "lines",
                    },
                  }).then(() => undefined)
                : undefined
            }
          >
            网格：{document?.backgroundMode === "dots" ? "圆点" : "线条"}
          </WebuiButton>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            onClick={appearance.cycle}
          >
            主题：
            {
              { system: "跟随系统", light: "亮色", dark: "暗色" }[
                appearance.preference
              ]
            }
          </WebuiButton>
          <WebuiButton
            variant="outline-secondary"
            size="inline-dense"
            onClick={() => fit()}
          >
            重置视图
          </WebuiButton>
          {!standalone ? (
            <WebuiButton
              variant="outline-secondary"
              size="inline-dense"
              aria-label="在新标签页打开 Design"
              onClick={() => {
                const url = owner?.standaloneUrl({
                  sessionId,
                  documentId: document?.id,
                });
                if (url) openDesignTab(url);
                else setLocalError("当前连接无法打开独立 Design 页面。");
              }}
            >
              独立窗口
            </WebuiButton>
          ) : null}
          <WebuiButton
            variant="primary"
            size="inline-dense"
            data-overlay-layer="webui-design-context-menu"
            aria-expanded={menu?.kind === "add"}
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setMenu((current) =>
                current?.kind === "add"
                  ? undefined
                  : {
                      kind: "add",
                      anchor: pointAnchor(box.left, box.bottom + 6),
                    },
              );
            }}
          >
            <IconPlus size={16} />
            添加节点
          </WebuiButton>
        </div>
      </header>
      {data?.draft ? (
        <FeedbackLiveRegion className="webui-design-draft-notice">
          <span>这张画布有一份未提交的草稿。</span>
          <WebuiButton
            variant="plain"
            size="inline-tiny"
            onClick={() =>
              act({
                type: "restore_draft",
                draftRevision: data.draft!.revision,
              }).then(() => undefined)
            }
          >
            恢复草稿
          </WebuiButton>
          <WebuiButton
            variant="plain"
            size="inline-tiny"
            onClick={() =>
              act({
                type: "remove_draft",
                draftRevision: data.draft!.revision,
              }).then(() => undefined)
            }
          >
            丢弃草稿
          </WebuiButton>
        </FeedbackLiveRegion>
      ) : null}
      {snapshot.status === "unavailable" ? (
        <FeedbackEmpty
          title="当前运行时未提供 Design"
          description="请使用支持原生 Design 的 WebUI 服务。"
        />
      ) : (
        <div
          ref={stage}
          className="webui-design-viewport"
          tabIndex={0}
          aria-label="Design 节点画布"
          data-testid="design-viewport"
          data-grid={document?.backgroundMode ?? "lines"}
          style={{
            backgroundSize: `${48 * viewport.k}px ${48 * viewport.k}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          }}
          onPointerDown={(event) => {
            if (
              !event.currentTarget.contains(event.target as Node) ||
              (event.target as HTMLElement).closest(
                "[data-design-node],a,[role=link],button,input,textarea,select,[contenteditable=true]",
              )
            )
              return;
            setSelected([]);
            setEdge(undefined);
            begin(event, event.shiftKey ? "band" : "pan");
          }}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={() => {
            gesture.current = undefined;
            link.current = undefined;
            setLinkEnd(undefined);
            setConnecting(undefined);
            setPreviewNodes(undefined);
            setBand(undefined);
          }}
          onDoubleClick={(event) => {
            if (
              !event.currentTarget.contains(event.target as Node) ||
              (event.target as HTMLElement).closest(
                "[data-design-node],a,[role=link],button,input,textarea,select,[contenteditable=true]",
              )
            )
              return;
            const box = event.currentTarget.getBoundingClientRect();
            if (document)
              newNodeAt(event.clientX - box.left, event.clientY - box.top);
          }}
          onContextMenu={(event) => {
            if (!event.currentTarget.contains(event.target as Node)) return;
            event.preventDefault();
            event.stopPropagation();
            const target = event.target as Element;
            const nodeId =
              target.closest<HTMLElement>("[data-design-node]")?.dataset
                .designNode;
            const edgeId =
              target.closest<SVGPathElement>("[data-design-edge]")?.dataset
                .designEdge;
            if (nodeId) {
              if (!selected.includes(nodeId)) setSelected([nodeId]);
              setMenu({
                kind: "node",
                nodeId,
                anchor: pointAnchor(event.clientX, event.clientY),
              });
            } else if (edgeId)
              setMenu({
                kind: "edge",
                edgeId,
                anchor: pointAnchor(event.clientX, event.clientY),
              });
            else
              setMenu({
                kind: "blank",
                anchor: pointAnchor(event.clientX, event.clientY),
              });
          }}
          onWheel={(event) => {
            if (
              !event.currentTarget.contains(event.target as Node) ||
              (event.target as HTMLElement).closest("[data-design-node]")
            )
              return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            const next = designZoom(viewport, event.deltaY, {
              x: event.clientX - box.left,
              y: event.clientY - box.top,
            });
            setViewport(next);
            if (wheelSave.current) clearTimeout(wheelSave.current);
            wheelSave.current = setTimeout(() => saveView(next), 300);
          }}
        >
          {!document?.nodes.length ? (
            <div className="webui-design-empty">
              <small>
                双击空白处新建图片节点 · Shift+拖拽框选 · 拖节点右侧圆点连线 ·
                连线即数据流
              </small>
            </div>
          ) : null}
          <div
            className="webui-design-world"
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
            }}
          >
            <svg
              className="webui-design-edges"
              width="200000"
              height="200000"
              aria-label="节点连线"
            >
              {document?.connections.map((line) => {
                const from = nodes.find((node) => node.id === line.fromNodeId);
                const to = nodes.find((node) => node.id === line.toNodeId);
                if (!from || !to || !data) return null;
                const portIndex = Math.max(
                  0,
                  portList(to, designLimits(data, to)).findIndex(
                    (port) =>
                      port.kind === kindOf(from) &&
                      (line.role ?? "") === (port.role ?? ""),
                  ),
                );
                const path = designEdgePath(
                    from,
                    to,
                    portIndex,
                    portList(to, designLimits(data, to)).length,
                  ),
                  related =
                    designRelatedToSelection(document, selected, from.id) &&
                    designRelatedToSelection(document, selected, to.id);
                return (
                  <g key={line.id} data-dimmed={related ? undefined : "true"}>
                    <path
                      className="webui-design-edge-hit"
                      d={path}
                      data-design-edge={line.id}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        setEdge(line.id);
                        setSelected([]);
                        stage.current?.focus({ preventScroll: true });
                      }}
                    />
                    <path
                      className="webui-design-edge-visible"
                      d={path}
                      data-kind={kindOf(from)}
                      data-selected={
                        edge === line.id ||
                        selected.includes(from.id) ||
                        selected.includes(to.id)
                          ? "true"
                          : "false"
                      }
                    />
                  </g>
                );
              })}
              {link.current && linkEnd ? (
                <path
                  className="webui-design-draft-edge"
                  data-kind={link.current.kind}
                  d={`M ${link.current.origin.x} ${link.current.origin.y} C ${link.current.origin.x + (link.current.input ? -80 : 80)} ${link.current.origin.y}, ${linkEnd.x + (link.current.input ? 80 : -80)} ${linkEnd.y}, ${linkEnd.x} ${linkEnd.y}`}
                />
              ) : null}
            </svg>
            {data && document
              ? nodes.map((node) => (
                  <DesignNodeCard
                    key={node.id}
                    node={node}
                    document={document}
                    data={data}
                    selected={selected.includes(node.id)}
                    related={designRelatedToSelection(
                      document,
                      selected,
                      node.id,
                    )}
                    busy={snapshot.busy}
                    connecting={connecting}
                    zoom={viewport.k}
                    renaming={renamingNode === node.id}
                    onRenameEnd={() => setRenamingNode(undefined)}
                    registerPendingEdit={owner?.registerPendingEdit}
                    onPendingChange={reportPending}
                    onProducts={placeProducts}
                    onFitMedia={(input) =>
                      owner?.getSnapshot().documentId === document.id
                        ? owner.fitMedia(input)
                        : Promise.resolve(undefined)
                    }
                    getDocument={() => owner?.getSnapshot().data?.document}
                    onMenu={(nodeId, anchor) =>
                      setMenu({ kind: "node", nodeId, anchor })
                    }
                    onSelect={(id, additive) => {
                      setEdge(undefined);
                      setSelected((current) =>
                        additive
                          ? current.includes(id)
                            ? current.filter((value) => value !== id)
                            : [...current, id]
                          : current.includes(id)
                            ? current
                            : [id],
                      );
                    }}
                    onGesture={begin}
                    onConnect={connect}
                    onPortStart={startPort}
                    onAction={act}
                    onTool={(_media, toolKey, nodeId, anchor) => {
                      if (toolKey && nodeId && anchor)
                        openTool(nodeId, toolKey, anchor);
                    }}
                    assetUrl={owner?.assetUrl ?? ((value) => value)}
                    openSession={navigateSession}
                  />
                ))
              : null}
          </div>
          {band ? (
            <div
              className="webui-design-band"
              style={{
                left: band.left,
                top: band.top,
                width: band.right - band.left,
                height: band.bottom - band.top,
              }}
            />
          ) : null}
          {connecting ? (
            <div className="webui-design-connection-hint">
              <IconHierarchy size={16} />
              选择目标节点的输入端口，Esc 取消
            </div>
          ) : null}
          {minimap ? (
            <svg
              className="webui-design-minimap"
              viewBox={`${map.x} ${map.y} ${map.width} ${map.height}`}
              aria-label="画布小地图"
              data-canvas-no-zoom="true"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                const point = designSvgPoint(
                  event.currentTarget,
                  event.clientX,
                  event.clientY,
                );
                if (point) {
                  const next = designCenterView(point, viewport, stageSize);
                  setViewport(next);
                  saveView(next);
                }
              }}
            >
              {nodes.map((node) => (
                <rect
                  key={node.id}
                  x={node.position.x}
                  y={node.position.y}
                  width={node.width}
                  height={node.height}
                  rx={12}
                  data-kind={kindOf(node)}
                />
              ))}
              <rect
                className="webui-design-minimap-view"
                data-design-minimap-viewport="true"
                x={map.view.x}
                y={map.view.y}
                width={map.view.width}
                height={map.view.height}
              />
            </svg>
          ) : null}
          <FeedbackLiveRegion className="sr-only">
            {snapshot.busy ? "正在保存画布" : document ? "画布已保存" : ""}
          </FeedbackLiveRegion>
        </div>
      )}
      {data ? (
        <DesignDialogs
          viewport={viewport}
          onInserted={(id) => setSelected([id])}
          kind={dialog}
          anchor={panelAnchor}
          data={data}
          document={document}
          selectedNodeId={selected[0]}
          viewportSize={() => ({
            width: stage.current?.clientWidth ?? 800,
            height: stage.current?.clientHeight ?? 600,
          })}
          onTool={openTool}
          onClose={() => setDialog(undefined)}
          onAction={act}
          assetUrl={owner?.assetUrl ?? ((value) => value)}
        />
      ) : null}
      {data ? (
        <DesignToolPanel
          onProducts={placeProducts}
          selection={toolSelection}
          data={data}
          document={document}
          mediaElement={
            toolSelection
              ? stage.current?.querySelector<HTMLMediaElement>(
                  `[data-design-media-engine="${toolSelection.nodeId}"]`,
                )
              : undefined
          }
          onClose={() => setToolSelection(undefined)}
          onAction={act}
          assetUrl={owner?.assetUrl ?? ((value) => value)}
        />
      ) : null}
      {data ? (
        <DesignTaskPanel
          data={data}
          document={document}
          onAction={act}
          openSession={navigateSession}
        />
      ) : null}
      <DesignMenu
        layerId="webui-design-context-menu"
        open={Boolean(menu)}
        anchor={menu?.anchor ?? { left: 0, top: 0, width: 0, height: 0 }}
        entries={menuEntries}
        label={menu?.kind === "add" ? "添加节点" : "画布菜单"}
        onClose={() => {
          setMenu(undefined);
          stage.current?.focus({ preventScroll: true });
        }}
        onChoose={(action) => {
          void chooseMenu(action);
        }}
      />
    </WebuiPage>
  );
}
