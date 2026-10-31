// transcript-scroll — 会话转录视口的滚动策略。
//
// 视口 `[data-webui-session-scroll="true"]` 承载整条消息流：live 回合期间由自动跟随
// 维持贴底，进入一个非 live 会话时同样要落在最后一条消息上。这里的函数只做纯计算，
// 把"何时跳"和"跳多远"从组件里拆出来，状态迁移可以直接单测。

/** 视口距底部小于该距离即视为贴底（px）。 */
export const WEBUI_SCROLL_FOLLOW_THRESHOLD_PX = 150;

export interface WebuiScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** 贴底所需的 scrollTop；内容不足一屏时为 0。 */
export function webuiScrollBottomTop(metrics: WebuiScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}

/** 视口当前是否处于跟随贴底的位置。 */
export function webuiScrollFollowsBottom(metrics: WebuiScrollMetrics): boolean {
  return (
    webuiScrollBottomTop(metrics) - metrics.scrollTop
      <= WEBUI_SCROLL_FOLLOW_THRESHOLD_PX
  );
}

/** 视口距顶/距底小于该距离即视为到顶/到底（px）。 */
export const WEBUI_SCROLL_EDGE_THRESHOLD_PX = 20;

/** 触摸手势必须超过该位移才算用户滚动手势（px）。 */
export const WEBUI_SCROLL_TOUCH_INTENT_PX = 8;

export type WebuiScrollIntent = "release" | "ignore";

/**
 * 一个滚动手势是否算「用户把视口从最新内容上拿走」。
 *
 * 规则取自桌面端消息视口的意图判定：手势只有在**真能移动视口**时才算数。
 * 已经贴底还继续往下推、或已经在顶部还继续往上推，视口无处可去，
 * 桌面端把这种滚轮单独记为 `wheel-intent:ignored-boundary` 并直接返回——
 * 它不是用户要脱离跟随，只是滚到了尽头。触摸更宽松：位移不足 8px 的手势
 * 是手指落下的抖动，同样不算意图。
 */
export function webuiScrollIntent(params: {
  readonly event: "wheel" | "touchmove";
  readonly deltaY: number;
  readonly metrics: WebuiScrollMetrics;
}): WebuiScrollIntent {
  if (params.event === "touchmove" && Math.abs(params.deltaY) < WEBUI_SCROLL_TOUCH_INTENT_PX) {
    return "ignore";
  }
  const bottomTop = webuiScrollBottomTop(params.metrics);
  const atBottom = bottomTop - params.metrics.scrollTop <= WEBUI_SCROLL_EDGE_THRESHOLD_PX;
  const atTop = params.metrics.scrollTop <= WEBUI_SCROLL_EDGE_THRESHOLD_PX;
  if (atBottom && params.deltaY >= 0) return "ignore";
  if (atTop && params.deltaY <= 0) return "ignore";
  return "release";
}
