// The plugin workflow owner (plan §7.1 `application/plugin-workflows.ts`;
// §7.6 "Plugin list" row; §7.7 stage 5; ticket #52).
//
// One owner for the plugin manager: the marketplace/installed/skill/app/mcp/
// agent listings it reads, and every mutation it performs. The two problems
// this closes, both named in the ticket:
//
//  1. **A listing with no owner.** The component held the rows, the totals,
//     the busy flag, the error and the request-generation counter itself, so
//     "is this response still the current selection" was a component-local
//     race. The owner caches each listing under its selection key and stamps a
//     version per key; a superseded answer is dropped rather than applied.
//
//  2. **A mutation that invalidates by hand.** Every mutation ended with the
//     component re-running its own reload. Here the owner performs the
//     mutation and reloads exactly the listing it affects, in one place.
//
// The component keeps its display state — the active area/view, the search
// box, the category filter, the open dialog, the uncommitted form — because
// that is display state, not query truth. It submits commands and reads the
// snapshot.
//
// This module is framework-free — no React, no DOM — so it can be unit-tested
// against a scripted port.

import type { PluginPort } from "../contracts/plugin-port.js";
import {
  InstalledPluginSource,
  MarketplaceCategory,
} from "@mavis/protocol/local";

/** The transport method this owner drives. Absent means "not wired". */
export type WebuiPluginPortSlice = Pick<PluginPort, "pluginManagement">;

export type WebuiPluginArea = "plugins" | "skills" | "apps" | "mcp" | "agents";
export type WebuiPluginView = "market" | "personal";

export interface WebuiPluginSelection {
  readonly area: WebuiPluginArea;
  readonly view: WebuiPluginView;
  readonly query: string;
  readonly category: string;
}

export interface WebuiPluginListingState {
  readonly selection: WebuiPluginSelection;
  readonly rows: readonly Record<string, unknown>[];
  /** The marketplace's own total, when the response carries one. */
  readonly pluginTotal?: number;
  /** `null` means "not knowable from this response" (the skill hub pages). */
  readonly skillTotal?: number | null;
  readonly loading: boolean;
  readonly error?: string;
}

export interface WebuiPluginWorkflowsState {
  /** Bumps after any successful mutation, so a reader can refresh. */
  readonly revision: number;
  readonly listing: WebuiPluginListingState;
}

export const initialWebuiPluginSelection: WebuiPluginSelection = {
  area: "plugins",
  view: "market",
  query: "",
  category: "",
};

export const initialWebuiPluginListingState: WebuiPluginListingState = {
  selection: initialWebuiPluginSelection,
  rows: [],
  loading: false,
};

export const initialWebuiPluginWorkflowsState: WebuiPluginWorkflowsState = {
  revision: 0,
  listing: initialWebuiPluginListingState,
};

/** The listing key a response's rows live under, per area. */
const LISTING_ROW_KEY: Readonly<Record<WebuiPluginArea, string>> = {
  plugins: "plugins",
  skills: "skills",
  apps: "miniApps",
  mcp: "servers",
  agents: "agents",
};

/** The UI category key → marketplace category, preserved from the component. */
const MARKETPLACE_CATEGORY: Readonly<Record<string, number>> = {
  other: MarketplaceCategory.OTHER,
  office: MarketplaceCategory.OFFICE,
  creative: MarketplaceCategory.STUDIO,
  design_and_sites: MarketplaceCategory.DESIGN_AND_SITES,
  code: MarketplaceCategory.CODE,
  business: MarketplaceCategory.BUSINESS,
  sales: MarketplaceCategory.SALES,
  productivity: MarketplaceCategory.PRODUCTIVITY,
  science_and_healthcare: MarketplaceCategory.SCIENCE_AND_HEALTHCARE,
  education: MarketplaceCategory.EDUCATION,
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** The typed row helpers the component used, kept here so the owner owns them. */
function rowValue(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof row[key] === "string") return row[key] as string;
  return "";
}

