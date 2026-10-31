// ConversationUsageBanner — the cloud-quota banner. Shown when the cloud
// quota signals an `insufficient_credit` / `five_hour` / `weekly` /
// `video` notice; data is passed through props so the WebUI shell can decide
// how to wire it to the runtime.
//
// The brief says: "若依赖云端数据，做成纯展示组件、数据由 props 传入。"
// That matches `notice.kind`, `notice.messageKey`, `notice.resetAtMs`,
// `notice.actions` (the action IDs that map to
// `buy_credits` / `subscribe_plan` / `upgrade_plan`) and `notice.dismissable`
// (the "should I render the close
// button" decision, exposed here as a simple boolean).
//
// The CTA buttons keep their verbatim labels:
//   "buy_credits"      → chat_button_buy_credits
//   "subscribe_plan"   → chat_button_subscribe_plan
//   "upgrade_plan"     → chat_button_upgrade_plan
// The container class names come from `h`, which toggles
// between the inline `relative mb-2 flex min-h-16 flex-col gap-3 …` and the
// compact `mb-3 flex min-h-12 flex-wrap items-center …` variant.
//
// The dismiss button testid is `conversation-usage-dismiss`; the brief also
// names `conversation-usage-banner-dismiss`. We emit
// both testids on the same node so Playwright selectors written against either
// form land on the same element.

import type { MouseEvent, ReactNode } from "react";
import { IconAlertCircle, IconX } from "@tabler/icons-react";

import { WebuiButton, WebuiIconButton } from "../../../ui/button.js";
import { WebuiInline } from "../../../ui/layout-primitives.js";

export type ConversationUsageActionKind =
  | "buy_credits"
  | "subscribe_plan"
  | "upgrade_plan";

export interface ConversationUsageNotice {
  kind: "five_hour" | "weekly" | "video" | "insufficient_credit" | string;
  messageKey: string;
  resetAtMs?: number | null;
  actions: readonly ConversationUsageActionKind[];
  dismissable?: boolean;
}

export interface ConversationUsageBannerProps {
  notice: ConversationUsageNotice;
  mobileLayout?: boolean;
  messageText: string;
  dismissLabel?: string;
  buttonLabels?: Partial<Record<ConversationUsageActionKind, string>>;
  onDismiss?: () => void;
  onAction?: (kind: ConversationUsageActionKind) => void;
  renderActionButton?: (params: {
    kind: ConversationUsageActionKind;
    label: string;
    onClick: () => void;
    variant: "black" | "gray";
    testId: string;
  }) => ReactNode;
}

const DEFAULT_BUTTON_LABELS: Record<ConversationUsageActionKind, string> = {
  buy_credits: "购买积分",
  subscribe_plan: "订阅套餐",
  upgrade_plan: "升级套餐",
};

function formatResetAt(resetAtMs: number, now: number = Date.now()): string {
  const sameDay = (() => {
    const a = new Date(resetAtMs);
    const b = new Date(now);
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  })();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(resetAtMs);
}

function DefaultActionButton(props: {
  kind: ConversationUsageActionKind;
  label: string;
  variant: "black" | "gray";
  testId: string;
  onClick: () => void;
}): React.JSX.Element {
  const { kind, label, variant, testId, onClick } = props;
  // Both actions use shared button appearances; callers only provide the
  // banner-specific placement and dimensions.
  if (variant === "black") {
    return (
      <WebuiButton variant="accent" size="header" data-testid={testId} onClick={onClick}>
        {label}
      </WebuiButton>
    );
  }
  return (
    <WebuiButton
      variant="outline"
      size="header"
      data-testid={testId}
      onClick={onClick}
    >
      {label}
    </WebuiButton>
  );
}

function CloseIcon(): React.JSX.Element {
  return <IconX width={18} height={18} aria-hidden="true" focusable="false" stroke={1.7} />;
}

function NoticeIcon(): React.JSX.Element {
  return <IconAlertCircle width={20} height={20} aria-hidden="true" focusable="false" className="flex-none text-icon_default_secondary" stroke={1.7} />;
}

export function ConversationUsageBanner(props: ConversationUsageBannerProps): React.JSX.Element {
  const {
    notice,
    mobileLayout = false,
    messageText,
    dismissLabel = "关闭",
    buttonLabels,
    onDismiss,
    onAction,
    renderActionButton,
  } = props;

  const labels: Record<ConversationUsageActionKind, string> = {
    buy_credits: buttonLabels?.buy_credits ?? DEFAULT_BUTTON_LABELS.buy_credits,
    subscribe_plan: buttonLabels?.subscribe_plan ?? DEFAULT_BUTTON_LABELS.subscribe_plan,
    upgrade_plan: buttonLabels?.upgrade_plan ?? DEFAULT_BUTTON_LABELS.upgrade_plan,
  };

  const composedMessage =
    notice.resetAtMs == null
      ? messageText
      : `${messageText} ${formatResetAt(notice.resetAtMs)}`;

  const canDismiss = notice.dismissable !== false;
  const dismissClass = mobileLayout ? "absolute right-1 top-1 z-10" : "flex-none";

  const containerClass = mobileLayout
    ? "relative mb-2 flex min-h-16 flex-col gap-3 rounded-2xl border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated p-2 transcript-shadow-banner-soft"
    : "mb-3 flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated px-4 py-2 transcript-shadow-banner-soft";

  const handleDismiss = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onDismiss?.();
  };

  const handleAction = (kind: ConversationUsageActionKind) => () => {
    onAction?.(kind);
  };

  return (
    <div
      className={containerClass}
      data-testid="conversation-usage-banner"
      data-notice-kind={notice.kind}
    >
      <WebuiInline
        gap="small"
        className={mobileLayout ? "min-w-0 pr-9" : "min-w-[240px] flex-1"}
      >
        <NoticeIcon />
        <p className="min-w-0 flex-1 text-[14px] leading-5 text-text_default_primary">
          {composedMessage}
        </p>
      </WebuiInline>
      {mobileLayout && canDismiss ? (
        <WebuiIconButton
          tone="bare"
          size="compact"
          onClick={handleDismiss}
          label={dismissLabel}
          data-testid="conversation-usage-banner-dismiss"
          className={dismissClass}
        >
          <CloseIcon />
        </WebuiIconButton>
      ) : null}
      <WebuiInline
        gap="small"
        justify="end"
        className={mobileLayout ? "" : "ml-auto flex-none"}
      >
        {notice.actions.map((kind) => {
          const variant = kind === "buy_credits" ? "gray" : "black";
          const label = labels[kind];
          const testId = `conversation-usage-action-${kind}`;
          return renderActionButton ? (
            renderActionButton({
              kind,
              label,
              onClick: handleAction(kind),
              variant,
              testId,
            })
          ) : (
            <DefaultActionButton
              key={kind}
              kind={kind}
              label={label}
              variant={variant}
              testId={testId}
              onClick={handleAction(kind)}
            />
          );
        })}
        {!mobileLayout && canDismiss ? (
          <WebuiIconButton
            tone="bare"
            size="compact"
            onClick={handleDismiss}
            label={dismissLabel}
            data-testid="conversation-usage-banner-dismiss"
            className={dismissClass}
          >
            <CloseIcon />
          </WebuiIconButton>
        ) : null}
      </WebuiInline>
    </div>
  );
}
