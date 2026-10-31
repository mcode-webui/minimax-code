// The account page.
//
// A port of the Desktop's account page (`chunks/69200.*.js`, the `ap`
// component): the same profile block, the same three headline numbers, the
// same usage calendar and the same "分享" action. The Desktop's "编辑" action
// is deliberately not ported — it opens the profile editor, which is a
// separate surface.
//
// The page is rendered inside the settings shell's own account tab, because
// that is where the Desktop keeps it: the Desktop's account page is the
// account tab of its settings dialog, and its content column is 704px wide —
// the width this shell's shared settings column already uses. The calendar's
// 696px grid therefore fills that column exactly, the way it does on the
// Desktop.
//
// The data comes from the account business through its published binding
// (`useWebuiAccountWorkflowsState`); this business never reaches into the
// account business's own modules.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { WebuiIconBrand } from "../../../shell/icons.js";
import {
  useWebuiAccountWorkflows,
  useWebuiAccountWorkflowsState,
} from "../../account/bindings/use-account-workflows.public.js";
import { SettingsPage } from "../../../ui/settings-layout.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";
import { SettingsButton, SettingsDialog } from "./settings-atoms.js";
import { formatPlanName } from "../projection/usage-plan.js";
import {
  buildUsageHeatmapModel,
  formatSpacedToken,
  maskAccountPhone,
  projectUsageMetrics,
  type WebuiUsageHeatmapModel,
  type WebuiUsageMetrics,
} from "../projection/usage-report.js";
import {
  AccountUsageDownloadIcon,
  AccountUsageInfoIcon,
  AccountUsageRefreshIcon,
  AccountUsageShareIcon,
} from "./account-usage-glyphs.js";
import { UsageHeatmap } from "./UsageHeatmap.js";
import {
  accountUsageShareFileName,
  renderAccountUsageShareImage,
} from "./account-usage-share-image.js";

const ACCOUNT_USAGE_DEFAULT_NAME = "MiniMax Code user";
const ACCOUNT_USAGE_TRACKING_SINCE =
  "数据自 2025 年 11 月起，统计你在 MiniMax Code 中的 M Plan 文本模型用量（暂不含积分、BYOK 和开放平台用量）";
const ACCOUNT_USAGE_RANKING_INFO = "仅显示前 50% 的排名";

/** The three headline numbers, with the labels the Desktop gives them. */
const ACCOUNT_USAGE_METRICS = [
  { id: "account-total-token", label: "累计 Token" },
  { id: "account-peak-token", label: "单日峰值" },
  { id: "account-ranking", label: "用量排名" },
] as const;

interface AccountUsageView {
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly contacts: readonly string[];
  readonly planLabel: string;
  readonly metrics?: WebuiUsageMetrics;
  readonly heatmap?: WebuiUsageHeatmapModel;
  readonly loading: boolean;
  readonly failed: boolean;
}

/**
 * The account page's data, in the shape the page draws it.
 *
 * The metrics and the calendar are derived from the same two reads the Desktop
 * makes, and the derivation is the Desktop's own arithmetic
 * (`projection/usage-report.ts`).
 */
function useAccountUsageView(): AccountUsageView {
  const accountState = useWebuiAccountWorkflowsState();
  const quotaResult = accountState.usage.result;
  const usageFacts = quotaResult?.signedIn ? quotaResult : undefined;
  const profile = accountState?.profile.profile;
  const summary = accountState?.usageSummary.summary;
  const days = Array.isArray(summary?.days) ? summary.days : undefined;
  const registrationTimeMs = profile?.agentRegisterTimeMs;
  const heatmap = useMemo(
    () => (days ? buildUsageHeatmapModel(days, { registrationTimeMs }) : undefined),
    [days, registrationTimeMs],
  );
  const metrics = useMemo(
    () => (summary ? projectUsageMetrics({ ...summary, days: days ?? [] }) : undefined),
    [summary, days],
  );
  const displayName = profile?.userName?.trim() || ACCOUNT_USAGE_DEFAULT_NAME;
  const contacts = useMemo(() => {
    const values: string[] = [];
    const phone = profile?.phone?.trim();
    if (phone) values.push(maskAccountPhone(phone));
    const email = profile?.email?.trim();
    if (email) values.push(email);
    return values;
  }, [profile?.phone, profile?.email]);
  return {
    displayName,
    ...(profile?.avatarUrl || profile?.defaultAvatarUrl
      ? { avatarUrl: profile?.avatarUrl || profile?.defaultAvatarUrl }
      : {}),
    contacts,
    planLabel: formatPlanName({
      hasTokenPlan: usageFacts?.hasTokenPlan,
      tokenPlanTier: usageFacts?.tokenPlanTier,
      planName: usageFacts?.planName,
    }),
    ...(metrics ? { metrics } : {}),
    ...(heatmap ? { heatmap } : {}),
    loading: accountState.usageSummary.status === "loading",
    failed: accountState.usageSummary.status === "error",
  };
}