function rowList(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> => !!item && typeof item === "object",
    );
  }
  const found = (value as Record<string, unknown>)[key];
  return Array.isArray(found)
    ? found.filter(
        (item): item is Record<string, unknown> => !!item && typeof item === "object",
      )
    : [];
}

export interface WebuiPluginWorkflows {
  readonly getSnapshot: () => WebuiPluginWorkflowsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly canManage: boolean;

  /** Load the listing for one selection; a superseded answer is dropped. */
  readonly loadListing: (selection: WebuiPluginSelection) => Promise<void>;
  /** Re-load the most recent selection (used after a mutation). */
  readonly reload: () => Promise<void>;

  /** Read a single MCP server / agent / avatar; returns the raw answer. */
  readonly getMcpServer: (name: string) => Promise<Record<string, unknown>>;
  readonly getAgent: (name: string) => Promise<Record<string, unknown>>;
  readonly readAgentAvatar: (name: string) => Promise<Record<string, unknown>>;
  readonly previewGithubPlugin: (input: Record<string, unknown>) => Promise<unknown>;

  readonly installPlugin: (input: Record<string, unknown>) => Promise<unknown>;
  readonly uninstallPlugin: (input: Record<string, unknown>) => Promise<unknown>;
  readonly enablePlugin: (input: Record<string, unknown>) => Promise<unknown>;
  readonly disablePlugin: (input: Record<string, unknown>) => Promise<unknown>;
  readonly importGithubPlugin: (input: Record<string, unknown>) => Promise<unknown>;

  readonly installSkill: (input: Record<string, unknown>) => Promise<unknown>;
  readonly createSkill: (input: Record<string, unknown>) => Promise<unknown>;
  readonly setSkillEnabled: (input: Record<string, unknown>) => Promise<unknown>;
  readonly deleteSkill: (input: Record<string, unknown>) => Promise<unknown>;

  readonly createMcpServer: (input: Record<string, unknown>) => Promise<unknown>;
  readonly updateMcpServer: (input: Record<string, unknown>) => Promise<unknown>;
  readonly deleteMcpServer: (input: Record<string, unknown>) => Promise<unknown>;
  readonly setMcpServerEnabled: (input: Record<string, unknown>) => Promise<unknown>;
  readonly testMcpServer: (input: Record<string, unknown>) => Promise<unknown>;

  readonly createAgent: (input: Record<string, unknown>) => Promise<unknown>;
  readonly updateAgent: (input: Record<string, unknown>) => Promise<unknown>;
  readonly deleteAgent: (input: Record<string, unknown>) => Promise<unknown>;
}

