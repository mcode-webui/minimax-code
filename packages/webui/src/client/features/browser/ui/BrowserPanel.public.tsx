// The Browser panel.
//
// **This is a live image stream, not an embedded page.** The target site is
// shown by pointing an `<img>` at a `data:` URL built from the frame the provider
// delivered — never an `iframe`, never `srcdoc`, never a blob URL, never
// `dangerouslySetInnerHTML`. An embedded document would run with the WebUI's own
// origin and would hand the target page's scripts the session token sitting on
// `window.__WEBUI_CONFIG__`; the repository's other preview surface
// (`WorkspaceHtmlPreview.tsx`) states the same rule from the other direction, and
// this one needs none of that isolation machinery because an image cannot execute
// anything. The bytes never become a string this component renders.
//
// The second thing it is not is a passive picture. Pointer, keyboard and text
// gestures become `WebuiBrowserInputCommand`s through
// `../application/browser-commands.js` and leave through `onSendInput`, bound to
// the target's generation — so a panel showing a stale page cannot deliver a
// click to whatever replaced it, and a malformed gesture is refused here rather
// than pushed at the provider.
//
// The port, the capability manifest and the state are injected, and every side
// effect is a callback the shell owns. That keeps this file a projection of state
// a pure reducer already decided, and it keeps the rule that matters — the page
// on screen and the page the Agent drives are the same page — in the state,
// where it can be asserted without a browser.
//
// The panel used to carry a surface switcher at the top of the body: three
// radios, one for each of the surfaces the service knows about. That switcher
// is gone now — Edge and Chrome are reached in the person's own windows, and
// the only surface the panel sees is the isolated Chromium. The tab strip
// decides what target is on screen, and this panel is that target's picture.
//
// `.public` because the workspace panel mounts it: the Browser business publishes
// the panel and the workspace business renders it. Nothing else in this directory
// is mounted from outside.

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import {
  isWebuiBrowserSurfaceAuthorized,
  type WebuiBrowserError,
  type WebuiBrowserInputCommand,
} from "../../../../shared/contracts/browser.js";
import { readWebuiCapability, type WebuiCapabilityView } from "../../../../shared/capability-manifest.js";
import type { BrowserPort } from "../contracts/browser-port.js";
import {
  WEBUI_BROWSER_CAPABILITY_NAME,
  type WebuiBrowserInputIntent,
  type WebuiBrowserPanelState,
} from "../contracts/browser-panel.js";
import {
  prepareWebuiBrowserInputCommand,
  webuiBrowserModifierFlags,
  webuiBrowserPointerButton,
} from "../application/browser-commands.js";
import {
  selectWebuiBrowserFrame,
  selectWebuiBrowserViewedTarget,
  webuiBrowserFrameDataUrl,
} from "../projection/browser-state.js";
import { webuiBrowserPicturePoint } from "../application/browser-commands.js";
import { FeedbackError } from "../../../ui/feedback.js";

const PANEL_COPY = {
  title: "浏览器",
  frameLabel: "浏览器画面",
  inputLabel: "浏览器输入区",
  unauthorized: "隔离浏览器未授权。请在设置的「浏览器」页中打开对应的浏览器开关。",
  absent: "当前运行时没有浏览器能力，浏览器面板不可用。",
  notReady: "浏览器能力尚未就绪（例如扩展未连接），面板暂时无法显示页面。",
  unknown: "当前运行时没有报告浏览器能力，面板按未授权处理。",
} as const;

export interface BrowserPanelProps {
  /**
   * The browser capability port. Optional and every member optional, like every
   * port in this package; an absent member means the host does not wire that
   * operation, which the panel states rather than discovers by calling.
   */
  readonly port?: BrowserPort;
  /** The projected panel state. Absent is the "nothing loaded yet" panel. */
  readonly state?: WebuiBrowserPanelState;
  /** The handshake manifest, so the panel can say *why* a family is unusable. */
  readonly capabilities?: WebuiCapabilityView;
  /**
   * The size the page is shown at.
   *
   * The browser's window takes it, so the page is drawn at the size the panel
   * shows it rather than scaled down into it. It is reported once the size has
   * settled: a window being dragged reports a size a dozen times a second, and
   * the browser would follow every one of them.
   */
  readonly onSurfaceSize?: (size: { readonly width: number; readonly height: number }) => void;
  /** The host streams frames into this image without scheduling a React render per frame. */
  readonly frameRef?: { current: HTMLImageElement | null };
  /** Receives only commands that passed validation and the generation binding. */
  readonly onSendInput?: (command: WebuiBrowserInputCommand) => Promise<void>;
  /** Receives every refusal, so a gesture that went nowhere is visible. */
  readonly onRejected?: (error: WebuiBrowserError) => void;
}

