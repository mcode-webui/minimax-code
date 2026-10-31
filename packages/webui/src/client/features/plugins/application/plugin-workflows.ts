// The plugin workflow owner.
//
// One owner for the plugin manager: the marketplace/installed/skill/app/mcp/
// agent listings it reads, and every mutation it performs. The two problems
// this closes:
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

import { webuiPluginFailureTextFrom } from "../../../projection/common/plugin-failure-text.js";
import type { PluginPort } from "../contracts/plugin-port.js";
import {
  createWebuiPluginActions,
  webuiPluginRows,
  type WebuiPluginActions,
  type WebuiPluginActionInputs,
  type WebuiPluginIntent,
} from "../contracts/plugin-actions.js";
import type { WebuiPluginManagementAction } from "../../../../shared/plugin-management.js";
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
  readonly tagDefinitions?: readonly { key: string; displayName: string }[];
  /** `null` means "not knowable from this response" (the skill hub pages). */
  readonly skillTotal?: number | null;
  readonly loading: boolean;
  readonly error?: string;
}

export interface WebuiPluginWorkflowsState {
  /** Bumps after any successful mutation, so a reader can refresh. */
  readonly revision: number;
  readonly listing: WebuiPluginListingState;
  /** The last mutation failure, so one owner reports it rather than each call
   *  site keeping its own copy. Cleared when the next mutation starts. */
  readonly mutationError?: string;
  /** True while a mutation is in flight. */
  readonly mutating: boolean;
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
  mutating: false,
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
  return webuiPluginFailureTextFrom(reason);
}

/** The typed row helpers the component used, kept here so the owner owns them. */
function rowValue(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) if (typeof row[key] === "string") return row[key] as string;
  return "";
}


export interface WebuiPluginWorkflows {
  readonly getSnapshot: () => WebuiPluginWorkflowsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly canManage: boolean;

  /** Load the listing for one selection; a superseded answer is dropped. */
  readonly loadListing: (selection: WebuiPluginSelection) => Promise<void>;
  /** Re-load the most recent selection (used after a mutation). */
  readonly reload: () => Promise<void>;
  /** Submit one UI intent through the matching named owner command. */
  readonly runIntent: (intent: WebuiPluginIntent) => Promise<unknown>;

  /** Read a single MCP server / agent / avatar; returns the raw answer. */
  readonly getMcpServer: (name: string) => Promise<Record<string, unknown>>;
  readonly getAgent: (name: string) => Promise<Record<string, unknown>>;
  readonly readAgentAvatar: (name: string) => Promise<Record<string, unknown>>;
  readonly previewGithubPlugin: (
    input: WebuiPluginActionInputs["previewGithubPlugin"],
  ) => Promise<unknown>;

  readonly installPlugin: (input: WebuiPluginActionInputs["installPlugin"]) => Promise<unknown>;
  readonly uninstallPlugin: (input: WebuiPluginActionInputs["uninstallPlugin"]) => Promise<unknown>;
  readonly enablePlugin: (input: WebuiPluginActionInputs["enablePlugin"]) => Promise<unknown>;
  readonly disablePlugin: (input: WebuiPluginActionInputs["disablePlugin"]) => Promise<unknown>;
  readonly importGithubPlugin: (
    input: WebuiPluginActionInputs["importGithubPlugin"],
  ) => Promise<unknown>;

  readonly installSkill: (input: WebuiPluginActionInputs["installSkill"]) => Promise<unknown>;
  readonly createSkill: (input: WebuiPluginActionInputs["createSkill"]) => Promise<unknown>;
  readonly setSkillEnabled: (input: WebuiPluginActionInputs["setSkillEnabled"]) => Promise<unknown>;
  readonly deleteSkill: (input: WebuiPluginActionInputs["deleteSkill"]) => Promise<unknown>;

