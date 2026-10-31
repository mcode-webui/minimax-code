// The 远程控制 tab body.
//
// The markup is transcribed from the Desktop's 远程控制 tab, measured on the live Desktop
// (its computed styles and rendered markup): the hero, the subtitle, the rounded card
// with its three icon rows and their 1px dividers, the full-width 连接 button, the SSH entry
// beneath it, and the two app-store marks over the minimum-version line.
//
// ## What changed and why
//
//   * The Desktop's `desktop-text-*` typography classes do not exist in the WebUI. Each one is
//     replaced by the size and weight utilities the Desktop's own markup already carries
//     (`text-4xl font-medium leading-[1.2]`, `text-base`, `text-sm`, `text-xs`), so the measured
//     sizes are reproduced with the WebUI's type scale rather than a copy of the Desktop's.
//   * The card's `ring-[0.5px] ring-inset ring-border_default` becomes
//     `border-[0.5px] border-border_default`: the WebUI's Tailwind theme has no `ringColor`
//     entry for the token, and a half-pixel border is the same line.
//   * The three row icons are the WebUI's own glyphs — the phone (`WebuiIconRemote`), the chat
//     bubble (`WebuiIconSession`) and the globe (`WebuiIconGlobe`) — not the Desktop's SVG paths.
//   * The phone mockup column keeps the Desktop's geometry and uses the WebUI's own copy of the
//     same asset (`/assets/img/remote_control_phone_zh.png`, already in `client/assets/img`).
//
// ## The two pieces
//
// `RemoteControlPanelView` is a pure render of a snapshot: it takes the model and the callbacks
// and nothing else, so a test can assert the page's wording with `renderToStaticMarkup` (this
// package has no jsdom). `RemoteControlPanel` is the thin wrapper that subscribes to the owner
// with `useSyncExternalStore` and hands the view a snapshot.
import { Fragment, useEffect, useState, useSyncExternalStore, type ReactElement } from "react";

import { WebuiIconGlobe, WebuiIconRemote, WebuiIconSession } from "../../../shell/icons.js";
import { WebuiButton } from "../../../ui/button.js";
import type {
  createWebuiRemoteControlOwner,
  WebuiRemoteControlSnapshot,
} from "../application/remote-control-owner.js";
import {
  webuiRemoteControlPanelModel,
  type WebuiRemoteControlPanelModel,
} from "../projection/remote-control-panel.js";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";

export interface RemoteControlPanelViewProps {
  readonly snapshot: WebuiRemoteControlSnapshot;
  /** The clock, so the pairing countdown is placeable in a test. */
  readonly nowMs: number;
  readonly busy?: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onResolveUnbind: (confirmed: boolean) => void;
  readonly onOpenSsh?: () => void;
}

/** The icon each feature row carries, in the Desktop's order. */
function featureIcon(key: string): ReactElement {
  if (key === "continuous") return <WebuiIconSession className="h-5 w-5" />;
  if (key === "anywhere") return <WebuiIconGlobe className="h-5 w-5" />;
  return <WebuiIconRemote className="h-5 w-5" />;
}

/**
 * The pairing page.
 *
 * Everything here is a function of the model, so the same markup serves the idle page, the
 * pairing page and the linked page.
 */
