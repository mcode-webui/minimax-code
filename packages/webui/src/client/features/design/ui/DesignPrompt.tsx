import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import type {
  DesignDocument,
  DesignKind,
  DesignNode,
  DesignNodeMetadata,
  DesignState,
} from "../../../../shared/contracts/design.js";
import { kindOf, modeOf } from "../../../../shared/design/forms.mjs";
import { mentionCandidates } from "../../../../shared/design/tools.mjs";
import { WebuiDropdown } from "../../../ui/Dropdown.js";
import { WebuiButton } from "../../../ui/button.js";
import {
  designPromptPatch,
  designPromptSegments,
} from "../projection/design-view.js";
import type { DesignOwner } from "../application/design-owner.js";
import {
  designEditorCaret,
  focusDesignCaret,
  renderDesignSegments,
} from "../bindings/design-prompt.js";
import { detectMention, parseSegments } from "../bindings/mention.mjs";

export function DesignPrompt({
  node,
  document,
  assetUrl,
  onSave,
  registerPendingEdit,
  onPendingChange,
  inherited,
}: {
  readonly node: DesignNode;
  readonly document: DesignDocument;
  readonly assetUrl: (url: string) => string;
  readonly onSave: (
    segments: DesignNodeMetadata["segments"],
  ) => Promise<DesignState | undefined>;
  readonly registerPendingEdit?: DesignOwner["registerPendingEdit"];
  readonly onPendingChange?: (pending: boolean) => void;
  readonly inherited?: { readonly text: string; readonly title: string };
}): ReactElement {
  const editor = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const changed = useRef(false);
  const draft = useRef(node.metadata.segments);
  const pending = useRef(false),
    live = useRef(true),
    baseNode = useRef(node);
  const latest = useRef({ onSave, document, assetUrl, onPendingChange });
  latest.current = { onSave, document, assetUrl, onPendingChange };
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const layer = useId();
  const candidates = mentionCandidates(document, node).filter(
    (item) =>
      query !== null && item.title.toLowerCase().includes(query.toLowerCase()),
  );
  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    if (!changed.current) return live.current;
    const segments = editor.current
      ? parseSegments(editor.current)
      : draft.current;
    draft.current = segments;
    changed.current = false;
    const result = await latest.current.onSave(segments);
    if (result) {
      const committed = result.document?.nodes.find(
        (item) => item.id === node.id,
      );
      if (committed) baseNode.current = committed;
      live.current = Boolean(committed);
      if (draft.current === segments) {
        pending.current = false;
        latest.current.onPendingChange?.(false);
      }
    } else {
      live.current = false;
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
          pending.current
            ? {
                nodeId: node.id,
                baseNode: baseNode.current,
                patch: { metadata: designPromptPatch(draft.current) },
              }
            : undefined,
        (edit) => {
          if (edit.patch.metadata?.segments === draft.current) {
            pending.current = false;
            latest.current.onPendingChange?.(false);
          }
        },
      ),
    [registerPendingEdit, node.id],
  );
  useEffect(() => {
    if (
      !editor.current ||
      changed.current ||
      editor.current === editor.current.ownerDocument.activeElement
    )
      return;
    renderDesignSegments(
      editor.current,
      node.metadata.segments.length
        ? node.metadata.segments
        : designPromptSegments(node.metadata.prompt),
      document,
      assetUrl,
    );
  }, [
    node.id,
    node.metadata.prompt,
    node.metadata.segments,
    document,
    assetUrl,
  ]);
  useEffect(
    () => () => {
      void flush();
    },
    [],
  );
  const input = () => {
    if (!editor.current || composing.current) return;
    changed.current = true;
    if (!pending.current) baseNode.current = node;
    pending.current = true;
    latest.current.onPendingChange?.(true);
    draft.current = parseSegments(editor.current);
    setQuery(detectMention(draft.current, designEditorCaret(editor.current)));
    setActive(0);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void flush();
    }, 350);
  };
  const insert = (candidate: {
    readonly id: string;
    readonly kind: DesignKind;
  }) => {
    const element = editor.current;
    if (!element) return;
    const segments = parseSegments(element);
    const caret = designEditorCaret(element);
    const start = Math.max(0, caret - (query === null ? 0 : query.length + 1));
    const next: DesignNodeMetadata["segments"][number][] = [];
    let consumed = 0;
    let inserted = false;
    for (const part of segments) {
      const length = part.type === "text" ? part.text.length : 1;
      if (!inserted && start <= consumed + length && part.type === "text") {
        const before = part.text.slice(0, Math.max(0, start - consumed));
        const after = part.text.slice(Math.max(0, caret - consumed));
        if (before) next.push({ type: "text", text: before });
        next.push({
          type: "mention",
          nodeId: candidate.id,
          kind: candidate.kind,
        });
        if (after) next.push({ type: "text", text: after });
        inserted = true;
      } else next.push(part);
      consumed += length;
    }
    if (!inserted)
      next.push({
        type: "mention",
        nodeId: candidate.id,
        kind: candidate.kind,
      });
    renderDesignSegments(
      element,
      next,
      latest.current.document,
      latest.current.assetUrl,
    );
    focusDesignCaret(element, start + 1);
    draft.current = next;
    if (!pending.current) baseNode.current = node;
    pending.current = true;
    latest.current.onPendingChange?.(true);
    changed.current = true;
    setQuery(null);
    void flush();
  };
  const placeholder =
    modeOf(node) === "prompt"
      ? "一句话说明你想要什么，例如：一只猫在窗边打盹"
      : node.type === "input"
        ? "写要送进去的内容"
        : `描述要生成的${kindOf(node) === "image" ? "图片" : kindOf(node) === "video" ? "视频" : kindOf(node) === "audio" ? "音频" : "文本"}内容，输入 @ 引用上游素材`;
  if (inherited)
    return (
      <div className="webui-design-inherited" data-canvas-no-zoom="true">
        <span>来自上游：{inherited.title}</span>
        <div role="textbox" aria-label="提示词 · 来自上游" aria-readonly="true">
          {inherited.text}
        </div>
        {node.metadata.prompt.trim() ? (
          <small>你自己写的提示词还留着：断开这条线就能继续改。</small>
        ) : null}
      </div>
    );
  return (
    <div
      className="webui-design-composer"
      data-overlay-layer={layer}
      data-canvas-no-zoom="true"
    >
      <div
        ref={editor}
        className="webui-design-prompt"
        role="textbox"
        aria-label={node.type === "input" ? "输入文本" : "提示词"}
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-design-prompt={node.id}
        data-placeholder={placeholder}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          input();
        }}
        onInput={input}
        onBlur={() => {
          void flush();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (query !== null && candidates.length) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActive(
                (current) =>
                  (current +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    candidates.length) %
                  candidates.length,
              );
            } else if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              if (candidates[active]) insert(candidates[active]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setQuery(null);
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            editor.current?.blur();
          }
        }}
      />
      <small className="webui-design-muted">输入 @ 可引用上游节点的产物</small>
      <WebuiDropdown
        managed
        open={query !== null && candidates.length > 0}
        onOpen={() => undefined}
        onClose={() => setQuery(null)}
        managedLayerId={layer}
        anchorElementRef={editor}
        role="listbox"
        ariaLabel="引用素材"
        side="bottom"
        collision="flip"
        className="webui-design-mention-menu"
      >
        {candidates.map((candidate, index) => (
          <WebuiButton
            key={candidate.id}
            variant="plain"
            size="inline-dense"
            role="option"
            aria-selected={active === index}
            className="webui-design-mention-option"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insert(candidate)}
          >
            {candidate.url && candidate.kind === "image" ? (
              <img src={assetUrl(candidate.url)} alt="" />
            ) : (
              <span aria-hidden="true">
                {candidate.kind === "audio" ? "♪" : "◇"}
              </span>
            )}
            <span>{candidate.title}</span>
            {candidate.upstream ? <small>上游</small> : null}
          </WebuiButton>
        ))}
      </WebuiDropdown>
    </div>
  );
}
