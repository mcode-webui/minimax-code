// The quota popover.
//
// The panel's four answers — loading, error, plan-and-credits, quota windows — the skeleton and rows
// that render them, and the reset-label formatter the panel uses. `UsagePanel` is the entry
// point the menu renders; it takes the state and two callbacks and holds no state of its own.

import type { ReactElement } from "react";
import { formatWebuiCredits } from "../../../contracts/value-readers.js";
import type {
  WebuiUsageQuotaResult,
  WebuiUsageQuotaVideoView,
  WebuiUsageQuotaWindowView,
} from "../../../../shared/contracts/usage-quota.js";
import { formatUsageResetLabel } from "../projection/usage.public.js";
import { WebuiButton } from "../../../ui/button.js";

export interface UsageState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly result?: WebuiUsageQuotaResult;
  readonly errorMessage?: string;
}

function UsageSkeleton({ animated }: { readonly animated?: boolean }): ReactElement {
  const bars = () => (
    <>
      <div className="webui-user-menu-usage-skeleton-line">
        <span className="webui-user-menu-usage-skeleton-bar webui-user-menu-usage-skeleton-bar--a" />
        <span className="webui-user-menu-usage-skeleton-bar webui-user-menu-usage-skeleton-bar--b" />
      </div>
      <div className="webui-user-menu-usage-skeleton-line">
        <span className="webui-user-menu-usage-skeleton-bar webui-user-menu-usage-skeleton-bar--c" />
        <span className="webui-user-menu-usage-skeleton-bar webui-user-menu-usage-skeleton-bar--d" />
      </div>
    </>
  );
  return (
    <div
      className={`webui-user-menu-usage-skeleton${animated ? " is-animated" : ""}`}
      data-testid={animated ? "usage-popover-loading" : "usage-popover-pending"}
    >
      <div className="webui-user-menu-usage-skeleton-row">{bars()}</div>
      <div className="webui-user-menu-usage-skeleton-row">{bars()}</div>
    </div>
  );
}

interface QuotaRowProps {
  readonly label: string;
  readonly valueLabel: string;
  readonly resetLabel?: string;
  readonly totalLabel?: string;
  readonly position: "first" | "middle" | "last" | "solo";
}

function QuotaRow(props: QuotaRowProps): ReactElement {
  return (
    <div className={`webui-user-menu-quota-row webui-user-menu-quota-row--${props.position}`}>
      <div className="webui-user-menu-quota-line">
        <span className="webui-user-menu-quota-label">{props.label}</span>
        <span className="webui-user-menu-quota-value">{props.valueLabel}</span>
      </div>
      {props.resetLabel || props.totalLabel ? (
        <div className="webui-user-menu-quota-line webui-user-menu-quota-meta">
          <span>{props.resetLabel ?? ""}</span>
          <span>{props.totalLabel ?? ""}</span>
        </div>
      ) : null}
    </div>
  );
}

function windowValueLabel(window: WebuiUsageQuotaWindowView): string {
  if (window.unlimited) return "无限制";
  return window.usedPercent === undefined ? "—" : `已用 ${window.usedPercent}%`;
}

function windowTotalLabel(window: WebuiUsageQuotaWindowView): string | undefined {
  if (window.unlimited || window.totalPercent === undefined) return undefined;
  return `总额 ${window.totalPercent}%`;
}

function videoValueLabel(video: WebuiUsageQuotaVideoView): string {
  if (video.unlimited) return "无限制";
  if (video.usedCount === undefined || video.totalCount === undefined) return "—";
  return `${video.usedCount}/${video.totalCount}`;
}

const AUTH_ERROR_PATTERN = /cookie|unauthori[sz]ed|token|login/iu;

