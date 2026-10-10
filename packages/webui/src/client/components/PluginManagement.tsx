import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  InstalledPluginSource,
  MarketplaceCategory,
} from "@mavis/protocol/local";
import type { WebuiPluginManagementAction } from "../../shared/plugin-management.js";
import {
  useWebuiPluginWorkflows,
  useWebuiPluginWorkflowsState,
} from "../bindings/use-query-state.js";
import { WebuiIconAgent } from "../icons.js";
import { ToggleSwitch } from "./ToggleSwitch.js";

type Row = Record<string, unknown>;
type Area = "plugins" | "skills" | "apps" | "mcp" | "agents";
type PluginManagementSelection = {
  readonly area: Area;
  readonly view: "market" | "personal";
  readonly query: string;
  readonly category: string;
};
const sameSelection = (
  left: PluginManagementSelection,
  right: PluginManagementSelection,
): boolean =>
  left.area === right.area &&
  left.view === right.view &&
  left.query === right.query &&
  left.category === right.category;

/**
 * One MCP server's connection state, as the row shows it.
 *
 * The runtime already classifies every server
 * (`LocalMcpPublicServerStatus`: `available` / `configured` / `disabled` /
 * `error` / `unavailable`) and attaches the failure's own reason to the two
 * trouble states — the D-3 gap was that the row rendered none of it, so a
 * server that could not connect was indistinguishable from a healthy one
 * unless you already knew to look elsewhere. `configured` is deliberately
 * NOT trouble: it means enabled and not currently connected, which is the
 * resting state of a server that connects on use.
 */
export interface WebuiMcpServerStatusView {
  readonly key:
    | "available"
    | "configured"
    | "disabled"
    | "error"
    | "unavailable"
    | "unknown";
  readonly label: string;
  readonly tone: string;
  readonly reason?: string;
}

export function describeWebuiMcpServerStatus(item: Row): WebuiMcpServerStatusView {
  const status = read(item, "status");
  const reason = read(item, "error", "errorMessage") || undefined;
  switch (status) {
    case "available":
      return { key: "available", label: "已连接", tone: "text-text_default_secondary" };
    case "configured":
      return { key: "configured", label: "未连接", tone: "text-text_default_tertiary" };
    case "disabled":
      return { key: "disabled", label: "已停用", tone: "text-text_default_tertiary" };
    case "error":
      return { key: "error", label: "连接失败", tone: "text-text_label_danger_secondary_default", reason };
    case "unavailable":
      return { key: "unavailable", label: "不可用", tone: "text-text_label_warning_secondary_default", reason };
    default:
      return { key: "unknown", label: "未知状态", tone: "text-text_default_tertiary" };
  }
}

const CATEGORIES: readonly { id: Area; label: string }[] = [
  { id: "plugins", label: "插件" },
  { id: "skills", label: "技能" },
  { id: "apps", label: "应用" },
  { id: "mcp", label: "MCP" },
  { id: "agents", label: "Agents" },
];
const categories: readonly { id: string; label: string }[] = [
  { id: "", label: "全部" },
  { id: "office", label: "办公" },
  { id: "creative", label: "创作" },
  { id: "design_and_sites", label: "设计与网站" },
  { id: "code", label: "代码" },
  { id: "business", label: "商业" },
  { id: "sales", label: "销售" },
  { id: "productivity", label: "效率" },
  { id: "science_and_healthcare", label: "科学与医疗" },
  { id: "education", label: "教育" },
  { id: "other", label: "其他" },
];
/** Number of cards shown after the user explicitly collapses a catalogue. */
const MARKET_PREVIEW_COUNT = 8;
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
const read = (row: Row, ...keys: string[]): string => {
  for (const key of keys)
    if (typeof row[key] === "string") return row[key] as string;
  return "";
};
const rows = (value: unknown, key: string): Row[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.filter(
      (item): item is Row => !!item && typeof item === "object",
    );
  const found = (value as Row)[key];
  return Array.isArray(found)
    ? found.filter((item): item is Row => !!item && typeof item === "object")
    : [];
};

