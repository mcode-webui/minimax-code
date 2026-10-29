import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { IconPlus, IconSettings } from "@tabler/icons-react";
import { InstalledPluginSource } from "@mavis/protocol/local";
import {
  useWebuiPluginWorkflows,
  useWebuiPluginWorkflowsState,
} from "../../../bindings/use-query-state.js";
import { WebuiIconAgent } from "../../../shell/icons.js";
import { WebuiDropdown } from "../../../ui/Dropdown.js";
import {
  readWebuiPluginRow as read,
  type WebuiPluginRow as Row,
} from "../contracts/plugin-rows.js";
import { PluginImportDialog } from "./PluginImportDialog.js";
import { PluginItemDialog } from "./PluginItemDialog.js";
import { projectWebuiPluginCatalogue } from "../projection/catalogue-view.js";
import {
  PluginMarketplace,
  PluginMarketplaceFilters,
} from "./PluginMarketplace.js";
import {
  PluginManagementFilters,
  PluginManagementList,
} from "./PluginManagementList.js";
import type {
  WebuiPluginGithubSource,
  WebuiPluginIntent,
} from "../contracts/plugin-actions.js";
import { MiniAppAppsList } from "../../miniapp/ui/MiniAppAppsList.public.js";
import { useWebuiMiniAppCatalogueSummary } from "../../miniapp/bindings/use-miniapp-catalogue.public.js";

type Area = "plugins" | "skills" | "apps" | "mcp" | "agents";
type PluginCatalogueSelection = {
  readonly area: Area;
  readonly view: "market" | "personal";
  readonly query: string;
  readonly category: string;
};
type PluginDetailIdentity = {
  readonly kind: "mcp-server";
  readonly name: string;
  readonly selection: PluginCatalogueSelection;
  readonly attachment: number;
};
type PluginPreviewIdentity = {
  readonly kind: "github-import-preview";
  readonly url: string;
  readonly attachment: number;
  readonly request: number;
};
const sameSelection = (
  left: PluginCatalogueSelection,
  right: PluginCatalogueSelection,
): boolean =>
  left.area === right.area &&
  left.view === right.view &&
  left.query === right.query &&
  left.category === right.category;

