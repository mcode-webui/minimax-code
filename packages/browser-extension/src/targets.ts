// Tab discovery and the generation registry.
//
// A tab id is not a page. The same tab id comes back after a reload, a navigation
// or a closed-and-reopened tab, and any element reference the Agent recorded
// against the previous page would then point at nothing. Every target therefore
// carries a generation that rises on each committed top-level navigation, and
// input is refused when the generation it was aimed at is no longer current
// (see `input.ts`).
//
// The generation map is persisted in `chrome.storage.session`, not held only in
// memory: an MV3 service worker is terminated and restarted at the browser's
// discretion, and a registry that forgot its generations on restart would accept
// input aimed at a page that no longer exists.

import {
  type WebuiBrowserBridgeStorageArea,
} from "./pairing.js";
import type { WebuiBrowserBridgeTarget } from "./protocol.js";

/** The `chrome.storage.session` key the generation map is stored under. */
export const WEBUI_BROWSER_BRIDGE_TARGETS_STORAGE_KEY = "webui.browserBridge.targets.v1";

/** The generation a tab has before any navigation has been observed. */
const FIRST_GENERATION = 1;

export interface WebuiBrowserExtensionTab {
  readonly id?: number;
  readonly windowId?: number;
  readonly active?: boolean;
  readonly title?: string;
  readonly url?: string;
  readonly favIconUrl?: string;
}

export interface WebuiBrowserBridgeTabsApi {
  query(queryInfo: Record<string, unknown>): Promise<WebuiBrowserExtensionTab[]>;
  get(tabId: number): Promise<WebuiBrowserExtensionTab | undefined>;
}

/** The generation map, as one storage value. */
export interface WebuiBrowserBridgeTargetGenerationStore {
  read(): Promise<Record<string, number>>;
  write(generations: Record<string, number>): Promise<void>;
}

/**
 * Adapts a `chrome.storage` area to the generation store.
 *
 * `storage.session` is the right area for this: the generations describe one
 * browser session and should not outlive it.
 */
export function webuiBrowserBridgeTargetGenerationStore(
  area: WebuiBrowserBridgeStorageArea,
  key: string = WEBUI_BROWSER_BRIDGE_TARGETS_STORAGE_KEY,
): WebuiBrowserBridgeTargetGenerationStore {
  return {
    async read() {
      const stored = (await area.get(key))[key];
      if (typeof stored !== "object" || stored === null) return {};
      const generations = (stored as Record<string, unknown>).generations;
      if (typeof generations !== "object" || generations === null) return {};
      return generations as Record<string, number>;
    },
    async write(generations) {
      await area.set({ [key]: { generations } });
    },
  };
}

/** The wire identity of one tab. */
export function webuiBrowserBridgeTargetId(tabId: number): string {
  return `tab-${tabId}`;
}

/** The tab id a wire identity names, or `undefined` when it is not one of ours. */
export function webuiBrowserBridgeTabId(targetId: string): number | undefined {
  if (!targetId.startsWith("tab-")) return undefined;
  const tabId = Number(targetId.slice("tab-".length));
  return Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : undefined;
}

/**
 * Whether a URL is one an extension cannot drive or capture.
 *
 * The browser's own pages and the stores' own restriction pages are refused by
 * the platform, so they are dropped from the target list rather than offered and
 * then failing — the ADR asks for these to be reported as unavailable, not to
 * prompt per tab.
 */
export function isWebuiBrowserBridgePolicyBlockedUrl(url: string): boolean {
  const schemeEnd = url.indexOf(":");
  if (schemeEnd < 0) return true;
  const scheme = url.slice(0, schemeEnd).toLowerCase();
  if (scheme !== "http" && scheme !== "https" && scheme !== "file") return true;
  const host = url.slice(schemeEnd + 1).toLowerCase();
  return (
    host.startsWith("chromewebstore.google.com/") ||
    host.startsWith("chrome.google.com/webstore") ||
    host.startsWith("microsoftedge.microsoft.com/addons") ||
    host.startsWith("chrome-extension://") ||
    host.startsWith("edge-extension://")
  );
}

export interface WebuiBrowserBridgeResolvedTarget {
  readonly targetId: string;
  readonly tabId: number;
  readonly generation: number;
}

export interface WebuiBrowserBridgeTargetRegistry {
  /** Every target the extension can currently reach. */
  list(): Promise<readonly WebuiBrowserBridgeTarget[]>;
  /** One target's current generation, or `undefined` when it is gone. */
  lookup(targetId: string): Promise<WebuiBrowserBridgeResolvedTarget | undefined>;
  /** Raises the generation of a tab whose top-level document was replaced. */
  noteCommitted(tabId: number): Promise<void>;
  /** Drops a closed tab, so a reused tab id starts from a fresh generation. */
  noteRemoved(tabId: number): Promise<void>;
}

export interface WebuiBrowserBridgeTargetRegistryOptions {
  readonly browserId: string;
  readonly tabs: WebuiBrowserBridgeTabsApi;
  readonly generations: WebuiBrowserBridgeTargetGenerationStore;
}

/**
 * Creates the registry.
 *
 * Generations are loaded lazily and every write goes through one queue: the tab
 * events that raise them arrive faster than storage settles, and an interleaved
 * write could persist an older map over a newer one.
 */
export function createWebuiBrowserBridgeTargetRegistry(
  options: WebuiBrowserBridgeTargetRegistryOptions,
): WebuiBrowserBridgeTargetRegistry {
  let cache: Record<string, number> | undefined;
  let writes: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Record<string, number>> {
    if (!cache) cache = await options.generations.read();
    return cache;
  }

  async function set(generations: Record<string, number>): Promise<void> {
    cache = generations;
    writes = writes.then(() => options.generations.write(generations));
    await writes;
  }

  return {
    async list() {
      const tabs = await options.tabs.query({});
      const generations = await load();
      const targets: WebuiBrowserBridgeTarget[] = [];
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        const url = tab.url ?? "";
        if (isWebuiBrowserBridgePolicyBlockedUrl(url)) continue;
        const targetId = webuiBrowserBridgeTargetId(tab.id);
        targets.push({
          browserId: options.browserId,
          targetId,
          title: tab.title ?? "",
          url,
          ...(tab.favIconUrl ? { faviconUrl: tab.favIconUrl } : {}),
          generation: generations[targetId] ?? FIRST_GENERATION,
        });
      }
      return targets;
    },
    async lookup(targetId) {
      const tabId = webuiBrowserBridgeTabId(targetId);
      if (tabId === undefined) return undefined;
      // Existence comes from the browser, not from the generation map: a tab
      // that has never navigated has no entry there and is still very much open.
      const tab = await options.tabs.get(tabId).catch(() => undefined);
      if (!tab) return undefined;
      if (isWebuiBrowserBridgePolicyBlockedUrl(tab.url ?? "")) return undefined;
      const generations = await load();
      return { targetId, tabId, generation: generations[targetId] ?? FIRST_GENERATION };
    },
    async noteCommitted(tabId) {
      const generations = { ...(await load()) };
      const targetId = webuiBrowserBridgeTargetId(tabId);
      // A tab the registry has not seen before is already at the first
      // generation, so its first committed navigation takes it to the second.
      generations[targetId] = (generations[targetId] ?? FIRST_GENERATION) + 1;
      await set(generations);
    },
    async noteRemoved(tabId) {
      const generations = { ...(await load()) };
      const targetId = webuiBrowserBridgeTargetId(tabId);
      if (generations[targetId] === undefined) return;
      delete generations[targetId];
      await set(generations);
    },
  };
}
