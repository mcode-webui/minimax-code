// The settings business's view of the provider-usage derivation, published
// as a public module.
//
// The settings "用量与模型" page renders the active source badge, formats the
// reset-after label, and reads provider-header drafts as a stream of rows
// the user types into the form. The settings business owns none of this: the
// state the badge reads lives on the models owner, the reset-after wording is
// a model's concern (because the cadence it renders is the model's billing
// window, not a settings rule), and the row shape is a model's input, not a
// settings' own. So the badge, the formatter, and the row type move here to
// the publication marker, and the rest of the projection — the heading
// projection, the header-row projection — stays private in the sibling
// `usage-settings.ts` because no other business needs to read it.
//
// This module is `.public` because the settings business needs the model
// business's badge-rule and reset-rule to render the usage page. The
// `.public` suffix is a publication marker; the rules and the row shape are
// unchanged.

import type { ProviderHeaderDraft } from "../contracts/provider-editor.js";

export type { ProviderHeaderDraft };

export function getActiveSourceBadge(
  loaded: boolean,
  source: "token_plan" | "minimax_api_key" | undefined,
  hasTokenPlan: boolean,
): "使用中" | "未启用" | undefined {
  if (!loaded || !hasTokenPlan || source === undefined) return undefined;
  return source === "token_plan" ? "使用中" : "未启用";
}

function formatRemainingTime(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}分${seconds ? `${seconds}秒` : ""}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return `${hours}小时${minutes ? `${minutes}分` : ""}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}天${remainingHours ? `${remainingHours}小时` : ""}`;
}

/** `reset_after` wording, with its under-one-minute time-only branch. */
export function formatResetLabel(resetAtMs: number | undefined, nowMs: number): string | undefined {
  if (resetAtMs === undefined || !Number.isFinite(resetAtMs)) return undefined;
  const remainingSeconds = Math.ceil((resetAtMs - nowMs) / 1000);
  if (remainingSeconds <= 0) return undefined;
  const time = formatRemainingTime(remainingSeconds);
  return remainingSeconds < 60 ? time : `${time}后重置`;
}
