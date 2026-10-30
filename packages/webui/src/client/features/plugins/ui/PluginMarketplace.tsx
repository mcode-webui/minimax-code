import type { ReactElement } from "react";
import { IconFileCode, IconSearch } from "@tabler/icons-react";
import type { WebuiPluginCatalogueRow } from "../projection/catalogue-view.js";
import type { WebuiPluginIntent } from "../contracts/plugin-actions.js";
import { readWebuiPluginRow as read } from "../contracts/plugin-rows.js";
import { FeedbackEmpty } from "../../../ui/feedback.js";

const MARKET_PREVIEW_COUNT = 8;
const MINIAPP_CATEGORY = { id: "tag:miniapp", label: "Mini App" } as const;
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

export function PluginMarketplaceFilters({
  area,
  query,
  category,
  tagDefinitions,
  onQueryChange,
  onCategoryChange,
}: {
  readonly area: "plugins" | "skills";
  readonly query: string;
  readonly category: string;
  readonly tagDefinitions: readonly { key: string; displayName: string }[];
  readonly onQueryChange: (query: string) => void;
  readonly onCategoryChange: (category: string) => void;
}): ReactElement {
  const noun = area === "skills" ? "技能" : "插件";
  return (
    <div className="webui-plugin-market-discovery">
      {area === "plugins" ? (
        <nav className="webui-plugin-category-filter" aria-label="市场分类">
          {[
            categories[0],
            MINIAPP_CATEGORY,
            ...tagDefinitions
              .filter((tag) => tag.key !== "miniapp")
              .map((tag) => ({ id: `tag:${tag.key}`, label: tag.displayName })),
            ...categories.slice(1),
          ].map((item) => (
            <button
              key={item.id}
              aria-pressed={category === item.id}
              onClick={() => onCategoryChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      ) : null}
      <label className="webui-plugin-market-search">
        <IconSearch aria-hidden="true" size={18} stroke={1.5} />
        <input
          aria-label={`搜索${noun}`}
          placeholder={`搜索${noun}...`}
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
      </label>
    </div>
  );
}
export function PluginMarketplace({
  area,
  rows,
  marketTotal,
  visibleMarketTotal,
  showAll,
  onToggleAll,
  onIntent,
  hideToggle = false,
}: {
  readonly area: "plugins" | "skills";
  readonly rows: readonly WebuiPluginCatalogueRow[];
  readonly marketTotal: number | null;
  readonly visibleMarketTotal: number;
  readonly showAll: boolean;
  readonly onToggleAll: () => void;
  readonly onIntent: (intent: WebuiPluginIntent) => void;
  readonly hideToggle?: boolean;
}): ReactElement {
  const noun = area === "skills" ? "技能" : "插件";
  return (
    <>
      {rows.length === 0 ? (
        <FeedbackEmpty title="暂无内容" />
      ) : (
        <div className="webui-plugin-list webui-plugin-grid">
          {(showAll ? rows : rows.slice(0, MARKET_PREVIEW_COUNT)).map(
            (row, index) => {
              const item = row.source;
              const name = row.name || `item-${index}`;
              const pluginIntent = (
                kind: "installPlugin" | "enablePlugin" | "disablePlugin",
              ): WebuiPluginIntent => ({
                kind,
                pluginName: name,
                ...(row.pluginSource === undefined
                  ? {}
                  : { source: row.pluginSource }),
              });
              return (
                <article className="webui-plugin-row" key={`${area}-${name}`}>
                  <div
                    className={`webui-plugin-icon${area === "skills" ? " webui-plugin-icon--skill" : ""}`}
                    aria-hidden="true"
                  >
                    {area === "skills" ? (
                      <span className="webui-plugin-skill-icon-tile">
                        <IconFileCode aria-hidden="true" size={22} stroke={1.5} />
                      </span>
                    ) : row.iconUrl ? (
                      <>
                        <img
                          src={row.iconUrl}
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
                    ) : (
                      "▦"
                    )}
                  </div>
                  <div className="webui-plugin-copy">
                    <h2>{read(item, "displayName", "display_name") || name}</h2>
                    <p>{row.description || read(item, "transport")}</p>
                  </div>
                  {area === "plugins" ? (
                    <button
                      type="button"
                      disabled={item.installed === true}
                      onClick={() => onIntent(pluginIntent("installPlugin"))}
                    >
                      {item.installed === true ? "已安装" : "安装"}
                    </button>
                  ) : (
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
                        onIntent({
                          kind: "installSkill",
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
                          ...(row.creatorInfo
                            ? { creatorInfo: row.creatorInfo }
                            : {}),
                        })
                      }
                    >
                      {item.added === true ? "已添加" : "添加"}
                    </button>
                  )}
                </article>
              );
            },
          )}
        </div>
      )}
      {!hideToggle && visibleMarketTotal > MARKET_PREVIEW_COUNT ? (
        <button
          type="button"
          className="webui-plugin-show-all"
          onClick={onToggleAll}
        >
          {showAll
            ? `收起${noun}`
            : marketTotal === null
              ? `查看全部${noun}`
              : `查看全部 ${marketTotal} 个`}
        </button>
      ) : null}
    </>
  );
}
