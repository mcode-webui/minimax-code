import type {
  DesignDocument,
  DesignNodeMetadata,
} from "../../../../shared/contracts/design.js";
import { parseSegments, textIndexBefore } from "./mention.mjs";

export function designEditorCaret(editor: HTMLElement): number {
  const selection = editor.ownerDocument.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode))
    return parseSegments(editor).reduce(
      (sum, part) => sum + (part.type === "text" ? part.text.length : 1),
      0,
    );
  const range = selection.getRangeAt(0);
  return textIndexBefore(editor, range.startContainer, range.startOffset);
}

export function renderDesignSegments(
  editor: HTMLElement,
  segments: DesignNodeMetadata["segments"],
  document: DesignDocument,
  assetUrl: (url: string) => string,
): void {
  const dom = editor.ownerDocument;
  editor.replaceChildren(
    ...segments.map((part) => {
      if (part.type === "text") return dom.createTextNode(part.text);
      const source = document.nodes.find((node) => node.id === part.nodeId);
      const media = source?.metadata.output.media[0];
      const chip = dom.createElement("span");
      chip.className = "webui-design-mention";
      chip.contentEditable = "false";
      chip.dataset.mentionNodeId = part.nodeId;
      chip.dataset.mentionKind = part.kind;
      chip.dataset.designMention = `[[cw:${part.kind}:${part.nodeId}]]`;
      if (!media) {
        chip.dataset.orphan = "true";
        chip.title = "素材已不在画布里，生成时会忽略它";
      }
      if (media && (part.kind === "image" || part.kind === "video")) {
        const thumb = dom.createElement(
          part.kind === "video" ? "video" : "img",
        );
        thumb.className = "webui-design-mention-thumb";
        thumb.src = assetUrl(media.url);
        if (thumb instanceof HTMLImageElement) {
          thumb.alt = "";
          thumb.draggable = false;
        } else {
          thumb.muted = true;
          thumb.preload = "metadata";
        }
        chip.appendChild(thumb);
      } else {
        const mark = dom.createElement("span");
        mark.textContent = part.kind === "audio" ? "♪" : "·";
        chip.appendChild(mark);
      }
      chip.appendChild(dom.createTextNode(source?.title ?? "（素材已删除）"));
      return chip;
    }),
  );
}

export function focusDesignCaret(editor: HTMLElement, offset: number): void {
  const dom = editor.ownerDocument;
  const range = dom.createRange();
  let remaining = Math.max(0, offset);
  let placed = false;
  for (const node of editor.childNodes) {
    const length = node.nodeType === 3 ? (node.textContent?.length ?? 0) : 1;
    if (remaining <= length) {
      if (node.nodeType === 3) range.setStart(node, remaining);
      else if (remaining === 0) range.setStartBefore(node);
      else range.setStartAfter(node);
      placed = true;
      break;
    }
    remaining -= length;
  }
  if (!placed) {
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  range.collapse(true);
  const selection = dom.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  editor.focus({ preventScroll: true });
}
