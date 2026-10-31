// The 限额重置 section of the 用量与模型 page.
//
// It stands on its own because it owns a redemption: the card list, the
// confirmation, the redemption phase and the 30-day history are one flow, and
// the flow's owner is the account owner (`account-workflows.ts`). This
// component renders that state and submits its commands; it holds no store
// writer and calls no transport method of its own.
//
// The wording, the phase names and the empty states are the Desktop's, read
// out of its renderer bundle. The Desktop hides the whole section for an
// account that has no plan, and so does this one.
//
// The section renders the shared settings skeleton — the same section title,
// the same card, the same row and the same hairline the neighbouring sections
// render — because a section that draws its own frame reads as a different
// product. The two dialogs render the settings pages' own dialog frame for the
// same reason.

import { type ReactElement, useEffect } from "react";
import { createPortal } from "react-dom";
import type {
  WebuiResetCardOutcome,
  WebuiResetCardView,
} from "../../../../shared/contracts/account-billing.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { SettingsDivider, SettingsRow, SettingsSection } from "../../../ui/settings-layout.js";
import type {
  WebuiAccountWorkflowsConsumer,
} from "../../account/bindings/use-account-workflows.public.js";
import { useWebuiAccountWorkflowsState } from "../../account/bindings/use-account-workflows.public.js";
import { SettingsButton, SettingsDialog } from "./settings-atoms.js";
import { FeedbackError } from "../../../ui/feedback.js";
import { WebuiInline } from "../../../ui/layout-primitives.js";

/**
 * The reset-card state and its phase, read off the account owner's published
 * snapshot type. The owner is another business's, so its application module is
 * not importable here; the published hook's return type is the contract.
 */
type WebuiResetCardState = ReturnType<typeof useWebuiAccountWorkflowsState>["resetCards"];
type WebuiResetCardPhase = WebuiResetCardState["phase"];

/** The copy the Desktop shows, word for word. */
export const WEBUI_RESET_CARD_COPY = {
  title: "限额重置",
  cardFallbackName: "完全重置",
  empty: "无可用重置次数",
  history: "历史记录",
  loadMore: "加载更多",
  use: "使用",
  historyTitle: "近 30 天历史记录",
  historyWindow: "展示近 30 天的重置卡获得与使用记录",
  historyEmpty: "最近 30 天暂无记录",
  historyLoadError: "历史记录加载失败",
  historyMoreError: "未能加载更多记录",
  granted: "获得",
  used: "使用",
  confirmTitle: "重置使用额度",
  confirmDescription: "请选择一张卡并确认消费。完成后会重新读取用量，不会自动重发对话。",
  confirm: "确认",
  cancel: "取消",
  close: "关闭",
  retry: "重试",
} as const;

/**
 * The status line the phase produces. The Desktop shows one line per phase;
 * a phase with no line (the idle one) shows nothing.
 */
export function formatResetCardStatus(
  phase: WebuiResetCardPhase,
): string | undefined {
  switch (phase) {
    case "using":
    case "refreshing":
      return "正在重置额度…";
    case "success":
      return "Reset 卡已使用，状态已更新。";
    case "replayed":
      return "该操作此前已完成，状态已更新。";
    case "unavailable":
      return "这张卡已过期或不可用，列表已重新读取。";
    case "offline":
      return "网络连接不可用，请恢复网络后重试。";
    case "retryable":
      return "本次未完成，请稍后重试。";
    case "busy":
      return "操作正在处理中，请稍后重试。";
    case "unknown":
      return "暂时无法确认重置结果，请重试；重试将使用同一张卡。";
    case "refresh_failed":
      return "请刷新用量和卡片状态，无需再次使用重置卡。";
    default:
      return undefined;
  }
}

/** The card's display name, with the Desktop's fallback. */
export function formatResetCardName(card: WebuiResetCardView): string {
  return card.name?.trim() || WEBUI_RESET_CARD_COPY.cardFallbackName;
}

/** The card's expiry wording: "到期 2026.10.20". */
export function formatResetCardExpiry(card: WebuiResetCardView): string | undefined {
  if (card.expireTimeMs === undefined) return undefined;
  const date = new Date(card.expireTimeMs).toLocaleDateString("sv-SE").replaceAll("-", ".");
  return `${date} 到期`;
}

/** The history row's wording: "获得 完全重置" / "使用 完全重置". */
export function formatResetCardFlowLabel(
  flow: { readonly eventType: string; readonly name?: string },
): string {
  const name = flow.name?.trim() || WEBUI_RESET_CARD_COPY.cardFallbackName;
  const verb = flow.eventType === "USE" ? WEBUI_RESET_CARD_COPY.used : WEBUI_RESET_CARD_COPY.granted;
  return `${verb} ${name}`;
}