export function BrowserPanel({
  port,
  state,
  capabilities,
  onSurfaceSize,
  frameRef: hostFrameRef,
  onSendInput,
  onRejected,
}: BrowserPanelProps): ReactElement {
  const surface = state?.surface ?? "isolated-chromium";
  const frame = state ? selectWebuiBrowserFrame(state) : undefined;
  // `undefined` here means the frame must not be rendered at all — an
  // unrecognised format or a payload outside the base64 alphabet gets no
  // element, rather than an element whose `src` guesses what it was given.
  const frameSrc = webuiBrowserFrameDataUrl(frame);
  // The client's cell: the page this tab holds. Everything below — the picture, the
  // alt text, the input binding — follows it, and none of it reads the run's
  // selection, which is a different page and belongs to the Agent.
  const viewed = state ? selectWebuiBrowserViewedTarget(state) : undefined;
  const authorized = state ? isWebuiBrowserSurfaceAuthorized(state.authorization, surface) : false;
  const capability = readWebuiCapability(capabilities, WEBUI_BROWSER_CAPABILITY_NAME);
  const inputEnabled = Boolean(viewed) && authorized && Boolean(port?.sendBrowserInput);
  const inputQueueRef = useRef(new Map<string, WebuiBrowserInputCommand[]>());
  const inputDrainingRef = useRef(new Set<string>());

  const drainInputQueue = useCallback(async (targetKey: string) => {
    if (inputDrainingRef.current.has(targetKey)) return;
    inputDrainingRef.current.add(targetKey);
    try {
      const queue = inputQueueRef.current.get(targetKey);
      while (queue && queue.length > 0) {
        const command = queue.shift();
        if (!command) continue;
        try {
          await onSendInput?.(command);
        } catch (error) {
          onRejected?.({
            code: "browser_provider_failed",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
        }
      }
    } finally {
      inputDrainingRef.current.delete(targetKey);
      if (inputQueueRef.current.get(targetKey)?.length === 0) inputQueueRef.current.delete(targetKey);
    }
  }, [onRejected, onSendInput]);

  const submit = useCallback(
    (intent: WebuiBrowserInputIntent, aimedPage = state?.viewedPage) => {
      // Bound to the page in front, at send time: a gesture typed while the strip
      // moved to another tab lands on the tab the person is looking at, or is
      // refused — it is never re-aimed at whatever the Agent is doing.
      const result = prepareWebuiBrowserInputCommand(aimedPage, intent);
      // The refusal path is the one that matters: a gesture that could not be
      // aimed has to be visible, because the alternative is a click that appears
      // to do nothing.
      if (!result.ok) {
        onRejected?.(result.error);
        return;
      }
      const command = result.command;
      const targetKey = [
        command.target.surface,
        command.target.browserId,
        command.target.targetId,
        command.target.generation,
      ].join("/");
      const queue = inputQueueRef.current.get(targetKey) ?? [];
      inputQueueRef.current.set(targetKey, queue);
      const previous = queue.at(-1);
      // Keep only the newest unsent pointer position. Scroll deltas combine so
      // a busy runtime cannot accumulate a long trail of stale wheel events.
      if (
        command.kind === "pointer" &&
        command.action === "move" &&
        previous?.kind === "pointer" &&
        previous.action === "move"
      ) {
        queue[queue.length - 1] = command;
      } else if (
        command.kind === "pointer" &&
        command.action === "scroll" &&
        previous?.kind === "pointer" &&
        previous.action === "scroll"
      ) {
        queue[queue.length - 1] = {
          ...command,
          deltaX: (previous.deltaX ?? 0) + (command.deltaX ?? 0),
          deltaY: (previous.deltaY ?? 0) + (command.deltaY ?? 0),
        };
      } else {
        if (queue.length >= 64) {
          const staleMove = queue.findIndex((queued) => queued.kind === "pointer" && queued.action === "move");
          if (staleMove >= 0) queue.splice(staleMove, 1);
          else {
            onRejected?.({
              code: "browser_provider_failed",
              message: "浏览器输入队列已满，操作未发送。",
              retryable: false,
            });
            return;
          }
        }
        queue.push(command);
      }
      void drainInputQueue(targetKey);
    },
    [drainInputQueue, onRejected, state],
  );

  // The picture's own size, which is the browser's viewport: a click is mapped
  // into it.
  const localFrameRef = useRef<HTMLImageElement | null>(null);
  const frameRef = hostFrameRef ?? localFrameRef;
  const pressedButtonRef = useRef<"left" | "middle" | "right" | undefined>(undefined);
  const pressedPageRef = useRef(state?.viewedPage);
  const lastMoveAtRef = useRef(-Infinity);
  const lastWheelAtRef = useRef(-Infinity);
  const moveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingMoveRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingWheelRef = useRef<{ x: number; y: number; deltaX: number; deltaY: number } | undefined>(undefined);

  // The size the page is shown at, reported once it has settled.
  const stageRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !onSurfaceSize) return;
    if (typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const rect = stage.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        onSurfaceSize({ width: rect.width, height: rect.height });
      }, 250);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(stage);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [onSurfaceSize]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLImageElement>) => {
      if (!inputEnabled) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      // Measured against the picture, not against the surface: the picture is
      // the browser's viewport drawn to fit, so a click on the surface is not
      // yet a point in the browser. The point is mapped into the picture's own
      // size, or the click lands somewhere the person never pointed at.
      const rect = event.currentTarget.getBoundingClientRect();
      const point = webuiBrowserPicturePoint(rect, frameRef.current ?? undefined, event.clientX, event.clientY);
      const button = webuiBrowserPointerButton(event.button);
      pressedButtonRef.current = button;
      pressedPageRef.current = state?.viewedPage;
      submit({
        kind: "pointer",
        action: "press",
        x: point.x,
        y: point.y,
        button,
      }, pressedPageRef.current);
    },
    [inputEnabled, state?.viewedPage, submit],
  );

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    const button = pressedButtonRef.current;
    if (!inputEnabled || !button) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = webuiBrowserPicturePoint(rect, frameRef.current ?? undefined, event.clientX, event.clientY);
    pressedButtonRef.current = undefined;
    const aimedPage = pressedPageRef.current;
    pressedPageRef.current = undefined;
    submit({ kind: "pointer", action: "release", x: point.x, y: point.y, button }, aimedPage);
  }, [inputEnabled, submit]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
    if (!inputEnabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    pendingMoveRef.current = webuiBrowserPicturePoint(rect, frameRef.current ?? undefined, event.clientX, event.clientY);
    if (moveTimerRef.current) return;
    const delay = Math.max(0, 1000 / 60 - (performance.now() - lastMoveAtRef.current));
    const flush = () => {
      moveTimerRef.current = undefined;
      const point = pendingMoveRef.current;
      pendingMoveRef.current = undefined;
      if (!point) return;
      lastMoveAtRef.current = performance.now();
      submit({ kind: "pointer", action: "move", ...point });
    };
    if (delay === 0) flush();
    else moveTimerRef.current = setTimeout(flush, delay);
  }, [inputEnabled, submit]);

  const onWheel = useCallback((event: WheelEvent) => {
    if (!inputEnabled) return;
    event.preventDefault();
    const rect = (event.currentTarget as HTMLImageElement).getBoundingClientRect();
    const point = webuiBrowserPicturePoint(rect, frameRef.current ?? undefined, event.clientX, event.clientY);
    const pending = pendingWheelRef.current;
    pendingWheelRef.current = pending
      ? { ...point, deltaX: pending.deltaX + event.deltaX, deltaY: pending.deltaY + event.deltaY }
      : { ...point, deltaX: event.deltaX, deltaY: event.deltaY };
    if (wheelTimerRef.current) return;
    const delay = Math.max(0, 1000 / 60 - (performance.now() - lastWheelAtRef.current));
    const flush = () => {
      wheelTimerRef.current = undefined;
      const wheel = pendingWheelRef.current;
      pendingWheelRef.current = undefined;
      if (wheel) {
        lastWheelAtRef.current = performance.now();
        submit({ kind: "pointer", action: "scroll", ...wheel });
      }
    };
    if (delay === 0) flush();
    else wheelTimerRef.current = setTimeout(flush, delay);
  }, [inputEnabled, submit]);

  useEffect(() => {
    const image = frameRef.current;
    if (!image) return;
    // React delegates wheel with a passive listener; cancellation must happen on the image.
    image.addEventListener("wheel", onWheel, { passive: false });
    return () => image.removeEventListener("wheel", onWheel);
  }, [frameRef, frameSrc, onWheel]);

  useEffect(() => () => {
    if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
    if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLImageElement>) => {
      if (!inputEnabled) return;
      event.preventDefault();
      // A composition is not a key. The browser is given the text the input
      // method made, or a Chinese word never reaches the page -- and the panel
      // has no field of its own to type it into.
      const composed = webuiBrowserComposedText(event);
      if (composed) {
        submit({ kind: "text", text: composed });
        return;
      }
      submit({
        kind: "key",
        key: event.key,
        code: event.code,
        // Only a single character is text; named keys such as `Enter` carry none.
        text: event.key.length === 1 ? event.key : undefined,
        modifiers: webuiBrowserModifierFlags(event),
      });
    },
    [inputEnabled, submit],
  );

  return (
    <section className="webui-browser-panel" data-testid="browser-panel" role="region" aria-label={PANEL_COPY.title}>
      {capability === "absent" ? (
        <p className="webui-browser-notice" role="status" data-testid="browser-panel-absent">
          {PANEL_COPY.absent}
        </p>
      ) : null}
      {capability === "not-ready" ? (
        <p className="webui-browser-notice" role="status" data-testid="browser-panel-not-ready">
          {PANEL_COPY.notReady}
        </p>
      ) : null}
      {capability === "unknown" ? (
        <p className="webui-browser-notice" role="status" data-testid="browser-panel-unknown">
          {PANEL_COPY.unknown}
        </p>
      ) : null}

      {state?.error ? (
        <FeedbackError message={state.error.message} className="webui-browser-notice is-error" testId="browser-panel-error" />
      ) : null}
      {/*
        The unauthorized notice is about the *surface*, not about whether a tab
        happens to be listed, so it appears from the first paint of a panel whose
        browser switch is off. A family the host does not have, or has but cannot
        yet serve, is a different message and gets its own notice instead.
      */}
      {capability !== "absent" && capability !== "not-ready" && !authorized ? (
        <p className="webui-browser-notice" role="status" data-testid="browser-panel-unauthorized">
          {PANEL_COPY.unauthorized}
        </p>
      ) : null}

      <div className="webui-browser-stage" ref={stageRef}>
        {frameSrc ? (
          <img
            ref={frameRef}
            className="webui-browser-frame"
            data-testid="browser-panel-frame"
            data-format={frame?.format}
            data-frame-sequence={frame?.sequence}
            data-target-generation={frame?.target.generation}
            src={frameSrc}
            alt={viewed ? `${viewed.title || viewed.url} 的浏览器画面` : PANEL_COPY.frameLabel}
            draggable={false}
            role="application"
            aria-label={PANEL_COPY.inputLabel}
            tabIndex={inputEnabled ? 0 : -1}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerMove={onPointerMove}
            onKeyDown={onKeyDown}
          />
        ) : (
          <div data-testid="browser-panel-frame-empty" aria-hidden="true" />
        )}
      </div>
    </section>
  );
}

/**
 * The text an input method made, when the key event carries one.
 *
 * A composed word is not a key: it has no `code` of its own, it is longer
 * than a character, and the browser is given the text rather than a
 * keystroke. The two placeholders an input method reports instead of a word
 * are not text and are left to the key path.
 */
function webuiBrowserComposedText(event: ReactKeyboardEvent<HTMLImageElement>): string {
  const key = event.key;
  if (!key || key === "Process" || key === "Unidentified") return "";
  if (key.length < 2) return "";
  // A named key has a code of its own; a composed word does not.
  if (event.code) return "";
  return key;
}