export function AccountUsageSettings(): ReactElement {
  const accountWorkflows = useWebuiAccountWorkflows();
  const view = useAccountUsageView();

  useEffect(() => {
    void accountWorkflows?.loadAccountUsageSummary();
    void accountWorkflows?.loadAccountProfile();
    void accountWorkflows?.loadUsage(true);
    // The account page reads the account's own state; re-reading on every
    // state change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retry = useCallback(() => {
    void accountWorkflows?.loadAccountUsageSummary();
  }, [accountWorkflows]);

  return (
    <SettingsPage testId="settings-account-page">
      <WebuiStack gap="large" className="w-full" data-testid="account-usage-settings">
        <WebuiStack as="section" align="center" data-testid="account-usage-profile">
          <AccountUsageAvatar
            avatarUrl={view.avatarUrl}
            displayName={view.displayName}
            testId="account-usage-avatar"
          />
          <WebuiStack gap="tight" align="center" className="mt-5 max-w-full">
            <div className="max-w-full truncate text-[16px] font-semibold leading-[24.89px] text-text_default_primary">
              {view.displayName}
            </div>
            <WebuiInline gap="tight" className="max-w-full text-[13px] leading-[18.57px] text-text_default_tertiary">
              {view.contacts.map((contact) => (
                <span key={contact} className="contents">
                  <span aria-hidden="true">·</span>
                  <span className="max-w-52 truncate">{contact}</span>
                </span>
              ))}
              {view.contacts.length > 0 ? <span aria-hidden="true">·</span> : null}
              <span className="shrink-0 rounded-[6px] border border-border_default px-1 py-0.5 text-xs leading-4 text-text_default_secondary">
                {view.planLabel}
              </span>
            </WebuiInline>
          </WebuiStack>
        </WebuiStack>
        <WebuiStack gap="large">
          <section
            className="grid h-[70px] grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)_1px_minmax(0,1fr)] items-center gap-4 rounded-2xl bg-bg_grouped_tertiary px-5 py-4"
            data-testid="account-usage-metrics"
          >
            {ACCOUNT_USAGE_METRICS.map((metric, index) => (
              <div key={metric.id} className="contents">
                <WebuiStack
                  gap="micro"
                  align="center"
                  justify="center"
                  className="text-center"
                  data-testid="account-usage-metric"
                >
                  <div className="text-[13px] font-normal leading-[18.57px] text-text_default_primary">
                    {view.metrics
                      ? ({
                          "account-total-token": view.metrics.totalToken,
                          "account-peak-token": view.metrics.peakToken,
                          "account-ranking": view.metrics.usageRanking,
                        })[metric.id]
                      : "—"}
                  </div>
                  <WebuiInline justify="center" gap="tight" className="text-xs leading-4 text-text_default_secondary">
                    <span>{metric.label}</span>
                    {metric.id === "account-ranking" ? (
                      <WebuiInline as="span" justify="center" className="size-4 text-icon_default_tertiary"
                        aria-label={ACCOUNT_USAGE_RANKING_INFO}
                        title={ACCOUNT_USAGE_RANKING_INFO}
                      >
                        <AccountUsageInfoIcon />
                      </WebuiInline>
                    ) : null}
                  </WebuiInline>
                </WebuiStack>
                {index < 2 ? (
                  <span
                    aria-hidden="true"
                    className="h-7 w-px bg-border_light"
                    data-testid="account-usage-metric-separator"
                  />
                ) : null}
              </div>
            ))}
          </section>
          <WebuiStack as="section" className="min-h-[150px]" data-testid="account-usage-activity">
            <WebuiInline as="div" gap="tight" className="h-5">
              <h2 className="text-[13px] font-normal leading-[18.57px] text-text_default_primary">Token 用量</h2>
              {view.heatmap?.trackingStartDate ? (
                <WebuiInline as="span" justify="center" className="size-4 text-icon_default_tertiary"
                  aria-label={ACCOUNT_USAGE_TRACKING_SINCE}
                  title={ACCOUNT_USAGE_TRACKING_SINCE}
                >
                  <AccountUsageInfoIcon />
                </WebuiInline>
              ) : null}
            </WebuiInline>
            <div className="mt-3">
              {view.loading ? (
                <div className="mx-auto h-[118px] w-[696px] max-w-full animate-pulse rounded-[8px] bg-bg_grouped_tertiary" />
              ) : view.failed ? (
                <WebuiStack gap="medium" align="center" justify="center" className="h-[118px]">
                  <span className="text-[13px] leading-[18.57px] text-text_default_secondary">用量数据暂时不可用</span>
                  <SettingsButton variant="gray" onClick={retry}>
                    <WebuiInline as="span" gap="small">
                      <AccountUsageRefreshIcon size={16} />
                      重试
                    </WebuiInline>
                  </SettingsButton>
                </WebuiStack>
              ) : view.heatmap ? (
                <UsageHeatmap model={view.heatmap} align="start" />
              ) : (
                <div className="mx-auto h-[118px] w-[696px] max-w-full rounded-[8px] bg-bg_grouped_tertiary" />
              )}
            </div>
          </WebuiStack>
        </WebuiStack>
      </WebuiStack>
    </SettingsPage>
  );
}