export function RemoteControlPanelView(props: RemoteControlPanelViewProps): ReactElement {
  const model = webuiRemoteControlPanelModel(props.snapshot, props.nowMs);
  const sshDisabled = props.onOpenSsh === undefined;
  return (
    <div className="flex h-full w-full overflow-hidden">
      <div className="flex-1 min-w-0 flex flex-col items-center px-6 py-8 overflow-y-auto">
        <div className="flex w-full max-w-[612px] flex-1 flex-col items-center justify-center">
          <h1 className="text-center text-4xl font-medium leading-[1.2] text-text_default_primary">
            {model.title}
          </h1>
          <p className="mt-3 px-6 text-center text-base leading-relaxed text-text_default_secondary">
            {model.subtitle}
          </p>
          <div className="mt-10 flex w-full max-w-[534px] flex-col items-stretch gap-10 rounded-3xl border-[0.5px] border-border_default bg-bg_default_primary px-5 pb-5 pt-6">
            <div className="flex flex-col gap-6">
              {model.features.map((feature, index) => (
                <Fragment key={feature.key}>
                  {index > 0 ? (
                    <div aria-hidden="true" className="relative h-0 w-full">
                      <div
                        className="absolute inset-x-0 top-0 h-px origin-top scale-y-50"
                        style={{ backgroundColor: "var(--border_default)" }}
                      />
                    </div>
                  ) : null}
                  <div className="flex h-5 items-center gap-2">
                    <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-icon_default_primary">
                      {featureIcon(feature.key)}
                    </div>
                    <span className="text-sm leading-5 text-text_default_primary">{feature.text}</span>
                  </div>
                </Fragment>
              ))}
            </div>
            {model.error ? (
              <FeedbackLiveRegion
                className="text-center text-sm text-text_default_secondary"
                testId="rc-error"
              >
                {model.error}
              </FeedbackLiveRegion>
            ) : null}
            {model.pairingCode ? (
              <div
                data-testid="rc-pairing-code"
                className="flex w-full flex-col items-center gap-2 rounded-2xl bg-bg_grouped_secondary_elevated px-4 py-4"
              >
                <span className="text-sm text-text_default_secondary">在 MiniMax App 中输入配对码</span>
                <span className="text-3xl font-medium tracking-[0.3em] text-text_default_primary">
                  {model.pairingCode}
                </span>
                <span className="text-xs text-text_default_tertiary">
                  {model.pairingExpiresInSeconds ?? 0} 秒后失效
                </span>
              </div>
            ) : null}
            {model.showsConnectedDevice ? (
              <div
                data-testid="rc-connected-device"
                className="flex w-full flex-col items-center gap-1"
              >
                <span className="text-sm text-text_default_primary">
                  {model.connectedDevice ?? "已连接的设备"}
                </span>
                <span className="text-xs text-text_default_tertiary">手机已连接，可远程接管这台电脑</span>
              </div>
            ) : null}
            {model.pendingUnbind ? (
              <div
                data-testid="rc-pending-unbind"
                className="flex w-full flex-col items-center gap-3 rounded-2xl border-[0.5px] border-border_default px-4 py-4"
              >
                <span className="text-sm text-text_default_primary">手机端请求解绑这台电脑</span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    data-testid="rc-unbind-confirm"
                    onClick={() => props.onResolveUnbind(true)}
                    className="rounded-lg bg-bg_interaction_primary_default px-3 py-1 text-sm font-medium text-text_label_primary_default transition-opacity hover:opacity-90"
                  >
                    确认解绑
                  </button>
                  <WebuiButton
                    variant="quiet-highlight"
                    size="inline"
                    data-testid="rc-unbind-reject"
                    onClick={() => props.onResolveUnbind(false)}
                  >
                    取消
                  </WebuiButton>
                </div>
              </div>
            ) : null}
            <div className="flex w-full flex-col items-center gap-3">
              <button
                type="button"
                data-testid="rc-connect"
                onClick={props.onConnect}
                disabled={props.busy === true || !model.canConnect}
                className="h-9 w-full rounded-lg bg-bg_interaction_primary_default text-sm font-medium text-text_label_primary_default transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-50"
              >
                {model.connectLabel}
              </button>
              {model.showsConnectedDevice ? (
                <WebuiButton
                  variant="quiet-highlight"
                  size="inline"
                  data-testid="rc-disconnect"
                  onClick={props.onDisconnect}
                  disabled={props.busy === true}
                >
                  断开连接
                </WebuiButton>
              ) : null}
              <WebuiButton
                variant={sshDisabled ? "quiet-subtle" : "quiet-highlight"}
                size="inline"
                className={sshDisabled ? "cursor-default" : undefined}
                data-testid="remote-control-ssh-entry"
                aria-label={model.sshAriaLabel}
                aria-disabled={sshDisabled ? "true" : undefined}
                onClick={sshDisabled ? undefined : props.onOpenSsh}
              >
                {model.sshLabel}
              </WebuiButton>
            </div>
          </div>
          <div
            data-testid="rc-version-qr"
            className="mt-8 flex w-full max-w-[420px] flex-col items-center gap-2 pb-4"
          >
            <div
              className="flex flex-row items-center gap-3 text-sm"
              role="group"
              aria-label={model.minimumVersion}
            >
              {model.platformMarks.map((mark, index) => (
                <Fragment key={mark.key}>
                  {index > 0 ? (
                    <span aria-hidden="true" className="h-3 w-px bg-text_default_quaternary" />
                  ) : null}
                  <div className="group relative inline-flex">
                    <button
                      type="button"
                      data-testid={`rc-platform-${mark.key}`}
                      data-enabled="true"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-[8px] px-2 py-1.5 text-sm font-medium text-text_default_tertiary transition-colors hover:bg-bg_interaction_tertiary_hover hover:text-text_default_primary"
                    >
                      <span>{mark.label}</span>
                    </button>
                  </div>
                </Fragment>
              ))}
            </div>
            <p className="text-center text-xs text-text_default_tertiary">{model.minimumVersion}</p>
          </div>
        </div>
      </div>
      <div className="hidden w-[548px] flex-shrink-0 p-4 lg:block">
        <div className="flex h-full w-full justify-center overflow-hidden rounded-3xl bg-[#7DC6FF]">
          <img
            src="/assets/img/remote_control_phone_zh.png"
            alt=""
            className="w-[400px] flex-none object-contain"
            style={{ borderRadius: "44px" }}
          />
        </div>
      </div>
    </div>
  );
}

