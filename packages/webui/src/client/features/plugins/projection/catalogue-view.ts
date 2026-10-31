import {
  readWebuiPluginRow,
  type WebuiPluginRow,
} from "../contracts/plugin-rows.js";
import { describeWebuiMcpServerStatus } from "./mcp-status.js";

export type WebuiPluginArea = "plugins" | "skills" | "apps" | "mcp" | "agents";

export interface WebuiPluginCatalogueRow {
  readonly source: WebuiPluginRow;
  readonly name: string;
  readonly enabled: boolean;
  readonly description: string;
  readonly iconUrl: string;
  readonly pluginSource: number | undefined;
  readonly locationUri: string | undefined;
  readonly creatorInfo: Record<string, unknown> | undefined;
  readonly appStatus: string;
  readonly mcpStatus: ReturnType<typeof describeWebuiMcpServerStatus>;
}

export interface WebuiPluginCatalogueView {
  readonly rows: readonly WebuiPluginCatalogueRow[];
  readonly isMarketCatalogue: boolean;
  readonly marketNoun: string;
  readonly marketTotal: number | null;
  readonly visibleMarketTotal: number;
}

/** Projects the selected catalogue and its rows without owning requests or state. */
export function projectWebuiPluginCatalogue({
  data,
  query,
  area,
  view,
  pluginTotal,
  skillTotal,
}: {
  readonly data: readonly WebuiPluginRow[];
  readonly query: string;
  readonly area: WebuiPluginArea;
  readonly view: "market" | "personal";
  readonly pluginTotal: number;
  readonly skillTotal: number | null;
}): WebuiPluginCatalogueView {
  const foldedQuery = query.toLocaleLowerCase();
  const rows = data
    .filter((item) => {
      if (!query) return true;
      return `${readWebuiPluginRow(item, "name", "displayName", "display_name")} ${readWebuiPluginRow(item, "description")}`
        .toLocaleLowerCase()
        .includes(foldedQuery);
    })
    .map((source): WebuiPluginCatalogueRow => {
      const runtime =
        source.runtime && typeof source.runtime === "object"
          ? (source.runtime as WebuiPluginRow)
          : {};
      const rawCreatorInfo = source.creatorInfo ?? source.creator_info;
      const creatorInfo =
        rawCreatorInfo &&
        typeof rawCreatorInfo === "object" &&
        !Array.isArray(rawCreatorInfo)
          ? (rawCreatorInfo as Record<string, unknown>)
          : undefined;
      return {
        source,
        name: readWebuiPluginRow(
          source,
          "name",
          "pluginName",
          "plugin_name",
          "pluginId",
          "displayName",
          "display_name",
        ),
        enabled:
          source.enabled === true ||
          source.isEnabled === true ||
          source.is_enabled === true,
        description: readWebuiPluginRow(source, "description", "summary"),
        iconUrl: readWebuiPluginRow(source, "iconUrl", "icon_url"),
        pluginSource:
          typeof source.source === "number" ? source.source : undefined,
        locationUri:
          typeof source.locationUri === "string"
            ? source.locationUri
            : undefined,
        creatorInfo,
        appStatus: (() => {
          const status = readWebuiPluginRow(runtime, "status");
          return status === "running"
            ? "运行中"
            : status === "starting"
              ? "启动中"
              : status === "stopping"
                ? "停止中"
                : status === "failed"
                  ? "启动失败"
                  : status === "stopped"
                    ? "已停止"
                    : "未知状态";
        })(),
        mcpStatus: describeWebuiMcpServerStatus(source),
      };
    });
  const isMarketCatalogue =
    (area === "plugins" || area === "skills") && view === "market";
  const marketNoun = area === "skills" ? "技能" : "插件";
  const marketTotal = area === "skills" ? skillTotal : pluginTotal;
  return {
    rows,
    isMarketCatalogue,
    marketNoun,
    marketTotal,
    visibleMarketTotal: marketTotal ?? rows.length,
  };
}
