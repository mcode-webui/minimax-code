// The marketplace is one catalogue per kind of thing.
//
// It used to be a single page: a 市场/个人 header toggle, a plugin grid, and the
// marketplace's skills appended below it in their own `技能` section — fetched
// as a side payload (`skillLimit: 8`) of the plugin listing. One list to
// scroll, one search box labelled 「搜索插件或技能」 narrowing two different
// result sets. The header toggle is now 插件 / 技能, and each tab owns its page.
//
// Market/personal did not disappear with it: that is the 管理 view, whose own
// header keeps the pair, and it is still how you reach what is installed.
//
// No DOM framework is allowed in this package, so the two marketplace branches
// are asserted through `renderToStaticMarkup` — `initialArea` is the only prop
// that reaches the catalogue, and it is enough to render either one. The
// managing header and the fetch paths are effects SSR never runs; those are
// pinned by reading the source, the same way `webui-shell.test.ts` does.
//
// The split was never meant to leave the two pages looking different: they are
// two catalogues of one page, so they share a layout. SSR cannot observe that
// shared layout — with no effect run there is no data, and an empty list
// renders 「暂无内容」 instead of the grid — so the layout contract itself is
// pinned by reading the component, and the two render branches are pinned by
// SSR. See 「marketplace page layout parity」 below.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { PluginManagement } from "../../src/client/components/PluginManagement.js";
import type { WebuiTransport } from "../../src/client/contracts/transport.js";

const transport = {
  pluginManagement: async () => ({ plugins: [] }),
} as unknown as WebuiTransport;

const marketplace = (initialArea: "plugins" | "skills"): string =>
  renderToStaticMarkup(
    createElement(PluginManagement, {
      transport,
      initialArea,
    }),
  );

const component = readFileSync(
  new URL("../../src/client/components/PluginManagement.tsx", import.meta.url),
  "utf8",
);
// The listing composition — the skill-hub paging and its unknowable total —
// moved into the application plugin owner (ticket #52). The two assertions
// below pin that behaviour where it now lives, with the same intent.
const owner = readFileSync(
  new URL("../../src/client/application/plugin-workflows.ts", import.meta.url),
  "utf8",
);

describe("plugin marketplace catalogue", () => {
  it("offers 插件 and 技能 instead of 市场 and 个人", () => {
    const html = marketplace("plugins");
    expect(html).toContain('aria-pressed="true">插件</button>');
    expect(html).toContain(">技能</button>");
    // The pair the split was asked for: gone from the marketplace header.
    expect(html).not.toContain(">市场</button>");
    expect(html).not.toContain(">个人</button>");
  });

  it("keeps plugins and skills on separate pages", () => {
    const plugins = marketplace("plugins");
    const skills = marketplace("skills");
    // Each tab marks its own page, and the plugin page no longer appends the
    // skill grid below the plugin grid.
    expect(plugins).toContain('aria-pressed="true">插件</button>');
    expect(plugins).not.toContain('aria-pressed="true">技能</button>');
    expect(skills).toContain('aria-pressed="true">技能</button>');
    expect(skills).not.toContain('aria-pressed="true">插件</button>');
    expect(plugins).not.toContain("webui-plugin-market-skill-grid");
    expect(skills).not.toContain("webui-plugin-market-skill-grid");
  });

  it("narrows the plugin page by category and the skill page by search alone", () => {
    const plugins = marketplace("plugins");
    const skills = marketplace("skills");
    // The marketplace categories are the plugin catalogue's; a skill hub has
    // no such axis, so the nav is withheld rather than shown inert.
    expect(plugins).toContain("市场分类");
    expect(skills).not.toContain("市场分类");
    expect(plugins).toContain('placeholder="搜索插件..."');
    expect(skills).toContain('placeholder="搜索技能..."');
  });

  it("labels each page for what it lists", () => {
    expect(marketplace("plugins")).toContain(">插件</h2>");
    expect(marketplace("skills")).toContain(">技能</h2>");
  });
});