  readonly createMcpServer: (input: WebuiPluginActionInputs["createMcpServer"]) => Promise<unknown>;
  readonly updateMcpServer: (input: WebuiPluginActionInputs["updateMcpServer"]) => Promise<unknown>;
  readonly deleteMcpServer: (input: WebuiPluginActionInputs["deleteMcpServer"]) => Promise<unknown>;
  readonly setMcpServerEnabled: (input: WebuiPluginActionInputs["setMcpServerEnabled"]) => Promise<unknown>;
  readonly testMcpServer: (input: WebuiPluginActionInputs["testMcpServer"]) => Promise<unknown>;

  readonly createAgent: (input: WebuiPluginActionInputs["createAgent"]) => Promise<unknown>;
  readonly updateAgent: (input: WebuiPluginActionInputs["updateAgent"]) => Promise<unknown>;
  readonly deleteAgent: (input: WebuiPluginActionInputs["deleteAgent"]) => Promise<unknown>;
}

function runWebuiPluginIntent(
  workflows: Omit<WebuiPluginWorkflows, "runIntent">,
  intent: WebuiPluginIntent,
): Promise<unknown> {
  switch (intent.kind) {
    case "installPlugin":
      return workflows.installPlugin({
        pluginName: intent.pluginName,
        ...(intent.source === undefined ? {} : { source: intent.source }),
      });
    case "uninstallPlugin":
      return workflows.uninstallPlugin({
        pluginName: intent.pluginName,
        ...(intent.source === undefined ? {} : { source: intent.source }),
      });
    case "enablePlugin":
      return workflows.enablePlugin({
        pluginName: intent.pluginName,
        ...(intent.source === undefined ? {} : { source: intent.source }),
      });
    case "disablePlugin":
      return workflows.disablePlugin({
        pluginName: intent.pluginName,
        ...(intent.source === undefined ? {} : { source: intent.source }),
      });
    case "importGithubPlugin":
      return workflows.importGithubPlugin({ source: intent.source });
    case "installSkill":
      return workflows.installSkill({
        url: intent.url,
        ...(intent.displayName === undefined
          ? {}
          : { displayName: intent.displayName }),
        ...(intent.publisherSourceType === undefined
          ? {}
          : { publisherSourceType: intent.publisherSourceType }),
        ...(intent.isFromGit === undefined
          ? {}
          : { isFromGit: intent.isFromGit }),
        ...(intent.creatorInfo === undefined
          ? {}
          : { creatorInfo: intent.creatorInfo }),
      });
    case "createSkill":
      return workflows.createSkill({
        name: intent.name,
        description: intent.description,
        content: intent.content,
      });
    case "setSkillEnabled":
      return workflows.setSkillEnabled({
        skillName: intent.skillName,
        enabled: intent.enabled,
        ...(intent.locationUri === undefined
          ? {}
          : { locationUri: intent.locationUri }),
      });
    case "deleteSkill":
      return workflows.deleteSkill({
        skillName: intent.skillName,
        ...(intent.locationUri === undefined
          ? {}
          : { locationUri: intent.locationUri }),
      });
    case "createMcpServer":
      return workflows.createMcpServer({
        name: intent.name,
        config: intent.config,
        ...(intent.enabled === undefined ? {} : { enabled: intent.enabled }),
      });
    case "updateMcpServer":
      return workflows.updateMcpServer({
        name: intent.name,
        config: intent.config,
      });
    case "deleteMcpServer":
      return workflows.deleteMcpServer({ name: intent.name });
    case "setMcpServerEnabled":
      return workflows.setMcpServerEnabled({
        name: intent.name,
        enabled: intent.enabled,
      });
    case "testMcpServer":
      return workflows.testMcpServer({ name: intent.name });
    case "createAgent":
      return workflows.createAgent({
        name: intent.name,
        ...(intent.displayName === undefined
          ? {}
          : { displayName: intent.displayName }),
        ...(intent.description === undefined
          ? {}
          : { description: intent.description }),
        ...(intent.systemPrompt === undefined
          ? {}
          : { systemPrompt: intent.systemPrompt }),
        ...(intent.initialDefinition === undefined
          ? {}
          : { initialDefinition: intent.initialDefinition }),
      });
    case "updateAgent":
      return workflows.updateAgent({
        name: intent.name,
        ...(intent.displayName === undefined
          ? {}
          : { displayName: intent.displayName }),
        ...(intent.description === undefined
          ? {}
          : { description: intent.description }),
        ...(intent.systemPrompt === undefined
          ? {}
          : { systemPrompt: intent.systemPrompt }),
      });
    case "deleteAgent":
      return workflows.deleteAgent({ name: intent.name });
    default:
      throw new Error(
        `未支持的操作：${(intent as { readonly kind: string }).kind}`,
      );
  }
}