/**
 * The account's avatar, with the initial letter as its fallback.
 *
 * The image IS the circle: it fills the 80px box and is clipped by its own
 * `rounded-full`. The Desktop draws the same avatar the same way — its
 * container is a white circle, but the picture is a disc that reaches the
 * edges of the square, so the white is never visible and only the picture
 * shows.
 *
 * The white container is not reproduced here on purpose. Two things make it
 * wrong rather than merely different:
 *
 *  * This design system has no `size-full` utility — `theme.size` is the
 *    token scale (`size_12` … `size_64`), so `size-full` is dropped by the
 *    Tailwind build and the class silently does nothing. A container sized
 *    with it collapses, the picture stops covering it, and the white shows
 *    through as a second circle behind the picture.
 *  * The picture is a disc that touches the edges of its square, so a
 *    container that is even slightly larger than the picture reveals itself
 *    as a crescent on the side the picture is short of.
 *
 * `h-full w-full` are the utilities that exist here, and the image is sized
 * by the box rather than by the container.
 */
function AccountUsageAvatar({
  avatarUrl,
  displayName,
  testId,
}: {
  readonly avatarUrl?: string;
  readonly displayName: string;
  readonly testId: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);
  const initial = displayName.trim().slice(0, 1).toUpperCase() || "M";
  return (
    <div className="relative shrink-0" style={{ width: 80, height: 80 }} data-testid={testId}>
      {avatarUrl && !failed ? (
        <img
          src={avatarUrl}
          alt=""
          className="h-full w-full rounded-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <WebuiInline align="center" justify="center" className="h-full w-full rounded-full bg-bg_grouped_tertiary text-2xl font-semibold text-text_default_accent">
          {initial}
        </WebuiInline>
      )}
    </div>
  );
}

/**
 * The "分享" action of the settings header.
 *
 * The Desktop puts it in the account page's own top-right corner; the
 * WebUI's settings shell has a header action slot in the same place, so the
 * button lives there and opens the share preview from here.
 */
