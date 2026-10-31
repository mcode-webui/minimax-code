// The header-row projection: a row stream's "kept" headers, "removed" headers,
// and any error the projection rule trips on.
//
// The badge rule, the reset-after wording, and the row shape the settings
// "用量与模型" page reads live on the publication marker
// `./usage-settings.public.ts`, because the settings business renders those
// rules without owning them. This module keeps the heading projection: a row
// stream goes in, a `ProviderHeadersProjection` comes out, and no other
// business needs to read it.

import type { ProviderHeaderDraft } from "../contracts/provider-editor.js";

export interface ProviderHeadersProjection {
  readonly headers?: Readonly<Record<string, string>>;
  readonly removeHeaders?: readonly string[];
  readonly error?: "duplicate-name" | "missing-value";
}

/** Keep saved header values unless their row is renamed or removed. */
export function projectProviderHeaders(
  rows: readonly ProviderHeaderDraft[],
  originalNames: readonly string[],
): ProviderHeadersProjection {
  const names = rows.map((row) => row.name.trim()).filter(Boolean);
  const normalized = names.map((name) => name.toLowerCase());
  if (new Set(normalized).size !== normalized.length) return { error: "duplicate-name" };
  if (rows.some((row) => row.name.trim() && !row.value.trim() && (!row.persistedName || row.name.trim().toLowerCase() !== row.persistedName.toLowerCase()))) {
    return { error: "missing-value" };
  }

  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (name && value) headers[name] = value;
  }
  const keptNames = new Set(rows.map((row) => row.name.trim().toLowerCase()));
  const removeHeaders = originalNames.filter((name) => !keptNames.has(name.toLowerCase()));
  return {
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(removeHeaders.length ? { removeHeaders } : {}),
  };
}