function UsageReady({
  result,
  onLogin,
}: {
  readonly result?: WebuiUsageQuotaResult;
  readonly onLogin?: () => void;
}): ReactElement {
  if (!result || result.signedIn === false) {
    return (
      <div
        className="webui-user-menu-usage-signed-out"
        data-testid="usage-popover-no-workspace"
      >
        登录后查看用量
        {/* The button's mousedown is default-prevented: focus would bubble
         * (focusin) to the usage anchor's onFocus → loadUsage, whose loading
         * state swaps this block for the skeleton — the pressed node is
         * replaced mid-click and the browser never dispatches the click.
         * Keeping the focus where it was makes the first click land like
         * every later one. */}
        {onLogin ? (
          <WebuiButton variant="grouped" size="pill" data-testid="usage-sign-in-button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onLogin}
          >
            登录
          </WebuiButton>
        ) : null}
      </div>
    );
  }
  const quota = result.quota;
  const rows: { label: string; valueLabel: string; resetAtMs?: number; totalLabel?: string }[] = [];
  if (quota) {
    rows.push({
      label: "5 小时限额",
      valueLabel: windowValueLabel(quota.fiveHour),
      resetAtMs: quota.fiveHour.resetAtMs,
      totalLabel: windowTotalLabel(quota.fiveHour),
    });
    rows.push({
      label: "周限额",
      valueLabel: windowValueLabel(quota.weekly),
      resetAtMs: quota.weekly.resetAtMs,
      totalLabel: windowTotalLabel(quota.weekly),
    });
    if (quota.video) {
      rows.push({
        label: "视频限额",
        valueLabel: videoValueLabel(quota.video),
        resetAtMs: quota.video.resetAtMs,
      });
    }
  }
  const position = (index: number): QuotaRowProps["position"] =>
    rows.length === 1
      ? "solo"
      : index === 0
        ? "first"
        : index === rows.length - 1
          ? "last"
          : "middle";
  const showPlanRow = result.hasTokenPlan === false;
  return (
    <div className="webui-user-menu-usage-content" data-testid="usage-popover-content">
      {showPlanRow ? (
        <div className="webui-user-menu-quota-rows">
          <div className="webui-user-menu-quota-line">
            <span className="webui-user-menu-quota-label">Token Plan</span>
            <span className="webui-user-menu-quota-value webui-user-menu-quota-value--tertiary">未订阅</span>
          </div>
        </div>
      ) : rows.length > 0 ? (
        <div className="webui-user-menu-quota-rows">
          {rows.map((row, index) => (
            <QuotaRow
              key={row.label}
              label={row.label}
              valueLabel={row.valueLabel}
              resetLabel={formatUsageResetLabel(row.resetAtMs)}
              totalLabel={row.totalLabel}
              position={position(index)}
            />
          ))}
        </div>
      ) : null}
      {showPlanRow || rows.length > 0 ? <div className="webui-user-menu-usage-hairline" /> : null}
      <div className="webui-user-menu-credits-row">
        <span>积分</span>
        <span>{formatWebuiCredits(result.creditBalance)}</span>
      </div>
    </div>
  );
}

/** The usage sub-panel: skeleton / error+retry / signed-out / content states. */
export function UsagePanel({
  state,
  onRetry,
  onLogin,
}: {
  readonly state: UsageState;
  readonly onRetry: () => void;
  /** Opens the account login dialog from the signed-out usage block. */
  readonly onLogin?: () => void;
}): ReactElement {
  return (
    // The shared surface, not the shared skeleton: this panel opens on hover,
    // focus or click and cannot be dismissed from inside itself, so it needs no
    // trigger and no outside-press handling — only the shared look and motion.
    <div className="webui-user-menu-usage-panel webui-dropdown-surface" role="dialog" aria-label="用量">
      {state.status === "loading" ? <UsageSkeleton animated /> : null}
      {state.status === "idle" ? <UsageSkeleton /> : null}
      {state.status === "error" ? (
        <div className="webui-user-menu-usage-error" data-testid="usage-popover-error">
          <span className="webui-user-menu-usage-error-title">
            {state.errorMessage && AUTH_ERROR_PATTERN.test(state.errorMessage)
              ? "请重新登录"
              : "加载失败"}
          </span>
          <button type="button" className="webui-user-menu-usage-retry" onClick={onRetry}>
            重试
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? <UsageReady result={state.result} onLogin={onLogin} /> : null}
    </div>
  );
}
