/**
 * The 接入 IM pane: projection, owner transitions, and the rendered branches.
 *
 * The claims are asserted where they are made rather than through a browser: the rows' wording,
 * the empty state, the refusal a host without an IM channel service gets, and the sections the
 * runtime has no route behind. Rendering goes through `renderToStaticMarkup` — this package has
 * no jsdom.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createWebuiChannelOwner,
  WEBUI_CHANNEL_UNAVAILABLE,
  type WebuiChannelSnapshot,
} from "../../src/client/features/channel/application/channel-owner.js";
import type { ChannelPort } from "../../src/client/features/channel/contracts/channel-port.js";
import {
  WEBUI_CHANNEL_EMPTY_TEXT,
  WEBUI_CHANNEL_NOT_WIRED,
  WEBUI_CHANNEL_SECTION_DELETE,
  WEBUI_CHANNEL_SECTION_WORKSPACE,
  webuiChannelPlatformLabel,
  webuiChannelRows,
} from "../../src/client/features/channel/projection/channel-panel.js";
import { ChannelConnectPanelView } from "../../src/client/features/channel/ui/ChannelConnectPanel.public.js";
import type { WebuiChannelClient } from "../../src/shared/contracts/channel.js";

function client(overrides: Partial<WebuiChannelClient> = {}): WebuiChannelClient {
  return { name: "mavis", platform: "feishu", agentName: "mavis", ...overrides };
}

function snapshot(overrides: Partial<WebuiChannelSnapshot> = {}): WebuiChannelSnapshot {
  return { status: "ready", clients: [], ...overrides };
}

const noop = (): void => {};

function view(snap: WebuiChannelSnapshot): string {
  // The pure view carries no hooks, so it is called the way the house style calls it: this file
  // is a `.ts` and the package has no JSX transform for one.
  return renderToStaticMarkup(
    ChannelConnectPanelView({
      snapshot: snap,
      onSelect: noop,
      onBind: noop,
      onUnbind: noop,
      onUpdateFilter: noop,
      binding: false,
      onOpenBinding: noop,
      onCloseBinding: noop,
    }),
  );
}

describe("the 接入 IM projection", () => {
  it("names the platforms Desktop names and prints an unknown one as it came", () => {
    expect(webuiChannelPlatformLabel("wechat")).toBe("微信");
    expect(webuiChannelPlatformLabel("feishu")).toBe("飞书");
    expect(webuiChannelPlatformLabel("telegram")).toBe("Telegram");
    expect(webuiChannelPlatformLabel("slack")).toBe("slack");
  });

  it("keys every row by the client's own name and falls back to the default agent", () => {
    const rows = webuiChannelRows(
      [client(), client({ name: "wechat:mavis", platform: "wechat", agentName: undefined })],
      "wechat:mavis",
    );

    expect(rows).toEqual([
      {
        name: "mavis",
        platform: "feishu",
        platformLabel: "飞书",
        agentLabel: "mavis",
        selected: false,
      },
      {
        name: "wechat:mavis",
        platform: "wechat",
        platformLabel: "微信",
        agentLabel: "默认",
        selected: true,
      },
    ]);
  });
});

describe("the 接入 IM owner", () => {
  it("refuses once when the transport carries no IM channel service", async () => {
    const owner = createWebuiChannelOwner({ port: {} });

    await owner.load();

    expect(owner.getSnapshot().status).toBe("error");
    expect(owner.getSnapshot().error).toBe(WEBUI_CHANNEL_UNAVAILABLE);
    // A refusal is not an empty list: the pane must not read as "no IM client is bound".
    expect(owner.getSnapshot().clients).toEqual([]);
  });

  it("reads the bound clients and keeps them when the next read fails", async () => {
    let fail = false;
    const owner = createWebuiChannelOwner({
      port: {
        listChannelStatus: async () => {
          if (fail) throw new Error("the channel service went away");
          return { clients: [client()] };
        },
      },
    });

    await owner.load();
    expect(owner.getSnapshot().status).toBe("ready");
    expect(owner.getSnapshot().clients).toEqual([client()]);

    fail = true;
    await owner.load();
    expect(owner.getSnapshot().status).toBe("error");
    expect(owner.getSnapshot().error).toBe("the channel service went away");
    // The last good rows stay on screen next to the failure.
    expect(owner.getSnapshot().clients).toEqual([client()]);
  });

  it("reads the agent's configuration and the client's own message filter on selection", async () => {
    const configAgents: string[] = [];
    const filterKeys: string[] = [];
    const owner = createWebuiChannelOwner({
      port: {
        listChannelStatus: async () => ({ clients: [client({ name: "wechat:mavis", platform: "wechat" })] }),
        checkChannelConfig: async (request) => {
          configAgents.push(request.agent);
          return { configured: true };
        },
        getChannelMessageFilter: async (request) => {
          filterKeys.push(request.agent);
          return { mode: "full", includeToolSummary: true };
        },
      },
    });

    await owner.load();
    await owner.select("wechat:mavis");

    // The configuration belongs to the agent; the filter belongs to the IM client.
    expect(configAgents).toEqual(["mavis"]);
    expect(filterKeys).toEqual(["wechat:mavis"]);
    expect(owner.getSnapshot().config).toEqual({ configured: true });
    expect(owner.getSnapshot().filter).toEqual({ mode: "full", includeToolSummary: true });
  });

  it("reports a refused bind as a value instead of a success", async () => {
    const owner = createWebuiChannelOwner({
      port: {
        listChannelStatus: async () => ({ clients: [] }),
        connectChannel: async () => ({
          success: false,
          error: "LOCAL_CHANNEL_RUNNER_UNAVAILABLE: no platform runner",
        }),
      },
    });

    const result = await owner.connect({ name: "mavis", appId: "cli_x", appSecret: "secret" });

    expect(result).toEqual({
      ok: false,
      message: "LOCAL_CHANNEL_RUNNER_UNAVAILABLE: no platform runner",
    });
    expect(owner.getSnapshot().actionError).toBe(
      "LOCAL_CHANNEL_RUNNER_UNAVAILABLE: no platform runner",
    );
  });

  it("writes the message filter and publishes what the runtime stored", async () => {
    const owner = createWebuiChannelOwner({
      port: {
        listChannelStatus: async () => ({ clients: [client()] }),
        updateChannelMessageFilter: async (request) => request.filter,
      },
    });

    const result = await owner.updateMessageFilter({
      agent: "mavis",
      filter: { mode: "full", includeToolSummary: true },
    });

    expect(result).toEqual({ ok: true });
    expect(owner.getSnapshot().filter).toEqual({ mode: "full", includeToolSummary: true });
  });
});

describe("the rendered 接入 IM pane", () => {
  it("lists every bound client with its platform label", () => {
    const markup = view(
      snapshot({
        clients: [client(), client({ name: "wechat:mavis", platform: "wechat" })],
        selectedName: "mavis",
      }),
    );

    expect(markup).toContain("飞书");
    expect(markup).toContain("微信");
    expect(markup).toContain('data-webui-channel-row="wechat:mavis"');
    expect(markup).toContain("新 Bot");
  });

  it("shows the empty state only for a successful empty read", () => {
    expect(view(snapshot({ status: "ready", clients: [] }))).toContain(WEBUI_CHANNEL_EMPTY_TEXT);
    // A failed read is not empty: saying so would invite the reader to bind a client again.
    expect(view(snapshot({ status: "error", clients: [], error: "读不到" }))).not.toContain(
      WEBUI_CHANNEL_EMPTY_TEXT,
    );
    expect(view(snapshot({ status: "error", clients: [], error: "读不到" }))).toContain("读不到");
  });

  it("marks the sections the runtime has no route behind as not wired", () => {
    const markup = view(snapshot({ clients: [client()], selectedName: "mavis" }));

    expect(markup).toContain(WEBUI_CHANNEL_NOT_WIRED);
    expect(markup).toContain(WEBUI_CHANNEL_SECTION_WORKSPACE);
    expect(markup).toContain(WEBUI_CHANNEL_SECTION_DELETE);
    expect(markup).toContain('data-webui-channel-section="workspace"');
  });

  it("shows the selected client's configuration state and message filter", () => {
    const markup = view(
      snapshot({
        clients: [client()],
        selectedName: "mavis",
        config: { configured: true },
        filter: { mode: "full", includeToolSummary: true },
      }),
    );

    expect(markup).toContain("已配置");
    expect(markup).toContain("完整输出");
    expect(markup).toContain('data-webui-channel-filter-mode="full"');
  });
});
