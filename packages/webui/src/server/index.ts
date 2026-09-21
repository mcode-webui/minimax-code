// Server entry for the WebUI package. The first version of the package
// is a foundation only; no HTTP transport is wired here. Source ends at
// `WEBUI_FOUNDATION_VERSION` so the standalone CLI build never bundles the
// server module (it is its own entry in `scripts/build-webui.mjs`).

import { WEBUI_FOUNDATION_VERSION } from "../shared/placeholder.js";

export const WEBUI_SERVER_VERSION: typeof WEBUI_FOUNDATION_VERSION =
  WEBUI_FOUNDATION_VERSION;

export interface WebuiServerFoundation {
  readonly version: typeof WEBUI_FOUNDATION_VERSION;
}

export function createWebuiServerFoundation(): WebuiServerFoundation {
  return { version: WEBUI_SERVER_VERSION };
}
