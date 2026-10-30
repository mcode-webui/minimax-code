// The 接入 IM panel's projection: wire DTOs in, display rows out.
//
// Pure functions, so the wording of every row is testable without a DOM. The panel renders what
// this module returns and decides nothing itself.
//
// Two honesty rules live here:
//
//   * **A platform is named, never guessed.** The runtime reports the platform of every client it
//     knows; a platform this module does not know is printed as it came, because a wrong "微信"
//     would send the reader to the wrong app.
//   * **A section with no route behind it says so.** The Desktop's 接入 IM pane has four sections
//     and the runtime's routes cover two of them. The other two carry the Desktop's own copy and
//     are marked as not wired, rather than shown as if they worked.
import type {
  WebuiChannelClient,
  WebuiChannelConfigCheckResult,
  WebuiChannelMessageFilterMode,
} from "../../../../shared/contracts/channel.js";

/** The platform labels Desktop's 接入 IM pane shows. */
export const WEBUI_CHANNEL_PLATFORM_LABELS: Readonly<Record<string, string>> = {
  wechat: "微信",
  feishu: "飞书",
  telegram: "Telegram",
};

/** The marker for a section the runtime has no route behind. */
export const WEBUI_CHANNEL_NOT_WIRED = "Disabled (not yet wired)";

export const WEBUI_CHANNEL_EMPTY_TEXT = "还没有接入任何 IM 客户端。";
export const WEBUI_CHANNEL_LOADING_TEXT = "正在读取 IM 接入列表…";
export const WEBUI_CHANNEL_DEFAULT_AGENT_LABEL = "默认";

/** The Desktop's copy for the sections the 接入 IM pane shows. */
export const WEBUI_CHANNEL_SECTION_BIND = "绑定机器人";
export const WEBUI_CHANNEL_STATE_BOUND = "已绑定";
export const WEBUI_CHANNEL_SECTION_BIND_QR = "扫描二维码绑定";
export const WEBUI_CHANNEL_SECTION_BIND_QR_REFRESH = "刷新二维码";
export const WEBUI_CHANNEL_SECTION_BIND_QR_DESCRIPTION = "微信扫码授权以绑定MiniMax Code";
export const WEBUI_CHANNEL_SECTION_BIND_QR_HINT = "机器人将自动绑定";
export const WEBUI_CHANNEL_SECTION_AGENT = "选择 Agent";
export const WEBUI_CHANNEL_SECTION_AGENT_DESCRIPTION = "用不同的 Agent 对话";
export const WEBUI_CHANNEL_SECTION_WORKSPACE = "工作目录";
export const WEBUI_CHANNEL_SECTION_WORKSPACE_DESCRIPTION = "对话信息默认保留的位置";
export const WEBUI_CHANNEL_SECTION_WORKSPACE_EMPTY = "未选项目";
export const WEBUI_CHANNEL_SECTION_DELETE = "删除Bot";
export const WEBUI_CHANNEL_SECTION_DELETE_DESCRIPTION = "从列表移除这个 Bot";
export const WEBUI_CHANNEL_SECTION_DELETE_ACTION = "删除";
export const WEBUI_CHANNEL_SECTION_FILTER = "附带工具调用";
export const WEBUI_CHANNEL_SECTION_FILTER_DESCRIPTION = "在每条消息末尾附上工具调用列表。";

/** The two message-filter modes, as the Desktop names them. */
export const WEBUI_CHANNEL_FILTER_MODE_RESULT = "仅输出结果";
export const WEBUI_CHANNEL_FILTER_MODE_FULL = "完整输出";

export const WEBUI_CHANNEL_CONFIGURED_LABEL = "已配置";
export const WEBUI_CHANNEL_NOT_CONFIGURED_LABEL = "未配置";
export const WEBUI_CHANNEL_CONFIG_UNKNOWN_LABEL = "未读取";

export interface WebuiChannelRow {
  /** The IM client's own name — the identity the runtime stores the binding under. */
  readonly name: string;
  readonly platform: string;
  readonly platformLabel: string;
  readonly agentLabel: string;
  readonly selected: boolean;
}

/** The platform's label, or the platform as it came when this module does not know it. */
export function webuiChannelPlatformLabel(platform: string): string {
  return WEBUI_CHANNEL_PLATFORM_LABELS[platform] ?? platform;
}

/** One row per bound IM client, in the runtime's own order. */
export function webuiChannelRows(
  clients: readonly WebuiChannelClient[],
  selectedName?: string,
): WebuiChannelRow[] {
  return clients.map((client) => ({
    name: client.name,
    platform: client.platform,
    platformLabel: webuiChannelPlatformLabel(client.platform),
    agentLabel: client.agentName ?? WEBUI_CHANNEL_DEFAULT_AGENT_LABEL,
    selected: client.name === selectedName,
  }));
}

/** Whether the selected client's agent has an IM channel configured on this host. */
export function webuiChannelConfigLabel(config: WebuiChannelConfigCheckResult | undefined): string {
  if (!config) return WEBUI_CHANNEL_CONFIG_UNKNOWN_LABEL;
  return config.configured ? WEBUI_CHANNEL_CONFIGURED_LABEL : WEBUI_CHANNEL_NOT_CONFIGURED_LABEL;
}

/** How much of a turn the IM client receives. */
export function webuiChannelFilterModeLabel(mode: WebuiChannelMessageFilterMode): string {
  return mode === "full" ? WEBUI_CHANNEL_FILTER_MODE_FULL : WEBUI_CHANNEL_FILTER_MODE_RESULT;
}
