// Whether an HTML document reaches outside its own directory.
//
// Carved out of `components/workspace/WorkspaceHtmlPreview.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **6 declarations**, 3 functions, 3 types and constants they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

// `src`/`href`/`poster` values, `srcset` candidate lists, and `url()` in
// inline CSS. All read-only: the document is never rewritten, only reported
// on. `srcset` is scanned separately because it is the one attribute whose
// value is a comma-separated list — splitting `data:` URLs on their comma
// would report a false positive on a fully absolute reference.
const ASSET_ATTRIBUTE_PATTERN = /(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;

const SRCSET_PATTERN = /srcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;

const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/giu;

/**
 * Whether a reference is resolved against the frame's base URL.
 *
 * That base is the `/workspace-file` route, so both `logo.png` and
 * `/logo.png` miss: the document's own directory is not on the URL at all.
 * A scheme (`https:`, `data:`, `blob:`, `mailto:`) and a same-document
 * fragment are the two cases that still resolve to something intended.
 */
function isRelativeReference(value: string): boolean {
  const reference = value.trim();
  if (!reference || reference.startsWith("#")) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(reference)) return false;
  if (reference.startsWith("//")) return false;
  return true;
}

function firstCapture(match: RegExpMatchArray): string {
  return match[1] ?? match[2] ?? match[3] ?? "";
}

/**
 * Whether a document's own text shows a relative asset reference.
 *
 * Best-effort by construction: it is a report on the source, not a proof
 * about the rendered frame — an unread file, a reference built at runtime, or
 * a `<base href>` that redirects resolution are all invisible here. That is
 * exactly why the note stays visible when this returns `false`.
 */
export function hasRelativeDocumentReference(source: string): boolean {
  for (const match of source.matchAll(SRCSET_PATTERN)) {
    // Each `srcset` candidate is a URL followed by a descriptor.
    for (const candidate of firstCapture(match).split(",")) {
      if (isRelativeReference(candidate.trim().split(/\s+/u)[0] ?? "")) return true;
    }
  }
  for (const match of source.matchAll(ASSET_ATTRIBUTE_PATTERN)) {
    if (isRelativeReference(firstCapture(match))) return true;
  }
  for (const match of source.matchAll(CSS_URL_PATTERN)) {
    if (isRelativeReference(firstCapture(match))) return true;
  }
  return false;
}