export function PluginManagement({
  initialArea = "plugins",
  onChatWithAgent,
}: {
  readonly initialArea?: Area;
  readonly onChatWithAgent?: (name: string) => Promise<void>;
}): ReactElement {
  const [area, setArea] = useState<Area>(initialArea);
  const [view, setView] = useState<"market" | "personal">("market");
  const [managementOpen, setManagementOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const selectionRef = useRef<PluginManagementSelection>({
    area,
    view,
    query,
    category,
  });
  selectionRef.current = { area, view, query, category };
  const reloadRequestRef = useRef(0);
  const [showAllCatalogue, setShowAllCatalogue] = useState(true);
  /* Local form-level messages only. A load or mutation failure belongs to the
   * application plugin owner (ticket #52) and is read from its snapshot. */
  const [localError, setLocalError] = useState("");
  const [dialog, setDialog] = useState<"mcp" | "agent" | "skill" | null>(null);
  const [editing, setEditing] = useState<Row | undefined>();
  const [selectedAgent, setSelectedAgent] = useState<Row | undefined>();
  const selectedAgentRef = useRef<Row | undefined>();
  selectedAgentRef.current = selectedAgent;
  const [mcpName, setMcpName] = useState("");
  const [mcpTransport, setMcpTransport] = useState("stdio");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpDescription, setMcpDescription] = useState("");
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpAdvancedOpen, setMcpAdvancedOpen] = useState(false);
  const [mcpEnv, setMcpEnv] = useState("{}");
  const [mcpHeaders, setMcpHeaders] = useState("{}");
  const [mcpTimeoutMs, setMcpTimeoutMs] = useState("");
  const [mcpJsonMode, setMcpJsonMode] = useState(false);
  const [mcpJson, setMcpJson] = useState(() =>
    JSON.stringify(
      { "my-mcp-server": { transport: "stdio", command: "", enabled: true } },
      null,
      2,
    ),
  );
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentModel, setAgentModel] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillContent, setSkillContent] = useState("");
  const [pluginUrl, setPluginUrl] = useState("");
  const [pluginPreview, setPluginPreview] = useState<Row | undefined>();
  const [pluginImportDialog, setPluginImportDialog] = useState(false);

  // The plugin manager's listings and mutations belong to the application
  // plugin owner (ticket #52). This component submits commands and reads the
  // snapshot; it holds no transport method and no request-generation counter —
  // the owner drops an answer for a selection it has left.
  const workflows = useWebuiPluginWorkflows();
  const snapshot = useWebuiPluginWorkflowsState();
  const listing = snapshot.listing;
  const data = listing.rows;
  const marketPluginTotal = listing.pluginTotal ?? 0;
  /* The skill hub reports `hasMore`/`nextCursor` where the plugin marketplace
   * reports a `pluginTotal`, so a skill count is only known to be exact when the
   * listing came back complete. `null` means "the total is not knowable from
   * this response" and the label falls back to a bare 「查看全部技能」. */
  const marketSkillTotal = listing.skillTotal ?? null;
  const busy = listing.loading || snapshot.mutating;
  const error = localError || snapshot.mutationError || listing.error || "";
  const reload = async (): Promise<void> => {
    await workflows?.loadListing({ area, view, query, category });
  };
  useEffect(() => {
    void workflows?.loadListing({ area, view, query, category });
  }, [area, view, query, category, workflows]);
  const filtered = useMemo(
    () =>
      data.filter(
        (item) =>
          !query ||
          `${read(item, "name", "displayName", "display_name")} ${read(item, "description")}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
      ),
    [data, query],
  );
  /* Plugins and skills are two catalogues rendered by one page, so they share
   * every layout decision. `isMarketCatalogue` is the single condition that
   * says "this is the marketplace page rather than a management list" — the
   * two-column card grid, the shared 768px measure and the 「查看全部」 preview
   * are all keyed off it, which is what keeps 技能 laid out exactly like 插件. */
  const isMarketCatalogue =
    (area === "plugins" || area === "skills") && view === "market";
  const marketNoun = area === "skills" ? "技能" : "插件";
  const marketTotal =
    area === "skills" ? marketSkillTotal : marketPluginTotal;
  // When the total is unknown the affordance is still offered once the fetched
  // page itself overflows the preview, so the control is never gated on a
  // number this response could not supply.
  const visibleMarketTotal = marketTotal ?? filtered.length;
  /** One UI action → the owner's named command. The component's own action
   *  vocabulary is the wire's; the owner exposes named intents. */
  const runAction = async (
    action: WebuiPluginManagementAction,
    input: Row,
  ): Promise<unknown> => {
    if (!workflows)
      throw new Error("Plugin management is not connected to the runtime");
    switch (action) {
      case "installPlugin": return workflows.installPlugin(input);
      case "uninstallPlugin": return workflows.uninstallPlugin(input);
      case "enablePlugin": return workflows.enablePlugin(input);
      case "disablePlugin": return workflows.disablePlugin(input);
      case "importGithubPlugin": return workflows.importGithubPlugin(input);
      case "installSkill": return workflows.installSkill(input);
      case "createSkill": return workflows.createSkill(input);
      case "setSkillEnabled": return workflows.setSkillEnabled(input);
      case "deleteSkill": return workflows.deleteSkill(input);
      case "createMcpServer": return workflows.createMcpServer(input);
      case "updateMcpServer": return workflows.updateMcpServer(input);
      case "deleteMcpServer": return workflows.deleteMcpServer(input);
      case "setMcpServerEnabled": return workflows.setMcpServerEnabled(input);
      case "testMcpServer": return workflows.testMcpServer(input);
      case "createAgent": return workflows.createAgent(input);
      case "updateAgent": return workflows.updateAgent(input);
      case "deleteAgent": return workflows.deleteAgent(input);
      default: throw new Error(`未支持的操作：${action}`);
    }
  };
  const mutate = async (
    action: WebuiPluginManagementAction,
    input: Row,
  ): Promise<boolean> => {
    try {
      await runAction(action, input);
      return true;
    } catch {
      // The owner records the failure and reloads; this only reports it.
      return false;
    }
  };
  const confirmMutation = (
    label: string,
    action: WebuiPluginManagementAction,
    input: Row,
  ) => {
    if (window.confirm(`确定${label}？此操作会立即影响本地配置。`))
      void mutate(action, input);
  };
  const nameOf = (item: Row) =>
    read(
      item,
      "name",
      "pluginName",
      "plugin_name",
      "pluginId",
      "displayName",
      "display_name",
    );
  const pluginSource = (item: Row) =>
    typeof item.source === "number" ? item.source : undefined;
  const enabled = (item: Row) =>
    item.enabled === true ||
    item.isEnabled === true ||
    item.is_enabled === true;
  const appStatus = (item: Row) => {
    const runtime =
      item.runtime && typeof item.runtime === "object"
        ? (item.runtime as Row)
        : {};
    const status = read(runtime, "status");
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
  };

  const beginMcp = (item?: Row) => {
    setEditing(item);
    setMcpName(nameOf(item ?? {}));
    const config = (
      item?.config && typeof item.config === "object" ? item.config : {}
    ) as Row;
    setMcpDescription(
      read(config, "description") || read(item ?? {}, "description"),
    );
    const method = read(config, "transport", "type") || "stdio";
    setMcpTransport(method);
    setMcpCommand(read(config, "command"));
    setMcpArgs(Array.isArray(config.args) ? config.args.join(" ") : "");
    setMcpUrl(read(config, "url"));
    setMcpEnabled(item?.enabled !== false);
    setMcpAdvancedOpen(false);
    setMcpEnv(JSON.stringify(config.env ?? {}, null, 2));
    setMcpHeaders(JSON.stringify(config.headers ?? {}, null, 2));
    setMcpTimeoutMs(typeof config.timeoutMs === "number" ? String(config.timeoutMs) : "");
    setMcpJson(
      JSON.stringify(
        {
          [nameOf(item ?? {}) || "my-mcp-server"]: {
            ...config,
            enabled: item?.enabled !== false,
          },
        },
        null,
        2,
      ),
    );
    setMcpJsonMode(false);
    setDialog("mcp");
  };
  const prepareMcp = async (item?: Row) => {
    if (!item) {
      beginMcp();
      return;
    }
    try {
      const detail = await workflows?.getMcpServer(nameOf(item));
      beginMcp((detail && typeof detail === "object" ? detail : item) as Row);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const saveMcp = async () => {
    const parseJsonDraft = (
      source: string,
    ): { name: string; enabled: boolean; config: Row } => {
      const parsed: unknown = JSON.parse(source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("JSON 配置必须是对象");
      const root = parsed as Row;
      const servers =
        root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
          ? (root.mcpServers as Row)
          : root;
      let name = mcpName.trim();
      let rawConfig: Row;
      if (typeof servers.transport === "string") {
        if (typeof servers.name === "string") name = servers.name;
        rawConfig = servers;
      } else {
        const entries = Object.entries(servers);
        const entry = entries[0];
        if (
          entries.length !== 1 ||
          !entry ||
          !entry[1] ||
          typeof entry[1] !== "object" ||
          Array.isArray(entry[1])
        )
          throw new Error("请提供单个 server 配置，或只包含一个 server 的 mcpServers 对象");
        name = entry[0];
        rawConfig = entry[1] as Row;
      }
      if (!name) throw new Error("请填写 Server 名称");
      const { enabled, ...configWithName } = rawConfig;
      const config = { ...configWithName };
      delete config.name;
      return {
        name,
        enabled: typeof enabled === "boolean" ? enabled : mcpEnabled,
        config,
      };
    };
    const parseRecord = (value: string, label: string): Row | undefined => {
      if (!value.trim()) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`${label}必须是有效 JSON`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.values(parsed).some((entry) => typeof entry !== "string"))
        throw new Error(`${label}必须是字符串键值对象`);
      return parsed as Row;
    };
    let config: Row;
    let name = mcpName.trim();
    let enabled = mcpEnabled;
    if (mcpJsonMode) {
      try {
        const draft = parseJsonDraft(mcpJson);
        name = draft.name;
        enabled = draft.enabled;
        config = draft.config;
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
    } else {
      try {
        const env = mcpTransport === "stdio" ? parseRecord(mcpEnv, "环境变量") : undefined;
        const headers = mcpTransport === "stdio" ? undefined : parseRecord(mcpHeaders, "请求头");
        const timeoutMs = mcpTimeoutMs.trim() ? Number(mcpTimeoutMs) : undefined;
        if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
          throw new Error("超时必须是正整数（毫秒）");
        config = {
          transport: mcpTransport,
          description: mcpDescription,
          ...(timeoutMs ? { timeoutMs } : {}),
          ...(mcpTransport === "stdio"
            ? {
                command: mcpCommand,
                args: mcpArgs.split(/\s+/u).filter(Boolean),
                ...(env ? { env } : {}),
              }
            : { url: mcpUrl, ...(headers ? { headers } : {}) }),
        };
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
    }
    const saved = await mutate(editing ? "updateMcpServer" : "createMcpServer", {
        name,
        config,
        enabled,
      });
    if (!saved) return;
    if (editing && editing.enabled !== enabled) {
      if (!(await mutate("setMcpServerEnabled", { name, enabled }))) return;
    }
    setDialog(null);
  };
  const switchMcpToForm = () => {
    try {
      const parsed: unknown = JSON.parse(mcpJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("JSON 配置必须是对象");
      const root = parsed as Row;
      const servers =
        root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)
          ? (root.mcpServers as Row)
          : root;
      let name = mcpName.trim();
      let config: Row;
      if (typeof servers.transport === "string") {
        config = servers;
        if (typeof servers.name === "string") name = servers.name;
      }
      else {
        const entries = Object.entries(servers);
        const entry = entries[0];
        if (
          entries.length !== 1 ||
          !entry ||
          !entry[1] ||
          typeof entry[1] !== "object" ||
          Array.isArray(entry[1])
        )
          throw new Error("表单模式一次只能编辑一个 server");
        name = entry[0];
        config = entry[1] as Row;
      }
      setMcpName(name);
      setMcpTransport(read(config, "transport", "type") || "stdio");
      setMcpCommand(read(config, "command"));
      setMcpArgs(Array.isArray(config.args) ? config.args.join(" ") : "");
      setMcpUrl(read(config, "url"));
      setMcpDescription(read(config, "description"));
      setMcpEnabled(config.enabled !== false);
      setMcpEnv(JSON.stringify(config.env ?? {}, null, 2));
      setMcpHeaders(JSON.stringify(config.headers ?? {}, null, 2));
      setMcpTimeoutMs(typeof config.timeoutMs === "number" ? String(config.timeoutMs) : "");
      setMcpJsonMode(false);
      setLocalError("");
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const switchMcpToJson = () => {
    try {
      const timeoutMs = mcpTimeoutMs.trim() ? Number(mcpTimeoutMs) : undefined;
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
        throw new Error("超时必须是正整数（毫秒）");
      const config: Row = {
        transport: mcpTransport,
        ...(mcpTransport === "stdio"
          ? {
              command: mcpCommand,
              ...(mcpArgs.trim()
                ? { args: mcpArgs.split(/\s+/u).filter(Boolean) }
                : {}),
            }
          : { url: mcpUrl }),
        ...(mcpDescription.trim() ? { description: mcpDescription.trim() } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      };
      const record = (value: string, label: string): Row | undefined => {
        if (!value.trim()) return undefined;
        const parsed: unknown = JSON.parse(value);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          Object.values(parsed).some((entry) => typeof entry !== "string")
        )
          throw new Error(`${label}必须是字符串键值对象`);
        return parsed as Row;
      };
      const env = mcpTransport === "stdio" ? record(mcpEnv, "环境变量") : undefined;
      const headers = mcpTransport === "stdio" ? undefined : record(mcpHeaders, "请求头");
      if (env && Object.keys(env).length > 0) config.env = env;
      if (headers && Object.keys(headers).length > 0) config.headers = headers;
      config.enabled = mcpEnabled;
      setMcpJson(
        JSON.stringify(
          { [mcpName.trim() || "my-mcp-server"]: config },
          null,
          2,
        ),
      );
      setMcpJsonMode(true);
      setLocalError("");
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const beginAgent = (item?: Row) => {
    setEditing(item);
    setSelectedAgent(item);
    setAgentName(read(item ?? {}, "name", "displayName", "display_name"));
    setAgentDescription(read(item ?? {}, "description"));
    setAgentPrompt(read(item ?? {}, "systemPrompt", "system_prompt"));
    setAgentModel(read(item ?? {}, "model"));
  };
  const saveAgent = async () => {
    const input = editing
      ? {
          name: nameOf(editing),
          displayName: agentName.trim(),
          description: agentDescription.trim(),
          systemPrompt: agentPrompt,
        }
      : {
          name: agentName.trim(),
          displayName: agentName.trim(),
          description: agentDescription.trim(),
          systemPrompt: agentPrompt,
          initialDefinition: {
            name: agentName.trim(),
            description: agentDescription.trim(),
            ...(agentModel.trim() ? { model: agentModel.trim() } : {}),
            systemPrompt: agentPrompt,
          },
        };
    await mutate(editing ? "updateAgent" : "createAgent", input);
  };
  const chatWithAgent = async () => {
    if (!editing || !onChatWithAgent) return;
    try {
      await onChatWithAgent(nameOf(editing));
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const saveSkill = async () => {
    if (
      await mutate("createSkill", {
        name: agentName.trim(),
        description: skillDescription.trim(),
        content: skillContent,
      })
    ) {
      setAgentName("");
      setDialog(null);
    }
  };
  const previewPlugin = async () => {
    try {
      setLocalError("");
      const result = await workflows?.previewGithubPlugin({
        url: pluginUrl.trim(),
      });
      setPluginPreview(result as Row);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const importPlugin = async () => {
    const source = pluginPreview?.source;
    if (!source || typeof source !== "object") return;
    if (await mutate("importGithubPlugin", { source: source as Row })) {
      setPluginImportDialog(false);
      setPluginPreview(undefined);
    }
  };

  // Switching the marketplace catalogue. The plugin category filter belongs to
  // the plugin list, so it is cleared with the switch rather than left applied
  // to a list it cannot narrow.
  const selectMarketCatalog = (catalog: "plugins" | "skills") => {
    setArea(catalog);
    setView("market");
    setCategory("");
    setShowAllCatalogue(true);
  };

  const openCreate = (target: Area) => {
    setArea(target);
    setView("personal");
    setManagementOpen(true);
    setCreateMenuOpen(false);
    if (target === "mcp") beginMcp();
    else if (target === "agents") beginAgent();
    else {
      setEditing(undefined);
      setAgentName("");
      setSkillDescription("");
      setSkillContent("");
      setDialog("skill");
    }
  };

  return (
    <section
      className={`webui-plugin-management ${managementOpen ? "is-managing" : "is-marketplace"}`}
      data-testid="plugin-management"
    >
      {/* Two elements because the bar is pinned: the header is the sticky,
       * full-bleed, opaque surface, and the row inside it keeps the width the
       * content is laid out against. */}
      <header className="webui-plugin-header">
        {managementOpen ? (
          <button
            type="button"
            className="webui-plugin-management-back"
            onClick={() => {
              setManagementOpen(false);
              setArea("plugins");
              setView("market");
            }}
            aria-label="返回"
          >
            ‹ 插件
          </button>
        ) : null}
        <div className="webui-plugin-header-inner">
        {managementOpen ? (
          <>
            <h1>管理</h1>
            <div className="webui-plugin-create-anchor webui-plugin-management-create-anchor">
              <button
                type="button"
                className="webui-plugin-create-trigger"
                aria-expanded={createMenuOpen}
                onClick={() => setCreateMenuOpen((open) => !open)}
              >
                ＋ 创建
              </button>
              {createMenuOpen ? (
                <div className="webui-plugin-create-menu">
                  <button
                    onClick={() => {
                      setPluginImportDialog(true);
                      setCreateMenuOpen(false);
                      setPluginUrl("");
                      setPluginPreview(undefined);
                    }}
                  >
                    从 Git 仓库导入插件
                  </button>
                  <button onClick={() => openCreate("skills")}>录入技能</button>
                  <button onClick={() => openCreate("mcp")}>
                    添加 MCP server
                  </button>
                  <button onClick={() => openCreate("agents")}>
                    创建 Agent
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <>
            {/* The marketplace is a catalogue of two kinds of thing, so the
             * header picks one: plugins, or skills. They used to share a single
             * page with the skills appended below the plugin grid, which meant
             * one list to scroll and one search box claiming to cover both.
             * What is installed is no longer the 个人 half of a 市场/个人 pair —
             * that pair is gone. The 管理 button in the same button group opens
             * the management view, which is where installed plugins live. */}
            <div className="webui-plugin-header-tabs" aria-label="插件与技能">
              <button
                aria-pressed={area === "plugins"}
                onClick={() => selectMarketCatalog("plugins")}
              >
                插件
              </button>
              <button
                aria-pressed={area === "skills"}
                onClick={() => selectMarketCatalog("skills")}
              >
                技能
              </button>
            </div>
            <div className="webui-plugin-create-anchor">
              <button
                type="button"
                aria-label="刷新插件市场"
                onClick={() => void reload()}
              >
                ⟳
              </button>
              <button
                type="button"
                className="webui-plugin-manage-trigger"
                onClick={() => {
                  setManagementOpen(true);
                  setView("personal");
                }}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M7.1 2.8h5.8l4.3 4.3v5.8l-4.3 4.3H7.1l-4.3-4.3V7.1z" />
                  <circle cx="10" cy="10" r="2.2" />
                </svg>
                管理
              </button>
            </div>
          </>
        )}
        </div>
        {isMarketCatalogue ? (
          <div className="webui-plugin-market-discovery">
            {/* Plugin categories do not apply to the skill hub, so the nav is
             * the plugin catalogue's alone. The search box is shared. */}
            {area === "plugins" ? (
              <nav className="webui-plugin-category-filter" aria-label="市场分类">
                {categories.map((item) => (
                  <button
                    key={item.id}
                    aria-pressed={category === item.id}
                    onClick={() => setCategory(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
            ) : null}
            <label className="webui-plugin-market-search">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="8.8" cy="8.8" r="5.8" />
                <path d="m13.2 13.2 4 4" />
              </svg>
              <input
                aria-label={area === "skills" ? "搜索技能" : "搜索插件"}
                placeholder={area === "skills" ? "搜索技能..." : "搜索插件..."}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          </div>
        ) : null}
        {managementOpen ? (
          <div className="webui-plugin-market-discovery webui-plugin-management-discovery">
            <nav className="webui-plugin-category-filter" aria-label="插件管理分类">
              {CATEGORIES.map((item) => (
                <button
                  key={item.id}
                  aria-pressed={area === item.id}
                  onClick={() => {
                    setLocalError("");
                    setArea(item.id);
                    setView("personal");
                  }}
                >
                  <span>{item.label}</span>
                  {area === item.id ? (
                    <span className="webui-plugin-count">{data.length}</span>
                  ) : null}
                </button>
              ))}
            </nav>
            <label className="webui-plugin-market-search">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="8.8" cy="8.8" r="5.8" />
                <path d="m13.2 13.2 4 4" />
              </svg>
              <input
                aria-label={`搜索${area === "mcp" ? "MCP" : area === "skills" ? "技能" : area === "agents" ? "Agent" : area === "apps" ? "应用" : "插件"}`}
                placeholder={`搜索${area === "mcp" ? "MCP" : area === "skills" ? "技能" : area === "agents" ? "Agent" : area === "apps" ? "应用" : "插件"}...`}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          </div>
        ) : null}
      </header>
      {isMarketCatalogue ? (
        <h2 className="webui-plugin-market-heading">{marketNoun}</h2>
      ) : null}
      {area === "plugins" && view === "personal" && !managementOpen ? (
        <h2 className="webui-plugin-market-heading">插件</h2>
      ) : null}
      {error ? (
        <p role="alert" className="webui-plugin-error">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p className="webui-plugin-empty" role="status">
          加载中…
        </p>
      ) : area === "agents" ? (
        <div className="webui-agent-editor">
          <div className="webui-agent-list">
            <div className="webui-agent-list-heading">全部 Agent</div>
            {filtered.map((item) => (
              <button
                key={nameOf(item)}
                aria-pressed={selectedAgent === item}
                onClick={() => beginAgent(item)}
              >
                <span className="webui-agent-avatar webui-agent-avatar--small">
                  {read(item, "avatarDataUrl").startsWith("data:image/") ? (
                    <img src={read(item, "avatarDataUrl")} alt="" />
                  ) : (
                    <WebuiIconAgent className="webui-agent-avatar-icon webui-agent-avatar-icon--small" />
                  )}
                </span>
                <span>{read(item, "displayName", "display_name") || nameOf(item)}</span>
              </button>
            ))}
            <button
              className="webui-agent-create"
              type="button"
              onClick={() => beginAgent()}
            >
              <span aria-hidden="true">＋</span> 创建 Agent
            </button>
          </div>
          <div className="webui-agent-detail">
            <div className="webui-agent-fields">
              <label className="webui-agent-avatar-field">
                头像
                <span className="webui-agent-avatar webui-agent-avatar--large">
                  {read(selectedAgent ?? {}, "avatarDataUrl").startsWith("data:image/") ? (
                    <img src={read(selectedAgent ?? {}, "avatarDataUrl")} alt="Agent 头像" />
                  ) : (
                    <WebuiIconAgent className="webui-agent-avatar-icon webui-agent-avatar-icon--large" />
                  )}
                </span>
              </label>
              <label>
                名称
                <input
                  value={agentName}
                  onChange={(event) => setAgentName(event.currentTarget.value)}
                  placeholder="Agent 名称"
                />
              </label>
              <label className="webui-agent-model-field">
                模型
                <input
                  value={agentModel}
                  onChange={(event) => setAgentModel(event.currentTarget.value)}
                  placeholder="provider/model-name"
                  readOnly={Boolean(editing)}
                  aria-readonly={editing ? "true" : undefined}
                  title={editing ? "当前运行时只支持在创建时设置模型" : undefined}
                />
              </label>
              <label className="webui-agent-prompt-field">
                系统提示词
                <textarea
                  className="webui-agent-prompt"
                  value={agentPrompt}
                  onChange={(event) => setAgentPrompt(event.currentTarget.value)}
                  placeholder="输入系统提示词"
                  spellCheck={false}
                />
              </label>
            </div>
            <div className="webui-agent-form-actions">
              {editing ? (
                <button
                  className="webui-agent-delete"
                  type="button"
                  onClick={() =>
                    confirmMutation("删除 Agent", "deleteAgent", {
                      name: nameOf(editing),
                    })
                  }
                >
                  删除
                </button>
              ) : <span />}
              <button
                type="button"
                className="webui-agent-save"
                disabled={busy || !agentName.trim()}
                onClick={() => void saveAgent()}
              >
                保存
              </button>
              {editing && onChatWithAgent ? (
                <button
                  type="button"
                  className="webui-agent-chat"
                  disabled={busy}
                  onClick={() => void chatWithAgent()}
                >
                  和他对话
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <p className="webui-plugin-empty">暂无内容</p>
      ) : (
        <div
          className={`webui-plugin-list ${isMarketCatalogue ? "webui-plugin-grid" : ""}`}
        >
          {(isMarketCatalogue && !showAllCatalogue
            ? filtered.slice(0, MARKET_PREVIEW_COUNT)
            : filtered
          ).map((item, index) => {
            const name = nameOf(item) || `item-${index}`;
            const isOn = enabled(item);
            const description = read(item, "description", "summary");
            // Computed for every row, read only in the mcp branch: the loose
            // read is side-effect-free, and narrowing `area` inside the JSX
            // below cannot narrow this binding.
            const mcpStatus = describeWebuiMcpServerStatus(item);
            const action =
              area === "plugins"
                ? view === "market"
                  ? "installPlugin"
                  : isOn
                    ? "disablePlugin"
                    : "enablePlugin"
                : area === "skills"
                  ? view === "market"
                    ? "installSkill"
                    : "setSkillEnabled"
                  : "setMcpServerEnabled";
            const iconUrl = read(item, "iconUrl", "icon_url");
            return (
              <article className="webui-plugin-row" key={`${area}-${name}`}>
                <div
                  className={`webui-plugin-icon${area === "skills" ? " webui-plugin-icon--skill" : ""}`}
                  aria-hidden="true"
                >
                  {area === "skills" ? (
                    <span className="webui-plugin-skill-icon-tile">
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d="M9 4.25h7.25L19.5 7.5v11.25A1.75 1.75 0 0 1 17.75 20.5H9A2 2 0 0 1 7 18.5v-12.25a2 2 0 0 1 2-2Z" />
                        <path d="M16 4.5v3.25h3.25M11 11h5.5M11 14h5.5M11 17h3.25" />
                        <path d="M7 7H5.75A1.75 1.75 0 0 0 4 8.75v9.5A1.75 1.75 0 0 0 5.75 20H9" />
                      </svg>
                    </span>
                  ) : iconUrl ? (
                    <>
                      <img
                        src={iconUrl}
                        alt=""
                        loading="lazy"
                        onError={(event) => {
                          event.currentTarget.hidden = true;
                          event.currentTarget.nextElementSibling?.removeAttribute(
                            "hidden",
                          );
                        }}
                      />
                      <span hidden>▦</span>
                    </>
                  ) : area === "plugins" ? (
                    "▦"
                  ) : (
                    "◇"
                  )}
                </div>
                <div className="webui-plugin-copy">
                  <h2>{read(item, "displayName", "display_name") || name}</h2>
                  <p>{description || read(item, "transport")}</p>
                </div>
                {area === "plugins" && view === "market" ? (
                  <button
                    type="button"
                    disabled={item.installed === true}
                    onClick={() =>
                      void mutate(action, {
                        pluginName: name,
                        source: pluginSource(item),
                      })
                    }
                  >
                    {item.installed === true ? "已安装" : "安装"}
                  </button>
                ) : area === "skills" && view === "market" ? (
                  <button
                    type="button"
                    disabled={
                      item.added === true ||
                      !read(
                        item,
                        "url",
                        "sourceUrl",
                        "source_url",
                        "gitUrl",
                        "git_url",
                      )
                    }
                    onClick={() =>
                      void mutate("installSkill", {
                        url:
                          read(item, "url", "sourceUrl", "source_url") ||
                          read(item, "gitUrl", "git_url"),
                        displayName:
                          read(item, "displayName", "display_name") ||
                          undefined,
                        publisherSourceType:
                          typeof item.publisherSourceType === "number"
                            ? item.publisherSourceType
                            : typeof item.source_type === "number"
                              ? item.source_type
                              : undefined,
                        isFromGit:
                          item.isFromGit === true || item.is_from_git === true,
                        ...(item.creatorInfo &&
                        typeof item.creatorInfo === "object"
                          ? { creatorInfo: item.creatorInfo }
                          : item.creator_info &&
                              typeof item.creator_info === "object"
                            ? { creatorInfo: item.creator_info }
                            : {}),
                      })
                    }
                  >
                    {item.added === true ? "已添加" : "添加"}
                  </button>
                ) : area === "apps" ? (
                  <span className="text-text_default_tertiary">
                    {appStatus(item)}
                  </span>
                ) : area === "mcp" ? (
                  <>
                    {/* The status the runtime already knows, on the row
                     * itself: a server that cannot connect is labelled
                     * 连接失败 with its own reason inline — visible text, not
                     * a tooltip, because nobody hovers a row they believe
                     * is healthy. Mirrors the apps area's status slot. */}
                    <div className="webui-plugin-mcp-status">
                      <span
                        className={`text-size_12 ${mcpStatus.tone}`}
                        data-webui-mcp-status={mcpStatus.key}
                      >
                        {mcpStatus.label}
                      </span>
                      {mcpStatus.reason ? (
                        <small
                          className="text-size_12 text-text_default_tertiary"
                          data-webui-mcp-status-reason={mcpStatus.key}
                          title={mcpStatus.reason}
                        >
                          {mcpStatus.reason}
                        </small>
                      ) : null}
                    </div>
                    <div className="webui-plugin-actions">
                    <button onClick={() => void prepareMcp(item)}>编辑</button>
                    <button
                      onClick={() =>
                        confirmMutation("删除 MCP server", "deleteMcpServer", {
                          name,
                        })
                      }
                    >
                      删除
                    </button>
                    <ToggleSwitch
                      checked={isOn}
                      label={`启用 ${name}`}
                      onChange={() =>
                        void mutate(action, { name, enabled: !isOn })
                      }
                    />
                  </div>
                  </>
                ) : (
                  <div className="webui-plugin-actions">
                    <ToggleSwitch
                      checked={isOn}
                      label={`启用 ${name}`}
                      onChange={() =>
                        void mutate(
                          action,
                          area === "plugins"
                            ? { pluginName: name, source: pluginSource(item) }
                            : {
                                skillName: name,
                                enabled: !isOn,
                                ...(item.locationUri
                                  ? { locationUri: item.locationUri }
                                  : {}),
                              },
                        )
                      }
                    />
                    {area === "plugins" ? (
                      <button
                        onClick={() =>
                          confirmMutation("卸载插件", "uninstallPlugin", {
                            pluginName: name,
                            source: pluginSource(item),
                          })
                        }
                      >
                        卸载
                      </button>
                    ) : area === "skills" ? (
                      <button
                        onClick={() =>
                          confirmMutation("删除技能", "deleteSkill", {
                            skillName: name,
                            ...(item.locationUri
                              ? { locationUri: item.locationUri }
                              : {}),
                          })
                        }
                      >
                        删除
                      </button>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {!busy && isMarketCatalogue && visibleMarketTotal > MARKET_PREVIEW_COUNT ? (
        <button
          type="button"
          className="webui-plugin-show-all"
          onClick={() => setShowAllCatalogue((value) => !value)}
        >
          {showAllCatalogue
            ? `收起${marketNoun}`
            : marketTotal === null
              ? `查看全部${marketNoun}`
              : `查看全部 ${marketTotal} 个`}
        </button>
      ) : null}
      {dialog ? (
        <div
          className="webui-plugin-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDialog(null);
          }}
        >
          <section
            className={`webui-plugin-dialog${dialog === "mcp" ? " webui-mcp-dialog" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-dialog-title"
          >
            <header>
              <div>
                <h2 id="plugin-dialog-title">
                  {dialog === "mcp"
                    ? editing
                      ? "编辑 MCP server"
                      : "添加 MCP server"
                    : dialog === "skill"
                      ? "录入技能"
                      : editing
                        ? "编辑 Agent"
                        : "创建 Agent"}
                </h2>
                <p>{dialog === "mcp" ? "配置 MiniMax Code 如何连接到这个 server" : "配置 MiniMax Code 如何连接到该项"}</p>
              </div>
              <button onClick={() => setDialog(null)} aria-label="关闭">
                ×
              </button>
            </header>
            {dialog === "mcp" ? (
              <>
                <div className="webui-plugin-header-tabs">
                  <button
                    type="button"
                    aria-pressed={!mcpJsonMode}
                    onClick={switchMcpToForm}
                  >
                    表单
                  </button>
                  <button
                    type="button"
                    aria-pressed={mcpJsonMode}
                    onClick={switchMcpToJson}
                  >
                    JSON
                  </button>
                </div>
                {mcpJsonMode ? (
                  <div className="webui-mcp-json-panel">
                    <p>粘贴单个服务器配置或 <code>mcpServers</code> 对象。</p>
                    <textarea
                      className="webui-plugin-json webui-mcp-json-editor"
                      aria-label="MCP 配置 JSON"
                      value={mcpJson}
                      onChange={(event) =>
                        setMcpJson(event.currentTarget.value)
                      }
                      spellCheck={false}
                    />
                  </div>
                ) : (
                  <div className="webui-plugin-form webui-mcp-form">
                    <label>
                      Server 名称
                      <input
                        value={mcpName}
                        onChange={(event) =>
                          setMcpName(event.currentTarget.value)
                        }
                        placeholder="my-server"
                      />
                    </label>
                    <label>
                      传输方式
                      <select
                        value={mcpTransport}
                        onChange={(event) =>
                          setMcpTransport(event.currentTarget.value)
                        }
                      >
                        <option value="stdio">stdio</option>
                        <option value="streamable-http">HTTP</option>
                        <option value="sse">SSE</option>
                      </select>
                    </label>
                    {mcpTransport === "stdio" ? (
                      <>
                        <label>
                          命令
                          <input
                            value={mcpCommand}
                            onChange={(event) =>
                              setMcpCommand(event.currentTarget.value)
                            }
                            placeholder="npx"
                          />
                        </label>
                        <label>
                          参数
                          <input
                            value={mcpArgs}
                            onChange={(event) =>
                              setMcpArgs(event.currentTarget.value)
                            }
                            placeholder="-y @example/mcp-server"
                          />
                        </label>
                      </>
                    ) : (
                      <label>
                        URL
                        <input
                          value={mcpUrl}
                          onChange={(event) =>
                            setMcpUrl(event.currentTarget.value)
                          }
                          placeholder="https://example.com/mcp"
                        />
                      </label>
                    )}
                    <label className="wide">
                      描述
                      <input
                        value={mcpDescription}
                        onChange={(event) =>
                          setMcpDescription(event.currentTarget.value)
                        }
                        placeholder="这个 server 提供什么能力？"
                      />
                    </label>
                    <div className="webui-mcp-enabled wide">
                      <div>
                        <strong>启用</strong>
                        <span>允许 MiniMax Code 使用此服务。</span>
                      </div>
                      <ToggleSwitch checked={mcpEnabled} label="启用 MCP server" onChange={setMcpEnabled} />
                    </div>
                    <div className="webui-mcp-advanced wide">
                      <button
                        type="button"
                        aria-expanded={mcpAdvancedOpen}
                        onClick={() => setMcpAdvancedOpen((value) => !value)}
                      >
                        <strong>高级选项</strong>
                        <span aria-hidden="true">{mcpAdvancedOpen ? "⌃" : "⌄"}</span>
                      </button>
                      {mcpAdvancedOpen ? (
                        <div className="webui-plugin-form webui-mcp-advanced-fields">
                          <label>
                            超时（毫秒）
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={mcpTimeoutMs}
                              onChange={(event) => setMcpTimeoutMs(event.currentTarget.value)}
                              placeholder="使用默认值"
                            />
                          </label>
                          {mcpTransport === "stdio" ? (
                            <label className="wide">
                              环境变量（JSON）
                              <textarea
                                value={mcpEnv}
                                onChange={(event) => setMcpEnv(event.currentTarget.value)}
                                spellCheck={false}
                                placeholder={'{\n  "API_KEY": "your-key"\n}'}
                              />
                            </label>
                          ) : (
                            <label className="wide">
                              请求头（JSON）
                              <textarea
                                value={mcpHeaders}
                                onChange={(event) => setMcpHeaders(event.currentTarget.value)}
                                spellCheck={false}
                                placeholder={'{\n  "Authorization": "Bearer ..."\n}'}
                              />
                            </label>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </>
            ) : dialog === "skill" ? (
              <div className="webui-plugin-form">
                <label>
                  名称
                  <input
                    value={agentName}
                    onChange={(event) =>
                      setAgentName(event.currentTarget.value)
                    }
                    placeholder="my-skill"
                  />
                </label>
                <label className="wide">
                  描述
                  <input
                    value={skillDescription}
                    onChange={(event) =>
                      setSkillDescription(event.currentTarget.value)
                    }
                  />
                </label>
                <label className="wide">
                  技能内容
                  <textarea
                    value={skillContent}
                    onChange={(event) =>
                      setSkillContent(event.currentTarget.value)
                    }
                    placeholder="编写技能指令"
                  />
                </label>
              </div>
            ) : (
              <div className="webui-plugin-form">
                <label>
                  名称
                  <input
                    value={agentName}
                    onChange={(event) =>
                      setAgentName(event.currentTarget.value)
                    }
                    placeholder="my-agent"
                  />
                </label>
                <label className="wide">
                  介绍
                  <input
                    value={agentDescription}
                    onChange={(event) =>
                      setAgentDescription(event.currentTarget.value)
                    }
                  />
                </label>
                {!editing ? (
                  <label className="wide">
                    模型 ID
                    <input
                      value={agentModel}
                      onChange={(event) =>
                        setAgentModel(event.currentTarget.value)
                      }
                      placeholder="provider/model-name"
                    />
                  </label>
                ) : null}
                <label className="wide">
                  系统提示词
                  <textarea
                    value={agentPrompt}
                    onChange={(event) =>
                      setAgentPrompt(event.currentTarget.value)
                    }
                    placeholder="输入系统提示词"
                  />
                </label>
              </div>
            )}
            <footer>
              <button onClick={() => setDialog(null)}>取消</button>
              <button
                disabled={
                  busy ||
                  (dialog === "mcp"
                    ? !mcpJsonMode &&
                      (!mcpName.trim() ||
                        (mcpTransport === "stdio"
                          ? !mcpCommand.trim()
                          : !mcpUrl.trim()))
                    : dialog === "skill"
                      ? !agentName.trim() || !skillContent.trim()
                      : !agentName.trim())
                }
                onClick={() =>
                  void (dialog === "mcp"
                    ? saveMcp()
                    : dialog === "skill"
                      ? saveSkill()
                      : saveAgent())
                }
              >
                {dialog === "mcp" && !editing ? "添加服务器" : "保存"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {pluginImportDialog ? (
        <div
          className="webui-plugin-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setPluginImportDialog(false);
          }}
        >
          <section
            className="webui-plugin-dialog webui-plugin-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-import-title"
          >
            <header>
              <div>
                <h2 id="plugin-import-title">从 Git 仓库导入插件</h2>
                <p>输入 GitHub 插件仓库或子目录 URL</p>
              </div>
              <button
                onClick={() => setPluginImportDialog(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </header>
            <div className="webui-plugin-form webui-plugin-import-body">
              <label className="wide">
                仓库 URL
                <input
                  aria-label="仓库 URL"
                  value={pluginUrl}
                  onChange={(event) => {
                    setPluginUrl(event.currentTarget.value);
                    setPluginPreview(undefined);
                  }}
                  placeholder="https://github.com/owner/repository"
                />
              </label>
              {pluginPreview ? (
                <div className="webui-plugin-import-preview">
                  <strong>
                    {read(
                      ((pluginPreview.plugin as Row)?.summary as Row) || {},
                      "displayName",
                      "name",
                    )}
                  </strong>
                  <p>
                    {read(
                      ((pluginPreview.plugin as Row)?.summary as Row) || {},
                      "description",
                    )}
                  </p>
                  <span>
                    技能{" "}
                    {String((pluginPreview.plugin as Row)?.skillCount ?? 0)} ·
                    MCP{" "}
                    {String((pluginPreview.plugin as Row)?.mcpServerCount ?? 0)}
                  </span>
                  {pluginPreview.canImport !== true ? (
                    <ul className="webui-plugin-diagnostics" role="status">
                      {Array.isArray(pluginPreview.diagnostics) &&
                      pluginPreview.diagnostics.length > 0 ? (
                        (pluginPreview.diagnostics as Row[]).map(
                          (diagnostic, index) => (
                            <li key={`${read(diagnostic, "code")}-${index}`}>
                              {[
                                read(diagnostic, "code"),
                                read(diagnostic, "capability", "name"),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </li>
                          ),
                        )
                      ) : (
                        <li>当前插件包还不能导入，请检查仓库内容后重试。</li>
                      )}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
            {error ? (
              <p role="alert" className="webui-plugin-error">
                {error}
              </p>
            ) : null}
            <footer>
              <button onClick={() => setPluginImportDialog(false)}>取消</button>
              {pluginPreview ? (
                <button
                  disabled={busy || pluginPreview.canImport !== true}
                  onClick={() => void importPlugin()}
                >
                  导入插件
                </button>
              ) : (
                <button
                  disabled={busy || !pluginUrl.trim()}
                  onClick={() => void previewPlugin()}
                >
                  预览
                </button>
              )}
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
