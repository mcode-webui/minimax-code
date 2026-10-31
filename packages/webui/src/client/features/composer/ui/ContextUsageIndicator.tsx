// The context-usage indicator.
//
// It lives in Composer because Composer is its only production consumer: the
// gauge, the popover and the two projections they render are one surface, and
// while it sat in the Sessions rail every one of those facts was an edge out of
// Sessions into four other businesses — including two back into Composer itself.
// A chip nobody else renders is not Sessions' surface.
//
// The composer's context gauge and its popover: the ring, the five-hour and weekly windows, the
// token-plan figures when the selected model is a plan model, the breakdown rows, and the placement
// arithmetic that keeps the popover inside the viewport. Its opted-in flag, hover and breakdown state
// live here; the composer passes the usage it read, the quota, and the selected model in.

import type { WebuiModelEntry } from "../../../../shared/contracts/models.js";
import { IconChevronDown } from "@tabler/icons-react";
import type { WebuiUsageQuotaResult } from "../../../../shared/contracts/usage-quota.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { breakdownSegmentPercent, breakdownShareLabel, breakdownSwatchStyle, contextBreakdownRows, drawableBreakdownRows } from "../projection/context-breakdown.js";
import {
  positionContextUsagePopover,
} from "../projection/context-usage-popover.js";
import { readContextWindowUsage } from "../contracts/context-usage.js";
import { isTokenPlanModel } from "../../models/projection/token-plan-model.public.js";
import { formatUsageResetLabel } from "../../account/projection/usage.public.js";
import { WebuiDropdown, type WebuiDropdownPlacementArgs } from "../../../ui/Dropdown.js";
import { FeedbackProgress } from "../../../ui/feedback.js";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

