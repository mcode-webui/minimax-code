export interface WebuiMessageFileReference {
  readonly path: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

/** Local file references retain explicit absolute paths outside the workspace. */
export function parseWebuiMessageFileReference(value: string, workspaceDir?: string): WebuiMessageFileReference | undefined {
  let normalized = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (/%[\da-f]{2}/iu.test(normalized)) {
    try { normalized = decodeURIComponent(normalized); } catch { return undefined; }
  }
  if (!normalized || /^(?:https?:|mailto:|\/\/)/iu.test(normalized)) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  if (normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized)) {
    const base = workspaceDir?.replace(/\\/gu, "/").replace(/\/$/u, "");
    const candidate = /^[a-z]:/iu.test(normalized) ? normalized.toLowerCase() : normalized;
    const root = base && /^[a-z]:/iu.test(base) ? base.toLowerCase() : base;
    if (base && candidate.startsWith(`${root}/`)) normalized = normalized.slice(base.length + 1);
  }
  const match = normalized.match(/^((?:[a-z]:\/)?[^:]+?)(?::(\d+)(?:-(\d+))?)?$/iu);
  if (!match) return undefined;
  const path = match[1];
  if (!path || (!path.includes("/") && !/\.[a-z\d_-]+$/iu.test(path))) return undefined;
  const segments = path.replace(/^(?:[a-z]:)?\//iu, "").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  // Paths come from generated files and user workspaces. Filenames
  // may contain spaces or non-ASCII characters, so validate by path segment
  // instead of rejecting everything outside ASCII `\w`.
  if (segments.some((segment) => !/^[\p{L}\p{N}_@.+ ()\[\]-]+$/u.test(segment))) return undefined;
  const lineStart = match[2] ? Number(match[2]) : undefined;
  const lineEnd = match[3] ? Number(match[3]) : undefined;
  if (lineStart !== undefined && (!Number.isSafeInteger(lineStart) || lineStart < 1)) return undefined;
  if (lineEnd !== undefined && (!Number.isSafeInteger(lineEnd) || lineEnd < (lineStart ?? 1))) return undefined;
  return { path, ...(lineStart !== undefined ? { lineStart } : {}), ...(lineEnd !== undefined ? { lineEnd } : {}) };
}