// 技能 used to be laid out as a management list while 插件 got the marketplace
// treatment: a single-column stack of 84px rows with hairline dividers and 50px
// icons, capped at 960px, with no 「查看全部」 at all. `webui-plugin-grid` — the
// two-column 768px card grid, 58px rows, 40px icons — was gated on
// `area === "plugins" && view === "market"`, so the skill tab inherited none of
// it. One condition now decides "this is a marketplace page", and every layout
// consequence hangs off that single condition rather than off the plugin area.
describe("marketplace page layout parity", () => {
  it("keys the card grid off the catalogue, not the plugin area", () => {
    // The regression in one assertion: re-gating the grid on the plugin area
    // would put 技能 back into the divided list while this file still passes
    // every other check.
    expect(component).toMatch(
      /const isMarketCatalogue\s*=\s*\(area === "plugins" \|\| area === "skills"\) && view === "market";/,
    );
    expect(component).toContain(
      'className={`webui-plugin-list ${isMarketCatalogue ? "webui-plugin-grid" : ""}`}',
    );
  });

  it("previews the same number of cards on both pages", () => {
    expect(component).toContain("const MARKET_PREVIEW_COUNT = 8;");
    expect(component).toMatch(
      /isMarketCatalogue && !showAllCatalogue\s*\?\s*filtered\.slice\(0, MARKET_PREVIEW_COUNT\)/,
    );
  });

  it("offers the same expand affordance on both pages", () => {
    // SSR cannot reach this control: no effect runs, so there is no data and no
    // total. The wiring is pinned by reading the component, as above.
    expect(component).toContain(
      "!busy && isMarketCatalogue && visibleMarketTotal > MARKET_PREVIEW_COUNT",
    );
    // The label names the catalogue rather than being hard-coded to plugins,
    // so 技能 reads 「查看全部技能」 / 「收起技能」 instead of 「收起插件」.
    expect(component).toContain("`收起${marketNoun}`");
    expect(component).toContain(
      'const marketNoun = area === "skills" ? "技能" : "插件";',
    );
    expect(component).toContain("`查看全部 ${marketTotal} 个`");
  });

  it("does not state a skill count the hub cannot supply", () => {
    // `listSkillHub` returns `{skills, hasMore, nextCursor}` — there is no
    // `pluginTotal` equivalent. When the page came back truncated the total is
    // unknowable, so the label drops the number rather than claiming "查看全部
    // 100 个" for an arbitrarily capped fetch.
    expect(owner).toContain("(result as Record<string, unknown>).hasMore === true");
    expect(component).toMatch(
      /marketTotal === null\s*\?\s*`查看全部\$\{marketNoun\}`/,
    );
    // …and the control is still offered on the strength of what is in hand, so
    // a truncated listing is not silently stuck at the preview.
    expect(component).toContain("const visibleMarketTotal = marketTotal ?? filtered.length;");
  });

  it("restores the full catalogue when the selected catalogue changes", () => {
    // The marketplace now starts expanded. Switching between 插件 and 技能
    // restores that default even when the current page was explicitly collapsed.
    //
    // The class is `[^}]`, not `[\s\S]`: an unbounded lazy match runs straight
    // past this function's closing brace and finds the same setter in the
    // category-filter and search handlers further down, so the assertion would
    // pass with the reset deleted. `[^}]` cannot cross a brace, so the setter
    // has to be inside the body.
    expect(component).toMatch(
      /const selectMarketCatalog = \(catalog: "plugins" \| "skills"\) => \{[^}]*setShowAllCatalogue\(true\);/,
    );
  });
});

describe("plugin marketplace data paths", () => {
  it("stops asking the plugin listing for a skills side payload", () => {
    // `skillLimit` existed only to feed the embedded grid. The skill catalogue
    // has its own operation, so the plugin request no longer carries it.
    expect(component).not.toContain("skillLimit");
    expect(component).not.toContain("marketSkills");
    expect(owner).toContain('call("listSkillHub"');
  });

  it("clears the plugin category filter when the catalogue changes", () => {
    // The categories cannot narrow the skill list, so carrying one over would
    // leave a filter applied to a list it does not describe.
    //
    // `[^}]` rather than `[\s\S]` so the match is bounded by this function's
    // body: an unbounded lazy match would satisfy itself from any later
    // `setCategory("")` added to the file. There is only one today, which is
    // exactly why this is a tightening and not a bug fix.
    expect(component).toMatch(
      /const selectMarketCatalog = \(catalog: "plugins" \| "skills"\) => \{[^}]*setCategory\(""\);/,
    );
  });

  it("keeps a way into what is installed from the marketplace header", () => {
    // What is installed used to be the 个人 half of a 市场/个人 tab pair. That
    // pair is gone: the header now carries the 插件/技能 catalogue pair plus a
    // single 管理 entry that opens the management view (`managementOpen` +
    // `view: "personal"`). The point this assertion protects is unchanged —
    // the installed view stays reachable from the marketplace header rather
    // than being deleted — but the control is an entry button, not a pressed
    // tab, so it has no `aria-pressed`.
    //
    // Bound the header at marketplace discovery, after both the 管理 branch
    // and catalogue branch. The create-menu trigger belongs to the management
    // branch now, so it cannot serve as the boundary for this source assertion.
    const headerStart = component.indexOf(
      '<div className="webui-plugin-header-inner">',
    );
    const marketplaceContentStart = component.indexOf(
      'className="webui-plugin-market-discovery"',
      headerStart,
    );
    expect(headerStart).toBeGreaterThanOrEqual(0);
    expect(marketplaceContentStart).toBeGreaterThan(headerStart);
    const managingHeader = component.slice(
      headerStart,
      marketplaceContentStart,
    );
    // The marketplace branch in the same span is the catalogue pair.
    expect(managingHeader).toContain('onClick={() => selectMarketCatalog("plugins")}');
    expect(managingHeader).toContain('onClick={() => selectMarketCatalog("skills")}');
    // The 管理 entry is what actually opens the installed view.
    expect(managingHeader).toMatch(/>\s*管理\s*<\/button>/);
    expect(managingHeader).toContain("setManagementOpen(true)");
    expect(managingHeader).toContain('setView("personal")');
  });
});