export function ContextUsageIndicator({ usage, usageQuota, planModel }: {
  readonly usage?: Record<string, unknown>;
  readonly usageQuota?: WebuiUsageQuotaResult;
  /** The selected model, for deciding whether the plan figures describe it. */
  readonly planModel?: WebuiModelEntry;
}): ReactElement | null {
  const { dom, storage } = useWebuiBrowserCapabilities();
  const [enabled, setEnabled] = useState(() => storage.getItem("webui-context-window-usage") !== "false");
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Folded every time the panel opens, including on a re-open. The split is a
  // reading task the user opted into last time; carrying the state across
  // openings would make a glance at the panel land on six rows of percentages
  // because of something they did a minute ago.
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  /**
   * The panel's own placement rule.
   *
   * The shared skeleton places the panel against the ring's rectangle and
   * supplies the surface, the motion and the dismissal; WHAT the rule says is
   * the composer's business, and it is not the general one: the panel opens
   * ABOVE the ring with its right edges aligned, never below, and it is
   * clamped into the viewport rather than flipped.
   *
   * The rule lives in `projection/context-usage-popover.ts` and is pure, so it
   * can be tested against real numbers instead of a screenshot.
   */
  const placePanel = useCallback(
    ({ anchor, surface, viewport }: WebuiDropdownPlacementArgs) =>
      positionContextUsagePopover({ anchor, surface, viewport }),
    [],
  );  useEffect(() => {
    const refresh = () => setEnabled(storage.getItem("webui-context-window-usage") !== "false");
    const stopStorage = dom.listenForStorageChange(refresh);
    const stopPreferenceChange = dom.listenForContextWindowUsageChange(refresh);
    return () => {
      stopStorage();
      stopPreferenceChange();
    };
  }, [dom, storage]);
  // The panel is a CLICK surface, not a hover one. It holds six breakdown rows
  // and a set of plan meters, and opening all of that under a pointer means
  // every pass across the composer — including the one en route to the send
  // button — throws a full panel over the transcript and then takes it away
  // again. A pointer crossing the ring now gets the ring's NAME and nothing
  // else, which is the only question a pointer can usefully ask about a
  // progress ring, and the click is what says "show me the numbers".
  // The dismissal — an outside press and Escape — belongs to the shared
  // skeleton now, which reads the press before the click reaches whatever was
  // underneath.
  if (!enabled || !usage) return null;  // The runtime protocol's names, not invented ones — see
  // `server/projections/context-snapshot.ts`, which is the other half of this
  // read. The snake_case spellings are the wire's, so they are the primary
  // keys; the camelCase ones stay accepted because `WebuiUsageQuotaResult` and
  // the quota rows already publish that vocabulary, and a readout that renders
  // from one shape and not the other is a readout that half the time is blank.
  // The numbers are read through the one helper that knows every spelling the
  // runtime's usage travels in — see `readContextWindowUsage` for why the
  // spellings differ and what reading only one of them cost.
  const { used, limit } = readContextWindowUsage(usage);
  // The ring appears as soon as the session HAS context. A single token spent
  // is a spent window: the ring is the statement "this session has context,
  // and here is how much of the window it is", and a ring that waited for the
  // session to be "big enough" answered the reader's question by staying
  // silent. A session with no usage record at all still shows nothing —
  // there is no window to be partly full.
  if (used === undefined || used < 0) return null;
  // The window is a SEPARATE fact. A model whose window the runtime does not
  // know still has a spent window, and "we spent this much, and the window is
  // unknown" is a fact the readout can carry — so the ring is there, and it
  // says so instead of claiming a percentage it cannot compute.
  const windowKnown = limit !== undefined && limit > 0;
  const percent = windowKnown ? Math.min(100, Math.max(0, Math.round(used / limit * 100))) : 0;
  const circumference = 2 * Math.PI * 7;
  const label = windowKnown
    ? `${percent}% · ${formatContextTokens(used)} / ${formatContextTokens(limit)} tokens`
    : `${formatContextTokens(used)} tokens · 窗口大小未知`;
  // Always all six categories, in the reference's fixed order, with a dash for
  // whatever the engine did not report. See `features/composer/projection/context-breakdown.ts`
  // for why a missing category is a dash and not `0.0%`.
  const breakdownRows = contextBreakdownRows(usage.components, used);
  const drawableRows = drawableBreakdownRows(breakdownRows);
  // Whether the engine accounted for ANY of the used tokens, which is the only
  // thing this decides: with nothing to subdivide, the bar draws as one solid
  // fill of the window instead of as segments. It is not the bar's denominator
  // — that is the window, and the two being confused is what made a 43% session
  // draw a full bar.
  const componentsTotal = drawableRows.reduce(
    (total, row) => total + (row.tokens ?? 0),
    0,
  );
  // The plan meters describe the ACCOUNT's subscription, so they only belong
  // here when the selected model is one that subscription pays for. Beside
  // anyone else's model they were a claim about a plan that provider does not
  // sell — the same numbers, under the wrong heading, for the wrong bill.
  const quotaResult = usageQuota?.signedIn && isTokenPlanModel(planModel) ? usageQuota : undefined;
  const quota = quotaResult?.quota;
  const planLabel = quotaResult?.tokenPlanTier ?? (quotaResult?.hasTokenPlan ? "Token Plan" : "未订阅 Token Plan");
  const quotaRows = quota ? [
    { label: "5 小时限额", window: quota.fiveHour },
    { label: "周限额", window: quota.weekly },
    ...(quota.video ? [{ label: "视频限额", window: quota.video }] : []),
  ] : [];
  return (
    <div
      ref={anchorRef}
      className="webui-context-usage-anchor"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <WebuiDropdown
          managed
          managedLayerId="context-usage"
        open={open}
        onOpen={() => {
          setOpen(true);
          setBreakdownOpen(false);
        }}
        onClose={() => setOpen(false)}
        role="dialog"
        ariaLabel="上下文窗口使用情况"
        className="webui-context-usage-popover"
        anchorElementRef={anchorRef}
        placement={placePanel}
        trigger={(triggerProps) => (
          <button
            type="button"
            className="webui-context-usage-trigger"
            aria-label={`上下文窗口使用 ${label}`}
            title={`上下文窗口 ${label}`}
            data-testid="composer-context-usage"
            {...triggerProps}
          >
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <circle className="webui-context-usage-track" cx="9" cy="9" r="7" />
              <circle
                className="webui-context-usage-value"
                cx="9"
                cy="9"
                r="7"
                style={{
                  strokeDasharray: circumference,
                  strokeDashoffset: circumference * (1 - percent / 100),
                }}
              />
            </svg>
          </button>
        )}
      >
        {/*
            The heading is the panel's own disclosure control. The panel opens
            showing how full the window is and how much of the plan is left —
            the two things a glance is for — and the six-category split stays
            folded until asked for, because six rows of percentages is a reading
            task, not a glance, and the user who wants it is already looking at
            a panel they opened on purpose.

            The chevron is the whole affordance. A caret beside a number is the
            convention for "there is more under this", and adding
            a separate "详情" control next to it would be two controls for one
            section.
          */}
          <button
            type="button"
            className="webui-context-usage-heading webui-context-usage-disclosure"
            aria-expanded={breakdownOpen}
            aria-controls="webui-context-usage-breakdown"
            data-webui-context-disclosure={breakdownOpen ? "open" : "closed"}
            onClick={() => setBreakdownOpen((value) => !value)}
          >
            <span>上下文窗口</span>
            <span className="webui-context-usage-heading-value">
              {windowKnown ? `${percent}%` : "—"}
              <span
                aria-hidden="true"
                className={`webui-context-usage-chevron${breakdownOpen ? " is-open" : ""}`}
              >
                <IconChevronDown aria-hidden="true" size={16} stroke={1.7} />
              </span>
            </span>
          </button>
          <FeedbackProgress
            className="webui-context-usage-bar"
            label="上下文窗口使用量"
            value={percent}
            // A bar with no value is the indeterminate form: the window is
            // unknown, so there is no share of it to report.
            indeterminate={!windowKnown}
          >
            {componentsTotal > 0 ? drawableRows.map((row) => (
              <span
                key={row.kind}
                className="webui-context-usage-bar-segment"
                style={{ width: `${breakdownSegmentPercent(row, limit ?? 0)}%`, ...breakdownSwatchStyle(row) }}
              />
            )) : <span style={{ width: `${percent}%` }} />}
          </FeedbackProgress>
          <div className="webui-context-usage-tokens">
            {windowKnown
              ? `${formatContextTokens(used)} / ${formatContextTokens(limit)} tokens`
              : `${formatContextTokens(used)} tokens · 窗口大小未知`}
          </div>
          {/*
            Hidden rather than unmounted, so the bar's segment widths above and
            the panel's height do not both jump on the first open. `hidden` is
            also what keeps the six rows out of the tab order and out of the
            accessibility tree while they are folded.
          */}
          <div
            id="webui-context-usage-breakdown"
            className="webui-context-usage-components"
            aria-label="上下文构成"
            data-webui-context-breakdown={breakdownOpen ? "open" : "closed"}
            hidden={!breakdownOpen}
          >
            {breakdownRows.map((row) => (
              <div
                className="webui-context-usage-component"
                key={row.kind}
                data-webui-context-category={row.kind}
                data-webui-context-reported={row.tokens === null ? "false" : "true"}
              >
                <span className="webui-context-usage-component-label">
                  <span
                    className="webui-context-usage-swatch"
                    style={breakdownSwatchStyle(row)}
                  />
                  {row.label}
                </span>
                <span>{breakdownShareLabel(row)}</span>
              </div>
            ))}
          </div>
          {quotaResult ? (
            <>
              <div className="webui-context-usage-divider" />
              <div className="webui-context-usage-plan">套餐用量 · {planLabel}</div>
              {quotaRows.length > 0 ? quotaRows.map(({ label: quotaLabel, window }) => {
                const usedPercent = "usedPercent" in window ? window.usedPercent : undefined;
                const totalPercent = "totalPercent" in window ? window.totalPercent : undefined;
                const videoUsed = "usedCount" in window ? window.usedCount : undefined;
                const videoTotal = "totalCount" in window ? window.totalCount : undefined;
                const progress = usedPercent ?? (videoUsed !== undefined && videoTotal ? videoUsed / videoTotal * 100 : undefined);
                const value = window.unlimited
                  ? "无限制"
                  : usedPercent !== undefined
                    ? `${usedPercent}% / ${totalPercent ?? 100}%`
                    : videoUsed !== undefined && videoTotal !== undefined
                      ? `${videoUsed} / ${videoTotal}`
                      : "—";
                const reset = formatUsageResetLabel(window.resetAtMs);
                return (
                  <div className="webui-context-usage-quota" key={quotaLabel}>
                    <div className="webui-context-usage-heading"><span>{quotaLabel}</span><span>{value}</span></div>
                    <div className="webui-context-usage-quota-bar"><span style={{ width: `${Math.max(0, Math.min(100, progress ?? 0))}%` }} /></div>
                    {reset ? <div className="webui-context-usage-reset">{reset}</div> : null}
                  </div>
                );
              }) : <div className="webui-context-usage-tokens">当前套餐没有可显示的限额</div>}
            </>
          ) : null}
      </WebuiDropdown>
      {/*
        The hover label, and it is the WHOLE of what hovering produces. A ring
        with no name is the one control in the toolbar that says nothing about
        what it measures; naming it costs one line, and the alternative — the
        full panel under the pointer — costs a panel over the transcript on
        every pass towards the send button.

        The name only, not the percentage: the panel is one click away and
        already opens on this control, so a tooltip carrying figures would be a
        second readout of the same ring at a different size. `aria-hidden`
        because the button's own label already announces it, and a bubble that
        duplicates what assistive technology was just told is read twice.
      */}
      <span
        className="webui-context-usage-label"
        aria-hidden="true"
        data-webui-context-usage-label={hovered && !open ? "true" : "false"}
      >
        上下文窗口
      </span>
    </div>
  );
}

function formatContextTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}