export function PluginCatalogue({
  initialArea = "plugins",
  onChatWithAgent,
  selectedSessionId,
}: {
  readonly initialArea?: Area;
  readonly onChatWithAgent?: (name: string) => Promise<void>;
  readonly selectedSessionId?: string;
}): ReactElement {
  const [area, setArea] = useState<Area>(initialArea);
  const [view, setView] = useState<"market" | "personal">("market");
  const [managementOpen, setManagementOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const selectionRef = useRef<PluginCatalogueSelection>({
    area,
    view,
    query,
    category,
  });
  selectionRef.current = { area, view, query, category };
  const dialogAttachmentRef = useRef(0);
  const pluginPreviewRequestRef = useRef(0);
  const [showAllCatalogue, setShowAllCatalogue] = useState(true);
  /* Local form-level messages only. A load or mutation failure belongs to the
   * application plugin owner and is read from its snapshot. */
  const [localError, setLocalError] = useState("");
  const [dialog, setDialog] = useState<"mcp" | "agent" | "skill" | null>(null);
  const [editing, setEditing] = useState<Row | undefined>();
  const [selectedAgent, setSelectedAgent] = useState<Row | undefined>();
  const [pluginUrl, setPluginUrl] = useState("");
  const [pluginPreview, setPluginPreview] = useState<Row | undefined>();
  const [pluginImportDialog, setPluginImportDialog] = useState(false);

  const attachItemDialog = (): number => {
    dialogAttachmentRef.current += 1;
    return dialogAttachmentRef.current;
  };
  const detachItemDialog = (): void => {
    dialogAttachmentRef.current += 1;
    setDialog(null);
  };
  const attachPluginImportDialog = (): number => {
    dialogAttachmentRef.current += 1;
    pluginPreviewRequestRef.current += 1;
    return dialogAttachmentRef.current;
  };
  const detachPluginImportDialog = (): void => {
    dialogAttachmentRef.current += 1;
    pluginPreviewRequestRef.current += 1;
    setPluginImportDialog(false);
  };

  // The plugin manager's listings and mutations belong to the application
  // plugin owner. This component submits named intents and reads
  // the snapshot; only detail/preview attachment identities stay local so a
  // late answer cannot populate a replacement dialog.
  const workflows = useWebuiPluginWorkflows();
  const snapshot = useWebuiPluginWorkflowsState();
  const miniAppCatalogue = useWebuiMiniAppCatalogueSummary();
  const listing = snapshot.listing;
  const data = listing.rows;
  const marketPluginTotal = listing.pluginTotal ?? 0;
  /* The skill hub reports `hasMore`/`nextCursor` where the plugin marketplace
   * reports a `pluginTotal`, so a skill count is only known to be exact when the
   * listing came back complete. `null` means "the total is not knowable from
   * this response" and the label falls back to a bare 「查看全部技能」. */
  const marketSkillTotal = listing.skillTotal ?? null;
  const tagDefinitions = listing.tagDefinitions ?? [];
  const selectedTag = category.startsWith("tag:")
    ? tagDefinitions.find((tag) => `tag:${tag.key}` === category)
    : undefined;
  const busy = listing.loading || (area !== "apps" && snapshot.mutating);
  const error = localError || snapshot.mutationError || listing.error || "";
  const reload = async (): Promise<void> => {
    if (area === "apps") {
      await Promise.all([
        workflows?.loadListing({ area: "plugins", view: "personal", query, category: "" }),
        miniAppCatalogue.refresh(),
      ]);
    } else await workflows?.loadListing({ area, view, query, category });
  };
  useEffect(() => {
    if (area === "apps") {
      void workflows?.loadListing({ area: "plugins", view: "personal", query, category: "" });
      return;
    }
    void workflows?.loadListing({ area, view, query, category });
  }, [area, view, query, category, workflows]);
  const catalogueView = useMemo(
    () =>
      projectWebuiPluginCatalogue({
        data,
        query,
        area,
        view,
        pluginTotal: marketPluginTotal,
        skillTotal: marketSkillTotal,
      }),
    [area, data, marketPluginTotal, marketSkillTotal, query, view],
  );
  const filtered = useMemo(
    () => catalogueView.rows.map((row) => row.source),
    [catalogueView.rows],
  );
  const installedMiniApps = useMemo(
    () => catalogueView.rows.filter((row) =>
      Array.isArray(row.source.tags) && row.source.tags.some((tag: unknown) =>
        !!tag && typeof tag === "object" && (tag as { key?: unknown }).key === "miniapp")),
    [catalogueView.rows],
  );
  /* Plugins and skills are two catalogues rendered by one page, so they share
   * every layout decision. `isMarketCatalogue` is the single condition that
   * says "this is the marketplace page rather than a management list" — the
   * two-column card grid, the shared 768px measure and the 「查看全部」 preview
   * are all keyed off it, which is what keeps 技能 laid out exactly like 插件. */
  const { isMarketCatalogue, marketNoun, marketTotal } = catalogueView;
  // When the total is unknown the affordance is still offered once the fetched
  // page itself overflows the preview, so the control is never gated on a
  // number this response could not supply.
  const visibleMarketTotal = catalogueView.visibleMarketTotal;
  const mutate = async (intent: WebuiPluginIntent): Promise<boolean> => {
    try {
      if (!workflows)
        throw new Error("Plugin management is not connected to the runtime");
      await workflows.runIntent(intent);
      return true;
    } catch {
      // The owner records the failure and reloads; this only reports it.
      return false;
    }
  };
  const confirmMutation = (label: string, intent: WebuiPluginIntent) => {
    if (window.confirm(`确定${label}？此操作会立即影响本地配置。`))
      void mutate(intent);
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
  const chatWithAgent = async (agent: Row) => {
    if (!onChatWithAgent) return;
    try {
      await onChatWithAgent(nameOf(agent));
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  /**
   * Open the MCP form for one server.
   *
   * The row's list entry carries a summary; the form needs the server's full
   * config, so a detail read runs first. A failed read is reported and the form
   * stays closed — showing a half-populated form would look like the server has
   * no command or url.
   */
  const prepareMcp = async (item: Row) => {
    const identity: PluginDetailIdentity = {
      kind: "mcp-server",
      name: nameOf(item),
      selection: selectionRef.current,
      attachment: attachItemDialog(),
    };
    const isAttached = (): boolean =>
      identity.kind === "mcp-server" &&
      identity.attachment === dialogAttachmentRef.current &&
      sameSelection(identity.selection, selectionRef.current);
    try {
      const detail = await workflows?.getMcpServer(identity.name);
      if (!isAttached()) return;
      setEditing((detail && typeof detail === "object" ? detail : item) as Row);
    } catch (cause) {
      if (isAttached())
        setLocalError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (isAttached()) setDialog("mcp");
  };
  const previewPlugin = async () => {
    const identity: PluginPreviewIdentity = {
      kind: "github-import-preview",
      url: pluginUrl.trim(),
      attachment: dialogAttachmentRef.current,
      request: ++pluginPreviewRequestRef.current,
    };
    const isAttached = (): boolean =>
      identity.kind === "github-import-preview" &&
      identity.attachment === dialogAttachmentRef.current &&
      identity.request === pluginPreviewRequestRef.current &&
      pluginUrl.trim() === identity.url &&
      pluginImportDialog;
    try {
      setLocalError("");
      const result = await workflows?.previewGithubPlugin({
        url: identity.url,
      });
      if (!isAttached()) return;
      setPluginPreview(result as Row);
    } catch (cause) {
      if (isAttached())
        setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const importPlugin = async () => {
    const source = pluginPreview?.source;
    if (!source || typeof source !== "object") return;
    const attachment = dialogAttachmentRef.current;
    if (
      await mutate({
        kind: "importGithubPlugin",
        source: source as WebuiPluginGithubSource,
      })
    ) {
      if (attachment !== dialogAttachmentRef.current) return;
      detachPluginImportDialog();
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
    attachItemDialog();
    setArea(target);
    setView("personal");
    setManagementOpen(true);
    setCreateMenuOpen(false);
    // Opening a form is now just: no item, show this form. The drafts seed
    // themselves from `editing`, so there is nothing to clear here beyond the
    // item the previous form may have been editing.
    setEditing(undefined);
    setDialog(
      target === "mcp" ? "mcp" : target === "agents" ? "agent" : "skill",
    );
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
              <WebuiDropdown
                open={createMenuOpen}
                onOpen={() => setCreateMenuOpen(true)}
                onClose={() => setCreateMenuOpen(false)}
                role="menu"
                ariaLabel="创建"
                wrapperClassName="webui-plugin-create-anchor webui-plugin-management-create-anchor"
                className="webui-plugin-create-menu"
                // The menu hung off the anchor's right edge (`right: 0`).
                align="end"
                trigger={(triggerProps) => { const { ref, ...rest } = triggerProps; return (
                  <button
                    type="button"
                    {...rest}
                    ref={ref}
                    className="webui-plugin-create-trigger"
                  >
                    ＋ 创建
                  </button>
                ); }}
              >
                <button
                  onClick={() => {
                    attachPluginImportDialog();
                    setPluginImportDialog(true);
                    setCreateMenuOpen(false);
                    setPluginUrl("");
                    setPluginPreview(undefined);
                  }}
                >
                  从 Git 仓库导入插件
                </button>
                <button onClick={() => openCreate("skills")}>
                  录入技能
                </button>
                <button onClick={() => openCreate("mcp")}>
                  添加 MCP server
                </button>
                <button onClick={() => openCreate("agents")}>
                  创建 Agent
                </button>
              </WebuiDropdown>
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
                  <IconSettings aria-hidden="true" size={18} stroke={1.7} />
                  管理
                </button>
              </div>
            </>
          )}
        </div>
        {isMarketCatalogue && (area === "plugins" || area === "skills") ? (
          <PluginMarketplaceFilters
            area={area}
            query={query}
            category={category}
            tagDefinitions={tagDefinitions}
            onQueryChange={setQuery}
            onCategoryChange={setCategory}
          />
        ) : null}
        {managementOpen ? (
          <PluginManagementFilters
            area={area}
            query={query}
            rowCount={area === "apps" ? installedMiniApps.length : data.length}
            onAreaChange={(nextArea) => {
              setLocalError("");
              setArea(nextArea);
              setView("personal");
            }}
            onQueryChange={setQuery}
          />
        ) : null}
      </header>
      {isMarketCatalogue ? (
        <h2 className="webui-plugin-market-heading">{selectedTag?.displayName ?? marketNoun}</h2>
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
                onClick={() => {
                  attachItemDialog();
                  setEditing(item);
                  setSelectedAgent(item);
                  setDialog("agent");
                }}
              >
                <span className="webui-agent-avatar webui-agent-avatar--small">
                  {read(item, "avatarDataUrl").startsWith("data:image/") ? (
                    <img src={read(item, "avatarDataUrl")} alt="" />
                  ) : (
                    <WebuiIconAgent className="webui-agent-avatar-icon webui-agent-avatar-icon--small" />
                  )}
                </span>
                <span>
                  {read(item, "displayName", "display_name") || nameOf(item)}
                </span>
              </button>
            ))}
            <button
              className="webui-agent-create"
              type="button"
              onClick={() => {
                attachItemDialog();
                setEditing(undefined);
                setDialog("agent");
              }}
            >
              <IconPlus aria-hidden="true" size={16} stroke={1.7} /> 创建 Agent
            </button>
          </div>
          {/*
            The agent detail is a view, not a second editor. It used to carry
            its own name/model/prompt fields — a second copy of the same draft
            the dialog owns — and the two could disagree, because saving one left
            the other showing stale values. What it shows now it reads from the
            row; the draft lives in `AgentForm`, once.
          */}
          <div className="webui-agent-detail">
            <div className="webui-agent-fields">
              <label className="webui-agent-avatar-field">
                头像
                <span className="webui-agent-avatar webui-agent-avatar--large">
                  {read(selectedAgent ?? {}, "avatarDataUrl").startsWith(
                    "data:image/",
                  ) ? (
                    <img
                      src={read(selectedAgent ?? {}, "avatarDataUrl")}
                      alt="Agent 头像"
                    />
                  ) : (
                    <WebuiIconAgent className="webui-agent-avatar-icon webui-agent-avatar-icon--large" />
                  )}
                </span>
              </label>
              <label>
                名称
                <span data-testid="webui-agent-detail-name">
                  {read(
                    selectedAgent ?? {},
                    "name",
                    "displayName",
                    "display_name",
                  )}
                </span>
              </label>
              <label className="webui-agent-model-field">
                模型
                <span data-testid="webui-agent-detail-model">
                  {read(selectedAgent ?? {}, "model") || "—"}
                </span>
              </label>
              <label>
                描述
                <span data-testid="webui-agent-detail-description">
                  {read(selectedAgent ?? {}, "description") || "—"}
                </span>
              </label>
              <label>
                系统提示词
                <span data-testid="webui-agent-detail-prompt">
                  {read(selectedAgent ?? {}, "systemPrompt", "system_prompt")}
                </span>
              </label>
              <div className="webui-agent-actions">
                {selectedAgent ? (
                  <button
                    type="button"
                    className="webui-agent-delete"
                    onClick={() =>
                      confirmMutation("删除 Agent", {
                        kind: "deleteAgent",
                        name: nameOf(selectedAgent),
                      })
                    }
                  >
                    删除
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className="webui-agent-save"
                  disabled={busy || !selectedAgent}
                  onClick={() => {
                    attachItemDialog();
                    setEditing(selectedAgent);
                    setDialog("agent");
                  }}
                >
                  编辑
                </button>
                {selectedAgent && onChatWithAgent ? (
                  <button
                    type="button"
                    className="webui-agent-chat"
                    disabled={busy}
                    onClick={() => void chatWithAgent(selectedAgent)}
                  >
                    和他对话
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : isMarketCatalogue && (area === "plugins" || area === "skills") ? (
        <>
          <PluginMarketplace
            area={area}
            rows={catalogueView.rows}
            marketTotal={marketTotal}
            visibleMarketTotal={visibleMarketTotal}
            showAll={showAllCatalogue}
            onToggleAll={() => setShowAllCatalogue((value) => !value)}
            onIntent={(intent) => void mutate(intent)}
          />
          {area === "plugins" && !category && tagDefinitions.map((tag) => {
            const taggedRows = catalogueView.rows.filter((row) =>
              Array.isArray(row.source.tags) && row.source.tags.some((entry: unknown) =>
                !!entry && typeof entry === "object" && (entry as { key?: unknown }).key === tag.key));
            return taggedRows.length ? (
              <section key={tag.key} aria-label={tag.displayName}>
                <h2 className="webui-plugin-market-heading">{tag.displayName}</h2>
                <PluginMarketplace
                  area="plugins"
                  rows={taggedRows}
                  marketTotal={taggedRows.length}
                  visibleMarketTotal={taggedRows.length}
                  showAll
                  onToggleAll={() => {}}
                  hideToggle
                  onIntent={(intent) => void mutate(intent)}
                />
              </section>
            ) : null;
          })}
        </>
      ) : area === "apps" ? (
        /* The installed plugin catalogue supplies Mini App identity and icons;
           the Mini App business supplies runtime state and lifecycle actions. */
        <MiniAppAppsList
          selectedSessionId={selectedSessionId}
          installedPlugins={installedMiniApps}
          query={query}
        />
      ) : (
        <PluginManagementList
          area={area}
          rows={catalogueView.rows}
          onMutate={(intent) => void mutate(intent)}
          onConfirmMutation={confirmMutation}
          onPrepareMcp={(item) => void prepareMcp(item)}
        />
      )}
      {dialog ? (
        <PluginItemDialog
          dialog={dialog}
          editing={editing}
          onSubmit={mutate}
          {...(onChatWithAgent ? { onChatWithAgent } : {})}
          onClose={detachItemDialog}
        />
      ) : null}
      {pluginImportDialog ? (
        <PluginImportDialog
          url={pluginUrl}
          onUrlChange={(value) => {
            attachPluginImportDialog();
            setPluginUrl(value);
            setPluginPreview(undefined);
          }}
          preview={pluginPreview}
          error={error}
          busy={busy}
          onPreview={() => void previewPlugin()}
          onImport={() => void importPlugin()}
          onClose={detachPluginImportDialog}
        />
      ) : null}
    </section>
  );
}