export function AccountUsageShareAction(): ReactElement | null {
  const { dom } = useWebuiBrowserCapabilities();
  const view = useAccountUsageView();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const portalTarget = dom.portalTarget();

  const saveImage = useCallback(async () => {
    if (!view.metrics || !view.heatmap) return;
    setExporting(true);
    setExportError(null);
    try {
      const canvas = dom.createCanvas(784, 580);
      if (!canvas) throw new Error("当前浏览器不支持导出图片。");
      await renderAccountUsageShareImage(
        canvas,
        {
          displayName: view.displayName,
          planLabel: view.planLabel,
          ...(view.avatarUrl ? { avatarUrl: view.avatarUrl } : {}),
          metrics: view.metrics,
          columns: view.heatmap.columns,
          colors: {
            background: dom.readCssVariable("--bg_grouped_secondary_elevated", "#ffffff"),
            primaryText: dom.readCssVariable("--text_default_primary", "#171717"),
            secondaryText: dom.readCssVariable("--text_default_secondary", "#666666"),
            tertiarySurface: dom.readCssVariable("--bg_grouped_tertiary", "#f5f5f5"),
            accent: dom.readCssVariable("--icon_default_accent", "#0094fc"),
            brandSurface: dom.readCssVariable("--bg_grouped_secondary", "#ffffff"),
            brandMark: dom.readCssVariable("--icon_default_primary", "#171717"),
          },
        },
        dom.loadImage,
      );
      const blob = await canvas.toBlob();
      dom.downloadBlob(blob, accountUsageShareFileName(view.displayName));
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(false);
    }
  }, [dom, view]);

  if (!view.metrics) return null;

  return (
    <>
      <SettingsButton
        variant="gray"
        size="header"
        onClick={() => setOpen(true)}
        testId="account-usage-share-button"
      >
        <WebuiInline as="span" gap="tight">
          <AccountUsageShareIcon size={18} />
          分享
        </WebuiInline>
      </SettingsButton>
      {portalTarget && open
        ? createPortal(
            <>
              <SettingsDialog
                title="分享"
                variant="preview"
                dismissOnMaskClick
                onClose={() => setOpen(false)}
                testId="account-usage-share-preview"
              >
                <WebuiStack
                  gap="large"
                  align="center"
                  className="relative h-[350px] w-[392px] max-w-full"
                  data-testid="account-usage-share-preview-content"
                >
                  <WebuiStack
                    gap="none"
                    className="webui-account-usage-share-card h-[290px] w-[392px] max-w-full shrink-0 rounded-[20px] bg-bg_default_primary p-4"
                    data-testid="account-usage-share-card"
                  >
                    <WebuiStack gap="medium" className="h-[210px]">
                      <WebuiInline gap="medium" className="h-[50px]">
                        <AccountUsageShareAvatar
                          {...(view.avatarUrl ? { avatarUrl: view.avatarUrl } : {})}
                          displayName={view.displayName}
                        />
                        <WebuiStack gap="micro" justify="center" className="min-w-0">
                          <div className="truncate text-[13px] font-medium leading-[18.57px] text-text_default_primary">
                            {view.displayName}
                          </div>
                          <div className="truncate text-xs leading-4 text-text_default_tertiary">
                            {view.planLabel}
                          </div>
                        </WebuiStack>
                      </WebuiInline>
                      <div className="flex h-[42px] items-start gap-[54px]">
                        {[
                          { label: "累计 Token", value: formatSpacedToken(view.metrics.totalToken) },
                          { label: "单日峰值", value: formatSpacedToken(view.metrics.peakToken) },
                          { label: "用量排名", value: view.metrics.usageRanking },
                        ].map((metric) => (
                          <WebuiStack key={metric.label} gap="tight" align="start" className="min-w-0">
                            <div className="whitespace-nowrap text-[16px] font-medium leading-[23px] text-text_default_primary">
                              {metric.value}
                            </div>
                            <div className="whitespace-nowrap text-[11px] leading-[15px] text-text_default_secondary">
                              {metric.label}
                            </div>
                          </WebuiStack>
                        ))}
                      </div>
                      {view.heatmap ? (
                        <div className="h-[94px]">
                          <UsageHeatmap
                            model={view.heatmap}
                            columnCount={26}
                            showMonths={false}
                            align="start"
                            testId="account-usage-share-heatmap"
                          />
                        </div>
                      ) : null}
                    </WebuiStack>
                    <WebuiInline gap="compact" className="mt-5 h-7">
                      <WebuiIconBrand className="size-7 rounded-[7.656px]" />
                      <span
                        role="img"
                        aria-label="MiniMax Code"
                        className="inline-flex shrink-0 items-center text-text_default_primary"
                      >
                        <span className="text-sm font-medium leading-5">MiniMax Code</span>
                      </span>
                    </WebuiInline>
                  </WebuiStack>
                  <SettingsButton
                    variant="black"
                    size="pill"
                    disabled={exporting}
                    onClick={() => void saveImage()}
                    testId="account-usage-share-save"
                  >
                    <WebuiInline as="span" gap="tight">
                      {exporting ? (
                        <WebuiInline as="span" justify="center" className="size-4 shrink-0 leading-none">
                          <AccountUsageRefreshIcon size={16} />
                        </WebuiInline>
                      ) : (
                        <WebuiInline
                          as="span"
                          justify="center"
                          className="size-4 shrink-0 leading-none"
                          data-testid="account-usage-share-download-icon"
                        >
                          <AccountUsageDownloadIcon size={16} />
                        </WebuiInline>
                      )}
                      保存图片
                    </WebuiInline>
                  </SettingsButton>
                  {exportError ? (
                    <div className="absolute -bottom-6 text-center text-xs text-text_status_error">
                      图片保存失败，请重试。
                    </div>
                  ) : null}
                </WebuiStack>
              </SettingsDialog>
            </>,
            portalTarget,
          )
        : null}
    </>
  );
}

/** The share card's avatar: the image, or the initial letter. */
function AccountUsageShareAvatar({
  avatarUrl,
  displayName,
}: {
  readonly avatarUrl?: string;
  readonly displayName: string;
}): ReactElement {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);
  const initial = displayName.trim().slice(0, 1).toUpperCase() || "M";
  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className="size-[50px] shrink-0 rounded-full object-cover"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <WebuiInline align="center" justify="center" className="size-[50px] shrink-0 rounded-full bg-bg_grouped_tertiary text-lg font-semibold text-text_default_accent">
      {initial}
    </WebuiInline>
  );
}
