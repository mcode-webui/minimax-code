import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { WebuiIconBell, WebuiIconBrand, WebuiIconCommandUsage } from "../icons.js";
import {
  SigninClaimResult,
  SigninDayStatus,
  getCurrentSigninStreak,
  isSigninPanelClaimable,
  isSigninPanelClaimedToday,
} from "@mavis/shared/daily-signin";
import type {
  WebuiClaimSigninView,
  WebuiSigninPanelView,
  WebuiUsageQuotaResult,
  WebuiUsageQuotaVideoView,
  WebuiUsageQuotaWindowView,
  WebuiVersionInfo,
} from "../../server/port.js";
import type { WebuiTransport } from "../contracts.js";
import { SettingsModal, type WebuiSettingsModalCapabilities } from "./SettingsModal.js";
import { AccountLoginDialog } from "./AccountLoginDialog.js";
import type { MemoryHandoff } from "./settings/PersonalizationSettings.js";
import { evaluateOutsideClose } from "../projection/outside-close.js";

type AccountStatus = Record<string, unknown>;

/** Capability subset the user menu actually reads through `transport`.
 *  The menu itself only needs `getAccountStatus` and `getUsageQuota`, but
 *  the same reference is forwarded to `<SettingsModal>` which needs the
 *  full 9-member set — so the menu accepts that same set to avoid a second
 *  type split at the shell. `getSigninPanel` and `claimSignin` are not in
 *  this contract (they live in `WebuiTransport` but the brief keeps them
 *  as separate props on the menu for now), so they stay as siblings. */
type WebuiUserMenuCapabilities = WebuiSettingsModalCapabilities;

interface UserMenuProps {
  readonly collapsed: boolean;
  readonly hostLabel?: string;
  readonly dataDir?: string;
  readonly version?: WebuiVersionInfo;
  readonly sessionId?: string;
  /** Forwarded to the settings modal so the code-review page knows which
   *  workspace to read a change set from. */
  readonly workspaceDir?: string;
  /** Forwarded to the settings modal. The review page turns a diff line into
   *  a real editor jump through it. */
  readonly onOpenFileLine?: (path: string, line: number) => void;
  /** Capability source for the menu's own panels and the settings modal.
   *  Typed as the narrow 9-member contract so neither the menu nor the
   *  modal can accidentally start reading members they do not consume. */
  readonly transport?: WebuiUserMenuCapabilities;
  readonly getSigninPanel?: () => Promise<WebuiSigninPanelView>;
  readonly claimSignin?: () => Promise<WebuiClaimSigninView>;
  /** Forwarded to the settings modal, which owns 记忆摘要's 「在会话中创建」.
   *  The menu neither interprets nor stores it. */
  readonly onCreateMemorySession?: (input: MemoryHandoff) => void;
}

interface UsageState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly result?: WebuiUsageQuotaResult;
  readonly errorMessage?: string;
}

interface SigninState {
  readonly loading: boolean;
  readonly panel?: WebuiSigninPanelView;
  readonly claiming: boolean;
  readonly error?: string;
}

/** zh copy, verbatim from the desktop i18n dictionary's `signin.*` keys. */
const SIGNIN = {
  title: "每日签到",
  subtitle: "连续签到得更多积分",
  streakBefore: "本轮已连续签到 ",
  streakAfter: " 天",
  claimEarn: "签到得",
  bonusPrefix: "额外",
  claiming: "签到中…",
  claimedToday: "今日已签到",
  unavailable: "暂不可签到",
  error: "签到暂时不可用，请稍后重试",
  invalidResponse: "签到数据暂不可用",
  retry: "重试",
  progress: "签到进度",
  creditsInfo: "签到积分 30 天有效，仅限 MiniMax Code 使用。",
  creditsLink: "查看用量",
  creditsAria: "关于签到积分",
} as const;

function signinStatusText(status: number): string {
  return status === SigninDayStatus.Claimed
    ? "已签到"
    : status === SigninDayStatus.Claimable
      ? "今日可签到"
      : status === SigninDayStatus.Disabled
        ? "不可签到"
        : "未到签到日";
}

