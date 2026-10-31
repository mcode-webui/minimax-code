// Whether a preview's content is media rather than text.
//
// Carved out of `components/workspace/WorkspaceMediaPreview.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **4 declarations**, 2 functions, 2 types and constants they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

import type { WebuiWorkspaceFileContent } from "../../../../shared/contracts/workspace.js";

/**
 * Extension fallbacks for the read results that carry no `mimeType` (the text
 * reads). Same lists `isMediaContent` has always gated on, split per kind so
 * the dispatcher can tell them apart; the mime, when the runtime supplies one,
 * wins over these.
 */
const MEDIA_EXTENSIONS = [
  ["image", /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/iu],
  ["video", /\.(mp4|webm|ogv|mov)$/iu],
  ["audio", /\.(mp3|wav|ogg|m4a|aac|flac)$/iu],
] as const;

type MediaKind = (typeof MEDIA_EXTENSIONS)[number][0];

/**
 * Which media preview a read result belongs to, from the runtime's `mimeType`
 * where there is one and from the extension otherwise.
 *
 * A present mime is authoritative in both directions: a `mimeType` outside
 * the three media families yields no kind rather than falling back to the
 * extension, which is the same refusal `isMediaContent` makes — the caller has
 * already decided this file is media, and re-deriving a kind from the
 * extension would let a non-media mime render as a player.
 */
export function mediaKind(content: Pick<WebuiWorkspaceFileContent, "mimeType">, path: string): MediaKind | undefined {
  const mimeType = content.mimeType?.toLowerCase();
  if (mimeType) {
    const kind = mimeType.slice(0, mimeType.indexOf("/"));
    if (kind === "image" || kind === "video" || kind === "audio") return kind;
    return undefined;
  }
  for (const [kind, pattern] of MEDIA_EXTENSIONS) {
    if (pattern.test(path)) return kind;
  }
  return undefined;
}

/**
 * Whether a read result is media this component should render at all.
 *
 * The file URL is derivable for *any* path, so the container cannot gate on
 * "a URL exists" — that would point an `<img>` at an executable and render a
 * broken image. The decision belongs to the runtime's `mimeType` where there
 * is one, and falls back to the extension for the text results that carry no
 * mime, so the same check holds on both sides of the read.
 */
export function isMediaContent(content: Pick<WebuiWorkspaceFileContent, "mimeType">, path: string): boolean {
  return mediaKind(content, path) !== undefined;
}