export function createWebuiPluginWorkflows(deps: {
  readonly port: WebuiPluginPortSlice;
}): WebuiPluginWorkflows {
  const { port } = deps;
  let state = initialWebuiPluginWorkflowsState;
  const listeners = new Set<() => void>();
  const versions = new Map<string, number>();
  const bump = (key: string): number => {
    const next = (versions.get(key) ?? 0) + 1;
    versions.set(key, next);
    return next;
  };
  const isCurrent = (key: string, version: number): boolean =>
    (versions.get(key) ?? 0) === version;

  const set = (
    update: (current: WebuiPluginWorkflowsState) => WebuiPluginWorkflowsState,
  ): void => {
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const call = (action: string, input?: Record<string, unknown>): Promise<unknown> => {
    if (!port.pluginManagement) {
      return Promise.reject(new Error("Plugin management is not connected to the runtime"));
    }
    return port.pluginManagement({ action: action as never, ...(input ? { input } : {}) });
  };

  const sameSelection = (
    left: WebuiPluginSelection,
    right: WebuiPluginSelection,
  ): boolean =>
    left.area === right.area &&
    left.view === right.view &&
    left.query === right.query &&
    left.category === right.category;

  const loadListing = async (selection: WebuiPluginSelection): Promise<void> => {
    const version = bump("listing");
    if (!port.pluginManagement) {
      set((current) => ({
        ...current,
        listing: {
          selection,
          rows: [],
          loading: false,
          error: "Plugin management is not connected to the runtime",
        },
      }));
      return;
    }
    set((current) => ({ ...current, listing: { selection, rows: [], loading: true } }));
    try {
      const composed = await composeListing(selection);
      if (!isCurrent("listing", version) || !sameSelection(state.listing.selection, selection)) return;
      set((current) => ({
        ...current,
        listing: {
          selection,
          rows: composed.rows,
          loading: false,
          ...(composed.pluginTotal !== undefined ? { pluginTotal: composed.pluginTotal } : {}),
          ...(composed.skillTotal !== undefined ? { skillTotal: composed.skillTotal } : {}),
        },
      }));
    } catch (reason) {
      if (!isCurrent("listing", version) || !sameSelection(state.listing.selection, selection)) return;
      set((current) => ({
        ...current,
        listing: { selection, rows: [], loading: false, error: message(reason) },
      }));
    }
  };

  /** The area/view composition the component used to perform itself. */
  const composeListing = async (
    selection: WebuiPluginSelection,
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly pluginTotal?: number;
    readonly skillTotal?: number | null;
  }> => {
    const { area, view, query, category } = selection;
    if (area === "plugins" && view === "market") {
      const [market, installed] = await Promise.all([
        call("listMarketplacePlugins", {
          source: InstalledPluginSource.OFFICIAL,
          limit: 100,
          keyword: query || undefined,
          category: category ? MARKETPLACE_CATEGORY[category] : undefined,
        }),
        call("listInstalledPlugins", { limit: 200 }),
      ]);
      const installedNames = new Set(
        rowList(installed, "plugins")
          .filter((item) => item.source === InstalledPluginSource.OFFICIAL)
          .map((item) => rowValue(item, "name", "pluginName", "plugin_name", "pluginId").toLowerCase()),
      );
      const rows = rowList(market, "plugins").map((item) => ({
        ...item,
        installed:
          item.installed === true ||
          installedNames.has(rowValue(item, "name", "pluginName", "plugin_name", "pluginId").toLowerCase()),
      }));
      const total =
        typeof (market as Record<string, unknown> | undefined)?.pluginTotal === "number"
          ? ((market as Record<string, unknown>).pluginTotal as number)
          : rows.length;
      return { rows, pluginTotal: total };
    }
    if (area === "plugins" && view === "personal") {
      const [installed, marketplace] = await Promise.all([
        call("listInstalledPlugins", { limit: 100, keyword: query || undefined }),
        call("listMarketplacePlugins", { limit: 100 }),
      ]);
      const icons = new Map<string, string>();
      for (const item of rowList(marketplace, "plugins")) {
        const icon = rowValue(item, "iconUrl", "icon_url");
        for (const name of [
          rowValue(item, "name", "pluginName", "plugin_name", "pluginId").toLocaleLowerCase(),
          rowValue(item, "displayName", "display_name").toLocaleLowerCase(),
        ]) {
          if (name) icons.set(name, icon);
        }
      }
      const rows = rowList(installed, "plugins").map((item) => ({
        ...item,
        iconUrl:
          icons.get(rowValue(item, "name", "pluginName", "plugin_name", "pluginId").toLocaleLowerCase()) ||
          icons.get(rowValue(item, "displayName", "display_name").toLocaleLowerCase()) ||
          rowValue(item, "iconUrl", "icon_url"),
      }));
      return { rows };
    }
    if (area === "plugins") {
      return { rows: rowList(await call("listInstalledPlugins", { limit: 100, keyword: query || undefined }), "plugins") };
    }
    if (area === "skills" && view === "market") {
      const result = await call("listSkillHub", { limit: 100, keyword: query || undefined });
      const listed = rowList(result, "skills");
      const hasMore = Boolean(result && typeof result === "object" && (result as Record<string, unknown>).hasMore === true);
      return { rows: listed, skillTotal: hasMore ? null : listed.length };
    }
    if (area === "skills") {
      // Runtime skills intentionally exclude disabled entries; the management
      // list must include them so the user can turn one back on.
      const skills: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await call("listManageableSkills", {
          limit: 200,
          keyword: query || undefined,
          excludeBuiltin: true,
          cursor,
        });
        skills.push(...rowList(page, "skills"));
        const nextCursor =
          page && typeof page === "object" && typeof (page as Record<string, unknown>).nextCursor === "string"
            ? ((page as Record<string, unknown>).nextCursor as string)
            : undefined;
        if (
          !page ||
          typeof page !== "object" ||
          (page as Record<string, unknown>).hasMore !== true ||
          !nextCursor
        ) {
          break;
        }
        cursor = nextCursor;
      }
      return { rows: skills, skillTotal: null };
    }
    if (area === "apps") {
      return { rows: rowList(await call("listApps"), "miniApps") };
    }
    if (area === "mcp") {
      return { rows: rowList(await call("listMcpServers", { keyword: query || undefined }), "servers") };
    }
    const result = await call("listAgents", {
      limit: 100,
      search: query || undefined,
      include: "identity,persona,system_prompt",
    });
    const base = rowList(result, "agents");
    const rows = await Promise.all(
      base.map(async (item) => {
        if (!rowValue(item, "avatar")) return item;
        try {
          const asset = await call("readAgentAvatar", { name: rowValue(item, "name", "displayName", "display_name") });
          return asset && typeof asset === "object" ? { ...item, ...(asset as Record<string, unknown>) } : item;
        } catch {
          return item;
        }
      }),
    );
    return { rows };
  };

  const reload = async (): Promise<void> => {
    await loadListing(state.listing.selection);
  };

  /**
   * Perform one mutation and reload the listing it affects. The named commands
   * below are explicit intents; this is the shared implementation, not the
   * interface.
   */
  const mutate = async (action: string, input: Record<string, unknown>): Promise<unknown> => {
    const result = await call(action, input);
    set((current) => ({ ...current, revision: current.revision + 1 }));
    await reload();
    return result;
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canManage: port.pluginManagement !== undefined,
    loadListing,
    reload,
    getMcpServer: async (name) => {
      const result = await call("getMcpServer", { name });
      return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    },
    getAgent: async (name) => {
      const result = await call("getAgent", { name });
      return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    },
    readAgentAvatar: async (name) => {
      const result = await call("readAgentAvatar", { name });
      return result && typeof result === "object" ? (result as Record<string, unknown>) : {};
    },
    previewGithubPlugin: (input) => call("previewGithubPlugin", input),
    installPlugin: (input) => mutate("installPlugin", input),
    uninstallPlugin: (input) => mutate("uninstallPlugin", input),
    enablePlugin: (input) => mutate("enablePlugin", input),
    disablePlugin: (input) => mutate("disablePlugin", input),
    importGithubPlugin: (input) => mutate("importGithubPlugin", input),
    installSkill: (input) => mutate("installSkill", input),
    createSkill: (input) => mutate("createSkill", input),
    setSkillEnabled: (input) => mutate("setSkillEnabled", input),
    deleteSkill: (input) => mutate("deleteSkill", input),
    createMcpServer: (input) => mutate("createMcpServer", input),
    updateMcpServer: (input) => mutate("updateMcpServer", input),
    deleteMcpServer: (input) => mutate("deleteMcpServer", input),
    setMcpServerEnabled: (input) => mutate("setMcpServerEnabled", input),
    testMcpServer: (input) => mutate("testMcpServer", input),
    createAgent: (input) => mutate("createAgent", input),
    updateAgent: (input) => mutate("updateAgent", input),
    deleteAgent: (input) => mutate("deleteAgent", input),
  };
}

/** The name a row answers to, shared with the component's own reads. */
export function webuiPluginRowName(row: Record<string, unknown>): string {
  return rowValue(
    row,
    "name",
    "pluginName",
    "plugin_name",
    "pluginId",
    "displayName",
    "display_name",
  );
}

export { LISTING_ROW_KEY };