function formatSigninPoints(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatSigninError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid sign-in/iu.test(message) ? SIGNIN.invalidResponse : SIGNIN.error;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function accountString(account: AccountStatus | undefined, key: string): string | undefined {
  const candidates = [
    account?.[key],
    objectValue(account?.account)?.[key],
    objectValue(account?.user)?.[key],
    objectValue(account?.profile)?.[key],
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}

/** Mirrors the desktop's credit formatting: thousands separators, integer
 * rounding (the API reports `7726.2119999999995`, desktop shows `7,726`),
 * `—` when absent. */
function formatCredits(value: string | undefined): string {
  if (value === undefined) return "—";
  const numeric = Number(value.replace(/,/gu, ""));
  if (!Number.isFinite(numeric) || value.trim() === "") return value;
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Formats a quota reset timestamp the way the desktop popover does:
 * `3小时13分后重置` below a day, `5天7小时后重置` once days are involved,
 * `13分后重置` below an hour. A past or invalid timestamp renders nothing.
 */
export function formatUsageResetLabel(
  resetAtMs: number | undefined,
  nowMs: number = Date.now(),
): string | undefined {
  if (resetAtMs === undefined) return undefined;
  const delta = resetAtMs - nowMs;
  if (!Number.isFinite(delta) || delta <= 0) return undefined;
  const days = Math.floor(delta / 86_400_000);
  const hours = Math.floor((delta % 86_400_000) / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  const time =
    days > 0
      ? `${days}天${hours}小时`
      : hours > 0
        ? `${hours}小时${minutes}分`
        : `${minutes}分`;
  return `${time}后重置`;
}

function UsageGlyph({ kind }: { readonly kind: "settings" | "signin" }): ReactElement {
  const path = kind === "settings"
    ? "M10 2.5 11.2 4.1 13.1 3.8 13.8 5.6 15.6 6.3 15.3 8.2 16.9 9.4 15.8 11 16.2 12.9 14.4 13.6 13.7 15.4 11.8 15.1 10.6 16.7 9 15.6 7.1 16 6.4 14.2 4.6 13.5 4.9 11.6 3.3 10.4 4.4 8.8 4 6.9 5.8 6.2 6.5 4.4 8.4 4.7 9.6 3.1Z M10.1 8.1A1.9 1.9 0 1 0 10.1 11.9A1.9 1.9 0 0 0 10.1 8.1Z"
    : "M10 2.8 11.1 5.6 14 6.7 11.1 7.8 10 10.6 8.9 7.8 6 6.7 8.9 5.6 10 2.8ZM15.1 10.7 15.8 12.4 17.5 13.1 15.8 13.8 15.1 15.5 14.4 13.8 12.7 13.1 14.4 12.4 15.1 10.7ZM5 11.2 5.7 12.9 7.4 13.6 5.7 14.3 5 16 4.3 14.3 2.6 13.6 4.3 12.9 5 11.2Z";
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d={path} fill="currentColor" fillRule="evenodd" clipRule="evenodd" /></svg>;
}

function Chevron(): ReactElement {
  return <svg className="webui-user-menu-chevron" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7.5 4.75 5.25 5.25-5.25 5.25" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function MenuDivider(): ReactElement {
  return <div className="webui-user-menu-divider" role="separator" />;
}

/* ------------------------------------------------------------------ *
 * Daily check-in card — DOM and copy ported from the desktop's
 * `signin-card` (archon page chunk); icons are the desktop's own svgs.
 * ------------------------------------------------------------------ */

/** Info circle beside the card title (desktop `L.T3k`, size 14). */
function SigninInfoIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M8 1.5C11.5899 1.5 14.5 4.41015 14.5 8C14.5 11.5899 11.5899 14.5 8 14.5C4.41016 14.5 1.5 11.5898 1.5 8C1.5 4.41016 4.41016 1.50002 8 1.5ZM8 2.5C4.96245 2.50002 2.5 4.96244 2.5 8C2.5 11.0376 4.96245 13.5 8 13.5C11.0376 13.5 13.5 11.0376 13.5 8C13.5 4.96243 11.0376 2.5 8 2.5ZM8 7.5C8.27614 7.5 8.5 7.72386 8.5 8V10.667C8.49982 10.943 8.27603 11.167 8 11.167C7.72397 11.167 7.50018 10.943 7.5 10.667V8C7.5 7.72386 7.72386 7.5 8 7.5ZM8.00684 4.83301C8.28279 4.8331 8.50666 5.05707 8.50684 5.33301C8.50684 5.60909 8.2829 5.83292 8.00684 5.83301H8C7.72386 5.83301 7.5 5.60915 7.5 5.33301C7.50018 5.05702 7.72397 4.83301 8 4.83301H8.00684Z" fill="currentColor" />
    </svg>
  );
}

/** Check mark inside a day dot (desktop `L.cvi`, size 14). */
function SigninCheckIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className="signin-day-check" aria-hidden="true">
      <path d="M3.125 9.11857L8.0609 16.1699L16.875 3.83011" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Credits glyph in the claim button / bonus tag (desktop `L.J8f`). */
function SigninCreditsIcon({ size }: { readonly size: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M7.96545 1.35282C11.5553 1.35282 14.4654 4.26303 14.4655 7.85282C14.4655 11.4427 11.5553 14.3528 7.96545 14.3528C4.37566 14.3528 1.46545 11.4426 1.46545 7.85282C1.46553 4.26307 4.3757 1.35288 7.96545 1.35282ZM7.96545 2.35282C4.92799 2.35288 2.46553 4.81535 2.46545 7.85282C2.46545 10.8903 4.92794 13.3528 7.96545 13.3528C11.003 13.3528 13.4655 10.8904 13.4655 7.85282C13.4654 4.81531 11.003 2.35282 7.96545 2.35282ZM7.30042 4.30497C7.61361 3.7846 8.38548 3.7848 8.69885 4.30497L8.75842 4.42508L9.54163 6.34501L11.4625 7.12918C12.1426 7.40684 12.1426 8.36911 11.4625 8.64676L9.54163 9.42997L8.75842 11.3509C8.48077 12.0309 7.5185 12.0309 7.24084 11.3509L6.45667 9.42997L4.53674 8.64676C3.85714 8.36894 3.85705 7.40692 4.53674 7.12918L6.45667 6.34501L7.24084 4.42508L7.30042 4.30497ZM7.35413 6.79325C7.27083 6.9971 7.10875 7.15917 6.90491 7.24247L5.32288 7.88797L6.90491 8.53348C7.08319 8.60633 7.22941 8.73993 7.31897 8.90848L7.35413 8.9827L7.99963 10.5638L8.64514 8.9827C8.7284 8.77895 8.89064 8.6168 9.09436 8.53348L10.6754 7.88797L9.09436 7.24247C8.89069 7.15913 8.72838 6.99697 8.64514 6.79325L7.99963 5.21122L7.35413 6.79325Z" fill="currentColor" />
    </svg>
  );
}

/** Dotted connector between day dots (desktop `eK`). */
function SigninConnector({ className = "" }: { readonly className?: string }): ReactElement {
  return (
    <svg aria-hidden="true" focusable="false" className={`signin-connector ${className}`}>
      <line x1="0" y1="0.6" x2="100%" y2="0.6" stroke="currentColor" strokeWidth="1.2" strokeDasharray="0 2" strokeLinecap="round" />
    </svg>
  );
}

/** Light/dark artwork pair (desktop `eH`). */
function SigninArtwork({
  lightUrl,
  darkUrl,
  className,
}: {
  readonly lightUrl: string;
  readonly darkUrl: string;
  readonly className?: string;
}): ReactElement {
  const [failed, setFailed] = useState<readonly string[]>([]);
  const dark = darkUrl ?? lightUrl;
  return (
    <div className={className} aria-hidden="true">
      {([["light", lightUrl], ["dark", dark]] as const).map(([mode, url]) =>
        !failed.includes(url) ? (
          <img
            key={`${mode}:${url}`}
            src={url}
            alt=""
            draggable={false}
            className={mode === "light" ? "block dark:hidden" : "hidden dark:block"}
            onError={() => setFailed((list) => [...list, url])}
          />
        ) : null,
      )}
    </div>
  );
}

function SigninSkeleton(): ReactElement {
  return (
    <div data-testid="signin-card-skeleton" className="relative animate-pulse">
      <div className="ml-1 h-5 w-28 rounded bg-bg_default_tertiary" />
      <div className="ml-1 mt-1 h-4 w-36 rounded bg-bg_default_tertiary" />
      <div className="signin-progress mt-8">
        {Array.from({ length: 7 }, (_, index) => (
          <Fragment key={index}>
            {index > 0 ? <SigninConnector /> : null}
            <div className="signin-day">
              <div className="size-[22px] rounded-full bg-bg_default_tertiary" />
              <div className="h-[14px] w-6 rounded bg-bg_default_tertiary" />
            </div>
          </Fragment>
        ))}
      </div>
      <div className="mt-7 h-8 rounded-lg bg-bg_default_tertiary" />
    </div>
  );
}

/**
 * Coerce a sign-in panel off the wire before it reaches state.
 *
 * The transport resolves the server body verbatim (`resolve(frame.body as T)`
 * in `transport.ts`), and `SigninProgress` below does `[...days].sort(...)`
 * with no guard. A body that is not a panel — `{}`, a server error envelope,
 * anything without `days` — therefore threw `days is not iterable` and took
 * the entire app tree into the error boundary.
 *
 * The server does validate (`validateSigninPanel` throws
 * `Invalid sign-in panel`), so this is defence at the boundary rather than a
 * known live shape. It is here because the blast radius is the whole UI, not
 * one row: a malformed panel must degrade to an empty seven-day strip, never
 * to a blank page.
 */
function normalizeSigninPanel(value: unknown): WebuiSigninPanelView {
  const raw = value as Partial<WebuiSigninPanelView> | null;
  const days = Array.isArray(raw?.days)
    ? raw.days.filter((day): day is WebuiSigninPanelView["days"][number] =>
        Boolean(day) && typeof day === "object",
      )
    : [];
  return {
    scene:
      typeof raw?.scene === "number" ? (raw.scene as WebuiSigninPanelView["scene"]) : 0,
    days,
  };
}

/** Seven-day progress row (desktop `eY`). */
function SigninProgress({
  days,
  animatedDay,
}: {
  readonly days: WebuiSigninPanelView["days"];
  readonly animatedDay: number | null;
}): ReactElement {
  const sorted = [...days].sort((left, right) => left.day_no - right.day_no);
  return (
    <div className="signin-progress-scroll">
      <div role="list" aria-label={SIGNIN.progress} className="signin-progress">
        {sorted.map((day, index) => {
          const claimed = day.status === SigninDayStatus.Claimed;
          const claimable = day.status === SigninDayStatus.Claimable;
          const previous = index > 0 ? sorted[index - 1] : undefined;
          const connectorActive =
            previous?.status === SigninDayStatus.Claimed && (claimed || claimable);
          return (
            <Fragment key={day.day_no}>
              {index > 0 ? (
                <SigninConnector
                  className={connectorActive ? "text-text_default_accent opacity-50" : "text-border_default"}
                />
              ) : null}
              <div
                role="listitem"
                data-testid={`signin-day-${day.day_no}`}
                data-status={day.status}
                aria-label={`第 ${day.day_no} 天，${signinStatusText(day.status)}，${formatSigninPoints(day.points)} 积分`}
                aria-current={day.is_today ? "date" : undefined}
                className={`signin-day ${claimed ? "text-text_default_accent opacity-50" : claimable ? "text-text_default_accent" : "text-text_default_tertiary"}`}
              >
                <span
                  aria-hidden="true"
                  className={`signin-day-dot ${claimable ? "bg-text_default_accent text-text_default_inverted_static" : ""} ${claimed && animatedDay === day.day_no ? "signin-day-claimed-animation" : ""}`}
                >
                  <svg
                    aria-hidden="true"
                    focusable="false"
                    viewBox="0 0 22 22"
                    fill="none"
                    className={`signin-day-ring ${claimed || claimable ? "stroke-border_accent" : "stroke-border_default"}`}
                  >
                    <circle cx="11" cy="11" r="10.4" strokeWidth="1.2" />
                  </svg>
                  {claimed || claimable ? <SigninCheckIcon /> : null}
                </span>
                <span
                  aria-hidden="true"
                  data-testid={`signin-day-reward-${day.day_no}`}
                  className="signin-day-points"
                >
                  {formatSigninPoints(day.points)}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** Title row with the credits-info tooltip trigger (desktop `eU` + h2 row). */
function SigninCreditsInfo({ onNavigateToUsage }: { readonly onNavigateToUsage: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <span className="webui-signin-credits-anchor">
      <button
        type="button"
        aria-label={SIGNIN.creditsAria}
        className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-icon_default_tertiary transition-colors hover:text-icon_default_primary focus-visible:outline-none focus-visible:text-icon_default_primary"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <SigninInfoIcon />
      </button>
      {open ? (
        <span role="tooltip" className="webui-signin-credits-tooltip">
          <span className="text-xs leading-[18px]">
            <span>{SIGNIN.creditsInfo} </span>
            <button
              type="button"
              className="webui-signin-credits-link"
              onClick={() => {
                setOpen(false);
                onNavigateToUsage();
              }}
            >
              {SIGNIN.creditsLink}
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The daily check-in card: DOM, classes and copy ported from the desktop's
 * `signin-card` (menu context: `showCloseButton=false`,
 * `autoDismissAfterClaim=false`, `trackView=false`).
 */
export function SigninCard({
  panel,
  loading,
  claiming,
  error,
  animatedDay,
  onClaim,
  onRetry,
  onNavigateToUsage,
}: {
  readonly panel?: WebuiSigninPanelView;
  readonly loading: boolean;
  readonly claiming: boolean;
  readonly error?: string;
  readonly animatedDay: number | null;
  readonly onClaim: () => void;
  readonly onRetry: () => void;
  readonly onNavigateToUsage: () => void;
}): ReactElement {
  const streak = panel ? getCurrentSigninStreak(panel.days) : 0;
  const today = panel?.days.find((day) => day.is_today);
  const claimableDay =
    panel?.days.find((day) => day.is_today && day.status === SigninDayStatus.Claimable) ??
    panel?.days.find((day) => day.status === SigninDayStatus.Claimable);
  const claimable = panel ? isSigninPanelClaimable(panel) : false;
  const claimedToday = panel ? isSigninPanelClaimedToday(panel) : false;
  const bonus = today?.bonus_points ?? 0;
  const points = formatSigninPoints(claimableDay?.points ?? 0);
  const buttonLabel = claiming
    ? SIGNIN.claiming
    : claimedToday
      ? SIGNIN.claimedToday
      : panel && !claimable
        ? SIGNIN.unavailable
        : `${SIGNIN.claimEarn} ${points}`;

  return (
    <section data-testid="signin-card" aria-label={SIGNIN.title} className="signin-card-container">
      <div className="signin-card-surface relative rounded-2xl border-[0.5px] border-border_default bg-bg_grouped_secondary p-3 text-text_default_primary">
        <div className="signin-corner-clip" aria-hidden="true">
          <SigninArtwork
            lightUrl="/assets/img/corner-light.svg"
            darkUrl="/assets/img/corner-dark.svg"
            className="signin-corner-default"
          />
        </div>
        {loading && !panel ? (
          <SigninSkeleton />
        ) : panel ? (
          <>
            <div className="relative min-h-10 pl-1">
              <div className="flex min-h-5 items-start gap-1 pr-20">
                <h2 className="m-0 min-w-0 text-sm font-medium leading-5 break-words">
                  {SIGNIN.title}
                </h2>
                <SigninCreditsInfo onNavigateToUsage={onNavigateToUsage} />
              </div>
              {streak > 0 ? (
                <p data-testid="signin-streak" className="mb-0 mt-1 text-xs leading-4 text-text_default_secondary">
                  {SIGNIN.streakBefore}
                  <span className="text-text_default_accent">{streak}</span>
                  {SIGNIN.streakAfter}
                </p>
              ) : (
                <p className="mb-0 mt-1 text-xs leading-4 text-text_default_secondary">
                  {SIGNIN.subtitle}
                </p>
              )}
            </div>
            <div className="relative mt-8">
              <SigninProgress days={panel.days} animatedDay={animatedDay} />
              <div className="relative mt-7">
                {claimable ? (
                  <button
                    type="button"
                    className="signin-claim-button mavis-button black h-8 w-full rounded-lg text-sm font-medium"
                    disabled={claiming}
                    aria-label={buttonLabel}
                    onClick={onClaim}
                  >
                    {claiming ? (
                      <span className="inline-flex min-w-0 max-w-full items-center justify-center gap-0.5">
                        <span className="webui-signin-claim-spinner" aria-hidden="true" />
                        <span className="truncate">{SIGNIN.claiming}</span>
                      </span>
                    ) : (
                      <span className="inline-flex min-w-0 max-w-full items-center justify-center gap-0.5">
                        <span className="truncate">{SIGNIN.claimEarn}</span>
                        <span aria-hidden="true" className="inline-flex shrink-0">
                          <SigninCreditsIcon size={16} />
                        </span>
                        <span className="shrink-0">{points}</span>
                      </span>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    aria-label={buttonLabel}
                    className="h-8 w-full cursor-default rounded-lg border-0 bg-bg_interaction_primary_inactive p-0 text-sm font-medium text-text_label_primary_inactive"
                  >
                    {buttonLabel}
                  </button>
                )}
                {bonus > 0 ? (
                  <span
                    data-testid="signin-bonus"
                    className="signin-bonus-tag absolute right-0 top-[-9.5px] inline-flex max-w-full items-center gap-0.5 rounded-t-xl rounded-bl-xl bg-bg_interaction_accent_focus_blue px-2 py-0.5 text-xs font-medium leading-4 text-text_default_inverted_static"
                  >
                    <span className="truncate">{SIGNIN.bonusPrefix}</span>
                    <span aria-hidden="true" className="inline-flex shrink-0">
                      <SigninCreditsIcon size={12} />
                    </span>
                    <span className="shrink-0">{formatSigninPoints(bonus)}</span>
                  </span>
                ) : null}
              </div>
            </div>
            {error ? (
              <p role="alert" className="mb-0 mt-2 text-xs text-text_default_secondary">
                {error}
              </p>
            ) : null}
          </>
        ) : (
          <div
            data-testid="signin-card-error"
            role="alert"
            className="relative mt-8 flex min-h-[104px] flex-col items-center justify-center gap-2 px-4 text-center"
          >
            <p className="m-0 text-xs leading-4 text-text_default_secondary">
              {error ?? SIGNIN.error}
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="border-0 bg-transparent p-0 text-xs font-medium text-text_default_accent hover:underline"
            >
              {SIGNIN.retry}
            </button>
          </div>
        )}
      </div>
    </section>
  );
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
          <button
            type="button"
            className="webui-button-secondary"
            data-testid="usage-sign-in-button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onLogin}
          >
            登录
          </button>
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
        <span>{formatCredits(result.creditBalance)}</span>
      </div>
    </div>
  );
}

/** The usage sub-panel: desktop states (skeleton / error+retry / signed-out / content). */
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
    <div className="webui-user-menu-usage-panel" role="dialog" aria-label="用量">
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

export function UserMenu({
  collapsed,
  hostLabel,
  dataDir,
  sessionId,
  version,
  workspaceDir,
  onOpenFileLine,
  transport,
  getSigninPanel,
  claimSignin,
  onCreateMemorySession,
}: UserMenuProps): ReactElement {
  // Bound once per transport, not per render: the login dialog's effects
  // key on these callbacks, and a fresh binding every render would restart
  // its poll (and its begin) on every unrelated re-render.
  const { getUsageQuota, getAccountStatus, beginAccountLogin, getAccountLoginStatus, cancelAccountLogin, signOut } = useMemo(() => ({
    getUsageQuota: transport?.getUsageQuota?.bind(transport),
    getAccountStatus: transport?.getAccountStatus?.bind(transport),
    beginAccountLogin: transport?.beginAccountLogin?.bind(transport),
    getAccountLoginStatus: transport?.getAccountLoginStatus?.bind(transport),
    cancelAccountLogin: transport?.cancelAccountLogin?.bind(transport),
    signOut: transport?.signOut?.bind(transport),
  }), [transport]);
  const anchorRef = useRef<HTMLDivElement>(null);
  // The settings modal is the menu's own state, so the menu is also the only
  // thing that can dismiss it. Handing the memory to a conversation moves the
  // user off this surface entirely; leaving the modal parked over the home
  // composer would hide the very composer the hand-off just filled.
  const handleCreateMemorySession = useCallback((input: MemoryHandoff) => {
    setSettingsOpen(false);
    onCreateMemorySession?.(input);
  }, [onCreateMemorySession]);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usage, setUsage] = useState<UsageState>({ status: "idle" });
  const [signinOpen, setSigninOpen] = useState(false);
  const [signin, setSignin] = useState<SigninState>({ loading: false, claiming: false });
  const [animatedDay, setAnimatedDay] = useState<number | null>(null);
  const [account, setAccount] = useState<AccountStatus>();

  const closePanels = () => {
    setUsageOpen(false);
    setSigninOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      const insideContainer = Boolean(anchorRef.current?.contains(event.target));
      if (
        evaluateOutsideClose({
          surface: "userMenu",
          kind: "pointerdown",
          insideContainer,
        }) === "close"
      ) {
        setOpen(false);
        closePanels();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        evaluateOutsideClose({
          surface: "userMenu",
          kind: "keydown",
          key: event.key,
          insideContainer: false,
        }) === "close"
      ) {
        setOpen(false);
        closePanels();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !getAccountStatus) return;
    let cancelled = false;
    void getAccountStatus({ sessionId }).then((next) => {
      if (!cancelled) setAccount(next);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getAccountStatus, open, sessionId]);

  const loadUsage = (forceRefresh = false) => {
    setUsageOpen(true);
    setSigninOpen(false);
    if (!getUsageQuota) {
      setUsage({ status: "idle" });
      return;
    }
    setUsage({ status: "loading" });
    void getUsageQuota(forceRefresh ? { forceRefresh: true } : undefined)
      .then((result) => {
        setUsage({ status: "ready", result });
      })
      .catch((error: unknown) => {
        setUsage({
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const loadSignin = () => {
    setSigninOpen(true);
    setUsageOpen(false);
    if (!getSigninPanel) {
      setSignin({ loading: false, claiming: false, error: SIGNIN.error });
      return;
    }
    setSignin((state) => ({ ...state, loading: true, error: undefined }));
    void getSigninPanel()
      .then((panel) => {
        // Keep an in-flight claim flag: a silent refresh must not clear it.
        setSignin((state) => ({
          loading: false,
          claiming: state.claiming,
          panel: normalizeSigninPanel(panel),
          error: undefined,
        }));
      })
      .catch((error: unknown) => {
        setSignin((state) => ({ ...state, loading: false, error: formatSigninError(error) }));
      });
  };

  const claim = () => {
    if (!claimSignin || signin.claiming) return;
    setSignin((state) => ({ ...state, claiming: true, error: undefined }));
    void claimSignin()
      .then((result) => {
        setAnimatedDay(
          result.claim_result === SigninClaimResult.Claimed ? result.day_no : null,
        );
        setSignin({ loading: false, claiming: false, panel: normalizeSigninPanel(result.panel) });
      })
      .catch((error: unknown) => {
        setSignin((state) => ({ ...state, claiming: false, error: formatSigninError(error) }));
      });
  };

  const nickname = accountString(account, "nickname") ?? accountString(account, "name") ?? "MiniMax Code";
  const plan = accountString(account, "plan") ?? accountString(account, "planName") ?? (hostLabel ? `本地 · ${hostLabel}` : "本地");
  const identity = objectValue(account?.identity);
  const auth = objectValue(account?.auth);
  const uid =
    accountString(account, "uid") ??
    accountString(account, "userId") ??
    accountString(account, "id") ??
    accountString(identity, "uid") ??
    accountString(identity, "realUserID") ??
    accountString(auth, "realUserID");

  return <>
    <div ref={anchorRef} className={`webui-user-menu-anchor ${collapsed ? "webui-user-menu-anchor-collapsed" : ""}`} data-webui-rail-identity="true">
      {collapsed ? <button type="button" className="webui-user-menu-trigger-rail" data-testid="sidebar-user-menu-trigger-rail" aria-label="打开用户菜单" aria-expanded={open} onClick={() => { setOpen((value) => !value); closePanels(); }}><WebuiIconBrand /></button> : <button type="button" className="webui-user-menu-trigger" data-testid="sidebar-user-menu-trigger" aria-label="打开用户菜单" aria-expanded={open} onClick={() => { setOpen((value) => !value); closePanels(); }}>
        <span className="webui-user-menu-avatar"><WebuiIconBrand /></span>
        <span className="webui-user-menu-identity"><span>{nickname}</span><small>{plan}</small></span>
        <span className="webui-user-menu-bell" aria-hidden="true"><WebuiIconBell /></span>
      </button>}
      {open ? <div className="webui-user-menu-popover" role="menu">
        <div className="webui-user-menu-uid" aria-label="用户 ID">UID : {uid ?? "—"}</div>
        <div className="webui-user-menu-list">
          <button type="button" className="webui-user-menu-item" role="menuitem" data-testid="user-menu-settings" onClick={() => { setOpen(false); setSettingsOpen(true); }}><UsageGlyph kind="settings" /><span>设置</span><span className="webui-user-menu-shortcut">Ctrl+,</span></button>
          <button type="button" className="webui-user-menu-item" role="menuitem" data-testid="user-menu-account-login" onClick={() => { setOpen(false); setLoginOpen(true); }}><UsageGlyph kind="signin" /><span>账号与登录</span></button>
          <MenuDivider />
          <div className="webui-user-menu-signin-anchor" onMouseEnter={() => loadSignin()} onFocus={() => loadSignin()} onClick={(event) => { event.stopPropagation(); if (!signinOpen) loadSignin(); }}>
            <button type="button" className="webui-user-menu-item" role="menuitem" aria-haspopup="dialog" aria-expanded={signinOpen} data-testid="user-menu-signin"><UsageGlyph kind="signin" /><span>每日签到</span><Chevron /></button>
            {signinOpen ? (
              <div className="webui-user-menu-signin-panel" role="dialog" aria-label={SIGNIN.title}>
                <SigninCard
                  panel={signin.panel}
                  loading={signin.loading}
                  claiming={signin.claiming}
                  error={signin.error}
                  animatedDay={animatedDay}
                  onClaim={claim}
                  onRetry={loadSignin}
                  onNavigateToUsage={() => {
                    setSigninOpen(false);
                    loadUsage();
                  }}
                />
              </div>
            ) : null}
          </div>
          <div className="webui-user-menu-usage-anchor" onMouseEnter={() => loadUsage()} onFocus={() => loadUsage()}>
            <button type="button" className="webui-user-menu-item" role="menuitem" aria-haspopup="dialog" aria-expanded={usageOpen} data-testid="user-menu-usage" onClick={() => loadUsage()}><WebuiIconCommandUsage /><span>用量</span><Chevron /></button>
            {usageOpen ? <UsagePanel state={usage} onRetry={() => loadUsage(true)} onLogin={() => { setOpen(false); setLoginOpen(true); }} /> : null}
          </div>
        </div>
      </div> : null}
    </div>
    <AccountLoginDialog
      open={loginOpen}
      onClose={() => setLoginOpen(false)}
      onAuthenticated={() => {
        loadUsage(true);
      }}
      beginAccountLogin={beginAccountLogin}
      getAccountLoginStatus={getAccountLoginStatus}
      cancelAccountLogin={cancelAccountLogin}
      signOut={signOut}
    />
    {typeof document !== "undefined" ? createPortal(<SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} dataDir={dataDir} version={version} sessionId={sessionId} workspaceDir={workspaceDir} onOpenFileLine={onOpenFileLine} transport={transport} {...(onCreateMemorySession ? { onCreateMemorySession: handleCreateMemorySession } : {})} />, document.body) : <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} dataDir={dataDir} version={version} sessionId={sessionId} workspaceDir={workspaceDir} onOpenFileLine={onOpenFileLine} transport={transport} {...(onCreateMemorySession ? { onCreateMemorySession: handleCreateMemorySession } : {})} />}
  </>;
}