export function createWebuiPluginWorkflows(deps: {
  readonly port: WebuiPluginPortSlice;
  /**
   * A settled mutation changed something another business reads.
   *
   * Announced, not delegated: the assembly decides what a given action means for
   * the read models it owns, because "what is stale" is a different question from
   * "what did I write". Only a mutation that *succeeded* is announced — a rejected
   * write changed nothing, and invalidating on it would make a failed attempt
   * look like a state change.
   */
  readonly onMutated?: (action: WebuiPluginManagementAction, input: unknown) => void;
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

  const actions: WebuiPluginActions = createWebuiPluginActions(port);

  /**
   * One typed dispatch.
   *
   * `K extends WebuiPluginManagementAction` is what makes this a contract rather
   * than a convention: a misspelled action, or a field the validator does not
   * declare for that action, fails to compile here instead of failing as a
   * rejected request in the browser.
   */
  const call = <K extends WebuiPluginManagementAction>(
    action: K,
    input?: WebuiPluginActionInputs[K],
  ): Promise<unknown> => actions.invoke(action, input);

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
          ...(composed.tagDefinitions !== undefined ? { tagDefinitions: composed.tagDefinitions } : {}),
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
    readonly tagDefinitions?: readonly { key: string; displayName: string }[];
    readonly skillTotal?: number | null;
  }> => {
    const { area, view, query, category } = selection;
    if (area === "plugins" && view === "market") {
      const [market, installed] = await Promise.all([
        (async () => {
          const plugins: Record<string, unknown>[] = [];
          let cursor: string | undefined;
          let tagDefinitions: unknown;
          let pluginTotal: unknown;
          const seen = new Set<string>();
          for (;;) {
            const page = await call("listMarketplacePlugins", {
              source: InstalledPluginSource.OFFICIAL,
              limit: 100,
              keyword: query || undefined,
              category: category ? MARKETPLACE_CATEGORY[category] : undefined,
              cursor,
            }) as Record<string, unknown>;
            plugins.push(...webuiPluginRows(page, "plugins"));
            tagDefinitions = page.tagDefinitions ?? tagDefinitions;
            pluginTotal = page.pluginTotal ?? pluginTotal;
            if (page.cursorResetRequired === true) {
              throw new Error("Plugin marketplace cursor expired; refresh the catalogue");
            }
            if (page.hasMore !== true) break;
            const next = page.nextCursor;
            if (typeof next !== "string" || !next || seen.has(next)) {
              throw new Error("Plugin marketplace returned an invalid cursor");
            }
            seen.add(next);
            cursor = next;
          }
          return { plugins, tagDefinitions, pluginTotal };
        })(),
        call("listInstalledPlugins", { limit: 200 }),
      ]);
      const installedNames = new Set(
        webuiPluginRows(installed, "plugins")
          .filter((item) => item.source === InstalledPluginSource.OFFICIAL)
          .map((item) => rowValue(item, "name", "pluginName", "plugin_name", "pluginId").toLowerCase()),
      );
      const rows: Record<string, unknown>[] = webuiPluginRows(market, "plugins").map((item) => ({
        ...item,
        installed:
          item.installed === true ||
          item.installExists === true ||
          installedNames.has(rowValue(item, "name", "pluginName", "plugin_name", "pluginId").toLowerCase()),
      }));
      const total =
        typeof (market as Record<string, unknown> | undefined)?.pluginTotal === "number"
          ? ((market as Record<string, unknown>).pluginTotal as number)
          : rows.length;
      const definitions = (market as { tagDefinitions?: unknown } | undefined)?.tagDefinitions;
      const tagDefinitions = Array.isArray(definitions)
        ? definitions.filter((tag): tag is { key: string; displayName: string } =>
            !!tag && typeof tag.key === "string" && typeof tag.displayName === "string")
        : [];
      const selectedTag = category.startsWith("tag:") ? category.slice(4) : undefined;
      const visibleRows = selectedTag
        ? rows.filter((item) => Array.isArray(item.tags) && item.tags.some((tag: unknown) =>
            !!tag && typeof tag === "object" && (tag as { key?: unknown }).key === selectedTag))
        : rows;
      return { rows: visibleRows, pluginTotal: selectedTag ? visibleRows.length : total, tagDefinitions };
    }
    if (area === "plugins" && view === "personal") {
      const [installed, marketplace] = await Promise.all([
        call("listInstalledPlugins", { limit: 100, keyword: query || undefined }),
        call("listMarketplacePlugins", { limit: 100 }),
      ]);
      const metadata = new Map<string, { iconUrl: string; tags: unknown; displayName: string }>();
      for (const item of webuiPluginRows(marketplace, "plugins")) {
        const icon = rowValue(item, "iconUrl", "icon_url");
        const tags = item.tags;
        const displayName = rowValue(item, "displayName", "display_name");
        const value = { iconUrl: icon, tags, displayName };
        for (const name of [
          rowValue(item, "name", "pluginName", "plugin_name", "pluginId").toLocaleLowerCase(),
          rowValue(item, "displayName", "display_name").toLocaleLowerCase(),
        ]) {
          if (name) metadata.set(name, value);
        }
      }
      const rows = webuiPluginRows(installed, "plugins").map((item) => {
        const match =
          metadata.get(rowValue(item, "name", "pluginName", "plugin_name", "pluginId").toLocaleLowerCase()) ||
          metadata.get(rowValue(item, "displayName", "display_name").toLocaleLowerCase());
        return {
          ...item,
          iconUrl: match?.iconUrl || rowValue(item, "iconUrl", "icon_url"),
          ...(match?.displayName ? { displayName: match.displayName } : {}),
          ...(match?.tags !== undefined ? { tags: match.tags } : {}),
        };
      });
      return { rows };
    }
    if (area === "plugins") {
      return { rows: webuiPluginRows(await call("listInstalledPlugins", { limit: 100, keyword: query || undefined }), "plugins") };
    }
    if (area === "skills" && view === "market") {
      const result = await call("listSkillHub", { limit: 100, keyword: query || undefined });
      const listed = webuiPluginRows(result, "skills");
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
        skills.push(...webuiPluginRows(page, "skills"));
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
      return { rows: webuiPluginRows(await call("listApps"), "miniApps") };
    }
    if (area === "mcp") {
      return { rows: webuiPluginRows(await call("listMcpServers", { keyword: query || undefined }), "servers") };
    }
    const result = await call("listAgents", {
      limit: 100,
      search: query || undefined,
      include: "identity,persona,system_prompt",
    });
    const base = webuiPluginRows(result, "agents");
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
  const mutate = async <K extends WebuiPluginManagementAction>(
    action: K,
    input: WebuiPluginActionInputs[K],
  ): Promise<unknown> => {
    set((current) => {
      const next: WebuiPluginWorkflowsState = { ...current, mutating: true };
      if (next.mutationError !== undefined) delete (next as { mutationError?: string }).mutationError;
      return next;
    });
    try {
      const result = await call(action, input);
      deps.onMutated?.(action, input);
      set((current) => ({ ...current, revision: current.revision + 1 }));
      await reload();
      set((current) => (current.mutating ? { ...current, mutating: false } : current));
      return result;
    } catch (reason) {
      set((current) => ({ ...current, mutationError: message(reason), mutating: false }));
      throw reason;
    }
  };

  const owner: Omit<WebuiPluginWorkflows, "runIntent"> = {
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
  return {
    ...owner,
    runIntent: (intent) => runWebuiPluginIntent(owner, intent),
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