/** The redemption outcome a phase reports, for the toast the Desktop shows. */
export function formatResetCardOutcome(outcome: WebuiResetCardOutcome): string {
  switch (outcome) {
    case "SUCCESS":
      return "重置成功";
    case "REPLAYED":
      return "该卡已使用，限额状态已更新";
    case "EXPIRED":
    case "NOT_FOUND":
      return "重置失败，该卡已过期或不可用";
    case "RETRYABLE_FAIL":
      return "重置失败，请稍后重试";
    case "LOCK_BUSY":
      return "重置正在处理中，请稍后重试";
    default:
      return "暂时无法确认重置结果，请刷新状态";
  }
}

export interface UsageResetCardsProps {
  readonly account: WebuiAccountWorkflowsConsumer | undefined;
  readonly state: WebuiResetCardState;
}

export function UsageResetCards({ account, state }: UsageResetCardsProps): ReactElement | null {
  const { cards, history, phase, selected, historyOpen } = state;
  const status = formatResetCardStatus(phase);
  const enabled = account?.canUseResetCards === true;

  // The list is read when the section appears, the way the Desktop reads it
  // when the usage page becomes active. The read is guarded by the same gate
  // as the render, so an account without a plan never asks for cards.
  useEffect(() => {
    if (!enabled) return;
    if (cards.page === 0 && !cards.loading) void account?.loadResetCards();
  // The owner is stable; the read is keyed on the list's own page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, enabled, cards.page, cards.loading]);

  // The reset cards are a plan feature: the Desktop only offers them to a
  // subscribed account, so an account without a plan gets no section at all.
  if (!enabled) return null;

  return (
    <>
    <SettingsSection
      title={WEBUI_RESET_CARD_COPY.title}
      testId="settings-usage-reset-cards"
      actions={
        <SettingsButton
          size="compact"
          testId="settings-usage-reset-card-history"
          onClick={() => void account?.openResetCardHistory()}
        >
          {WEBUI_RESET_CARD_COPY.history}
        </SettingsButton>
      }
    >
      {status ? (
        <p
          data-testid="settings-usage-reset-card-status"
          className="px-3 pb-1 text-[12px] leading-4 text-text_default_secondary"
        >
          {status}
        </p>
      ) : null}
      {cards.loading && cards.items.length === 0 ? (
        <p className="px-3 py-2 text-[13px] leading-5 text-text_default_secondary">加载中…</p>
      ) : cards.error && cards.items.length === 0 ? (
        <FeedbackError
          message={cards.error}
          layout="inline"
          className="px-3 py-2 text-[13px] leading-5 text-text_default_secondary"
          action={
            <SettingsButton size="compact" onClick={() => void account?.loadResetCards()}>
              {WEBUI_RESET_CARD_COPY.retry}
            </SettingsButton>
          }
        />
      ) : cards.items.length === 0 ? (
        <p
          data-testid="settings-usage-reset-card-empty"
          className="px-3 py-2 text-[13px] leading-5 text-text_default_secondary"
        >
          {WEBUI_RESET_CARD_COPY.empty}
        </p>
      ) : (
        <div data-testid="settings-usage-reset-card-list">
          {cards.items.map((card, index) => (
            <div key={card.cardId}>
              {index > 0 ? <SettingsDivider /> : null}
              <SettingsRow
                title={formatResetCardName(card)}
                description={formatResetCardExpiry(card)}
                testId="settings-usage-reset-card"
              >
                <SettingsButton
                  size="compact"
                  testId="settings-usage-reset-card-use"
                  onClick={() => account?.selectResetCard(card)}
                >
                  {WEBUI_RESET_CARD_COPY.use}
                </SettingsButton>
              </SettingsRow>
            </div>
          ))}
        </div>
      )}
      {cards.hasMore && cards.items.length > 0 ? (
        <WebuiInline justify="end" className="px-3 pt-2">
          <SettingsButton
            size="compact"
            testId="settings-usage-reset-card-load-more"
            disabled={cards.loading}
            onClick={() => void account?.loadMoreResetCards()}
          >
            {WEBUI_RESET_CARD_COPY.loadMore}
          </SettingsButton>
        </WebuiInline>
      ) : null}
    </SettingsSection>
    {historyOpen ? (
      <ResetCardHistoryDialog
        history={history}
        onClose={() => account?.closeResetCardHistory()}
        onLoadMore={() => void account?.loadMoreResetCardHistory()}
      />
    ) : null}
    {selected ? (
      <ResetCardConfirmDialog
        card={selected}
        phase={phase}
        onConfirm={() => void account?.redeemResetCard()}
        onCancel={() => account?.clearResetCardSelection()}
      />
    ) : null}
    </>
  );
}

function ResetCardConfirmDialog({
  card,
  phase,
  onConfirm,
  onCancel,
}: {
  readonly card: WebuiResetCardView;
  readonly phase: WebuiResetCardPhase;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const busy = phase === "using" || phase === "refreshing";
  const status = formatResetCardStatus(phase);
  return (
    <ResetCardPortal>
      <SettingsDialog
        title={WEBUI_RESET_CARD_COPY.confirmTitle}
        testId="settings-usage-reset-card-confirm"
        onClose={onCancel}
        footer={
          <>
            <SettingsButton size="compact" onClick={onCancel}>
              {WEBUI_RESET_CARD_COPY.cancel}
            </SettingsButton>
            <SettingsButton
              variant="black"
              size="compact"
              testId="settings-usage-reset-card-confirm-ok"
              disabled={busy}
              onClick={onConfirm}
            >
              {WEBUI_RESET_CARD_COPY.confirm}
            </SettingsButton>
          </>
        }
      >
        <p className="text-[13px] leading-5 text-text_default_secondary">
          {WEBUI_RESET_CARD_COPY.confirmDescription}
        </p>
        <p className="text-[13px] leading-5 text-text_default_primary">{formatResetCardName(card)}</p>
        {status ? (
          <p
            className="text-[12px] leading-4 text-text_default_secondary"
            data-testid="settings-usage-reset-card-confirm-status"
          >
            {status}
          </p>
        ) : null}
      </SettingsDialog>
    </ResetCardPortal>
  );
}

function ResetCardHistoryDialog({
  history,
  onClose,
  onLoadMore,
}: {
  readonly history: WebuiResetCardState["history"];
  readonly onClose: () => void;
  readonly onLoadMore: () => void;
}): ReactElement {
  return (
    <ResetCardPortal>
      <SettingsDialog
        title={WEBUI_RESET_CARD_COPY.historyTitle}
        testId="settings-usage-reset-card-history-dialog"
        onClose={onClose}
        footer={
          history.hasMore && history.items.length > 0 ? (
            <SettingsButton
              size="compact"
              testId="settings-usage-reset-card-history-load-more"
              disabled={history.loading}
              onClick={onLoadMore}
            >
              {history.retryMore ? WEBUI_RESET_CARD_COPY.historyMoreError : WEBUI_RESET_CARD_COPY.loadMore}
            </SettingsButton>
          ) : null
        }
      >
        <p className="text-[12px] leading-4 text-text_default_secondary">
          {WEBUI_RESET_CARD_COPY.historyWindow}
        </p>
        {history.loading && history.items.length === 0 ? (
          <p className="py-2 text-[13px] leading-5 text-text_default_secondary">加载中…</p>
        ) : history.error && history.items.length === 0 ? (
          <FeedbackError
            message={WEBUI_RESET_CARD_COPY.historyLoadError}
            layout="inline"
            className="py-2 text-[13px] leading-5 text-text_default_secondary"
            action={
              <SettingsButton size="compact" onClick={onLoadMore}>
                {WEBUI_RESET_CARD_COPY.retry}
              </SettingsButton>
            }
          />
        ) : history.items.length === 0 ? (
          <p
            data-testid="settings-usage-reset-card-history-empty"
            className="webui-settings-dialog-empty"
          >
            {WEBUI_RESET_CARD_COPY.historyEmpty}
          </p>
        ) : (
          <div className="webui-settings-dialog-list" data-testid="settings-usage-reset-card-history-list">
            {history.items.map((flow) => (
              <WebuiInline
                gap="medium"
                justify="between"
                key={`${flow.cardId}\u0000${flow.eventType}\u0000${flow.createTimeMs ?? ""}`}
                className="webui-settings-dialog-list-row"
              >
                <span>{formatResetCardFlowLabel(flow)}</span>
                <span>
                  {flow.createTimeMs === undefined
                    ? ""
                    : new Date(flow.createTimeMs).toLocaleString("sv-SE").replaceAll("-", ".")}
                </span>
              </WebuiInline>
            ))}
          </div>
        )}
      </SettingsDialog>
    </ResetCardPortal>
  );
}

/**
 * The dialogs are portalled to the document body so the settings modal's own
 * stacking context does not clip them. The portal target comes from the
 * injected browser adapter, never from the ambient `document`: a host without a
 * document renders the dialog inline instead of crashing.
 */
function ResetCardPortal({ children }: { readonly children: ReactElement }): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  const portalTarget = dom.portalTarget();
  return portalTarget ? createPortal(children, portalTarget) : children;
}
