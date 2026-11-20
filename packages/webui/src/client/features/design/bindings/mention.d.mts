import type { DesignNodeMetadata } from "../../../../shared/contracts/design.js";
export function textIndexBefore(
  root: HTMLElement,
  startContainer: Node,
  startOffset: number,
): number;
export function parseSegments(
  editor: HTMLElement,
): DesignNodeMetadata["segments"];
export function plainText(segments: DesignNodeMetadata["segments"]): string;
export const MENTION_PLACEHOLDER: string;
export function caretText(segments: DesignNodeMetadata["segments"]): string;
export function detectMention(
  segments: DesignNodeMetadata["segments"],
  caretIndex: number,
): string | null;