export interface RemoteControlPanelProps {
  readonly owner: ReturnType<typeof createWebuiRemoteControlOwner>;
  /**
   * The pairing page's SSH link raises this; the shell opens the SSH surface in place of the tab
   * body. Without it the link renders in the Desktop's markup but disabled — a visible, announced
   * "not yet wired" rather than a button that does nothing.
   */
  readonly onOpenSsh?: () => void;
}

/**
 * The tab body.
 *
 * It subscribes to the owner, reads the link once and then watches it: the phase changes on the
 * host, so the page follows the host's stream rather than polling.
 */
export function RemoteControlPanel(props: RemoteControlPanelProps): ReactElement {
  const { owner } = props;
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const [busy, setBusy] = useState(false);
  const model = webuiRemoteControlPanelModel(snapshot, Date.now());
  // The countdown is the one thing on this page that moves without the host saying anything, so
  // the clock ticks only while a code is actually on screen.
  const nowMs = useTickingNow(model.pairingCode !== undefined);

  useEffect(() => {
    void owner.load();
    return owner.startWatching();
  }, [owner]);

  const run = (action: () => Promise<unknown>): void => {
    setBusy(true);
    void action().finally(() => {
      setBusy(false);
    });
  };

  return (
    <RemoteControlPanelView
      snapshot={snapshot}
      nowMs={nowMs}
      busy={busy}
      onConnect={() => {
        run(() => owner.connect());
      }}
      onDisconnect={() => {
        run(() => owner.disconnect());
      }}
      onResolveUnbind={(confirmed) => {
        run(() => owner.resolveUnbind(confirmed));
      }}
      {...(props.onOpenSsh === undefined ? {} : { onOpenSsh: props.onOpenSsh })}
    />
  );
}

/** A clock that ticks while `active`, and stands still otherwise. */
function useTickingNow(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return nowMs;
}
