import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { IconPlayerPause, IconPlayerPlay } from "@tabler/icons-react";
import type { DesignMedia } from "../../../../shared/contracts/design.js";
import {
  CLIP_HANDLE_INSET,
  clipRange,
  clipSeconds,
  clipClock,
  isPlaying,
  stripAt,
  stripPercent,
} from "../../../../shared/design/node-ui.mjs";
import { WebuiButton, WebuiIconButton } from "../../../ui/button.js";
import {
  frameStops,
  paintFilmstrip,
  paintWaveform,
  forgetStrip,
} from "../bindings/strip.mjs";
import { wirePlayhead } from "../bindings/clip-playhead.mjs";
import { wirePreviewLoop } from "../bindings/preview-loop.mjs";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { useWebuiToastError } from "../../../ui/toast.js";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";

export interface DesignClipPanelProps {
  readonly media: DesignMedia;
  readonly assetUrl: (url: string) => string;
  readonly onApply: (range: {
    start: number;
    end: number;
  }) => Promise<void> | void;
  readonly onCancel: () => void;
  readonly mediaElement?: HTMLMediaElement | null;
}
/** Range handles, scrub playhead and looped preview edit the actual FFmpeg start/end range. */
export function DesignClipPanel({
  media,
  assetUrl,
  onApply,
  onCancel,
  mediaElement,
}: DesignClipPanelProps): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  const track = useRef<HTMLDivElement>(null),
    strip = useRef<HTMLCanvasElement>(null),
    playhead = useRef<HTMLSpanElement>(null),
    ownEngine = useRef<HTMLMediaElement | null>(null);
  const engine = useRef<HTMLMediaElement | null>(null),
    range = useRef(clipRange({}));
  const [selection, setSelection] = useState(range.current),
    [current, setCurrent] = useState(0),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState("");
  const [previewWarning, setPreviewWarning] = useState("");
  const [operationError, setOperationError] = useState<string>();
  useWebuiToastError(operationError);
  const dragCleanup = useRef<(() => void) | undefined>(undefined);
  const url = assetUrl(media.url);
  useEffect(() => {
    const target = mediaElement ?? ownEngine.current;
    if (!target || !track.current || !playhead.current || !strip.current)
      return;
    engine.current = target;
    const canvas = strip.current,
      previous = {
        currentTime: target.currentTime,
        paused: target.paused,
        muted: target.muted,
      };
    let disposed = false;
    const paint = () => {
      if (!disposed) {
        setCurrent(target.currentTime * 1000);
        setPlaying(isPlaying(target));
      }
    };
    const playAt = (second: number) => {
      target.currentTime = second;
      target.muted = false;
      void target.play().catch((reason: unknown) => {
        if (!disposed) {
          paint();
          setOperationError(
            `无法播放剪辑预览：${reason instanceof Error ? reason.message : String(reason)}`,
          );
        }
      });
    };
    const draw = () => {
      if (!range.current.durationMs) return;
      void (
        media.kind === "audio"
          ? paintWaveform(canvas, url, 160)
          : paintFilmstrip(
              canvas,
              url,
              frameStops(8, range.current.durationMs / 1000),
            )
      ).then((ok) => {
        if (!disposed)
          setPreviewWarning(
            ok ? "" : "当前浏览器无法绘制素材帧条；仍可按时间选择剪辑范围。",
          );
      });
    };
    const ready = () => {
      if (!Number.isFinite(target.duration) || target.duration <= 0) return;
      range.current = clipRange({
        durationMs: Math.round(target.duration * 1000),
        startMs: 0,
        endMs: Math.round(target.duration * 1000),
      });
      setSelection(range.current);
      setError("");
      draw();
      paint();
      playAt(range.current.startMs / 1000);
    };
    const failed = () => setError("无法读取素材，暂时不能剪辑。");
    for (const event of ["timeupdate", "play", "pause", "ended"])
      target.addEventListener(event, paint);
    target.addEventListener("loadedmetadata", ready);
    target.addEventListener("error", failed);
    let wasPlaying = false;
    const stopPlayhead = wirePlayhead({
      track: track.current,
      playhead: playhead.current,
      getRange: () => range.current,
      getDurationMs: () => range.current.durationMs,
      getCurrentMs: () => target.currentTime * 1000,
      seek: (ms) => {
        target.currentTime = ms / 1000;
      },
      paint,
      onPress: () => {
        wasPlaying = isPlaying(target);
        target.pause();
      },
      onRelease: () => {
        if (wasPlaying) playAt(target.currentTime);
      },
    });
    const stopLoop = wirePreviewLoop(target, {
      fromSec: () => range.current.startMs / 1000,
      toSec: () => range.current.endMs / 1000,
      isPlaying: () => isPlaying(target),
      playAt,
    });
    const theme = new MutationObserver(draw),
      themeRoot = canvas.closest(".webui-design");
    if (themeRoot)
      theme.observe(themeRoot, {
        attributes: true,
        attributeFilter: [
          "data-theme",
          "data-design-theme",
          "data-color-scheme",
          "class",
        ],
      });
    const stopTheme = dom.subscribeDocumentTheme(draw),
      stopSize = dom.observeSize(canvas, draw);
    if (target.readyState >= 1) ready();
    return () => {
      disposed = true;
      dragCleanup.current?.();
      stopPlayhead();
      stopLoop();
      forgetStrip(canvas);
      theme.disconnect();
      stopTheme();
      stopSize();
      for (const event of ["timeupdate", "play", "pause", "ended"])
        target.removeEventListener(event, paint);
      target.removeEventListener("loadedmetadata", ready);
      target.removeEventListener("error", failed);
      target.pause();
      if (mediaElement) {
        target.currentTime = previous.currentTime;
        target.muted = previous.muted;
        if (!previous.paused) void target.play().catch(() => undefined);
      } else {
        target.removeAttribute("src");
        target.load();
      }
      engine.current = null;
    };
  }, [url, media.kind, mediaElement, dom]);
  const choose = (edge: "start" | "end", milliseconds: number) => {
    range.current = clipRange({
      ...range.current,
      ...(edge === "start"
        ? { startMs: milliseconds }
        : { endMs: milliseconds }),
    });
    setSelection(range.current);
    const target = engine.current;
    if (target && isPlaying(target))
      target.currentTime =
        Math.min(
          range.current.endMs,
          Math.max(range.current.startMs, milliseconds),
        ) / 1000;
  };
  const togglePreview = async () => {
    const target = engine.current;
    if (!target) return;
    setOperationError(undefined);
    try {
      if (isPlaying(target)) target.pause();
      else {
        target.currentTime = range.current.startMs / 1000;
        target.muted = false;
        await target.play();
      }
    } catch (reason) {
      if (engine.current === target) {
        setPlaying(false);
        setOperationError(
          `无法播放剪辑预览：${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    }
  };
  const drag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    edge: "start" | "end",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    dragCleanup.current?.();
    const move = (pointer: globalThis.PointerEvent) => {
      const rect = track.current?.getBoundingClientRect();
      if (!rect || !range.current.durationMs) return;
      const part = Math.max(
        0,
        Math.min(
          1,
          (pointer.clientX - rect.left - CLIP_HANDLE_INSET) /
            Math.max(1, rect.width - CLIP_HANDLE_INSET * 2),
        ),
      );
      choose(edge, part * range.current.durationMs);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      dragCleanup.current = undefined;
      if (engine.current && isPlaying(engine.current))
        engine.current.currentTime = range.current.startMs / 1000;
    };
    dragCleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  const from = stripAt(stripPercent(selection.startMs, selection.durationMs)),
    to = stripAt(stripPercent(selection.endMs, selection.durationMs));
  return (
    <div
      className="webui-design-clip"
      data-design-clip="true"
      data-canvas-no-zoom="true"
    >
      {!mediaElement ? (
        media.kind === "audio" ? (
          <audio
            ref={(value) => {
              ownEngine.current = value;
            }}
            src={url}
            preload="auto"
          />
        ) : (
          <video
            className="webui-design-clip-engine"
            ref={(value) => {
              ownEngine.current = value;
            }}
            src={url}
            preload="auto"
            playsInline
          />
        )
      ) : null}
      <div
        ref={track}
        className="webui-design-clip-track"
        aria-label="剪辑素材时间条"
      >
        <canvas
          ref={strip}
          className="webui-design-clip-strip"
          aria-label={media.kind === "audio" ? "剪辑音频波形" : "剪辑视频帧条"}
        />
        <span
          className="webui-design-clip-shade"
          style={{ left: 0, width: from }}
        />
        <span
          className="webui-design-clip-shade"
          style={{ left: to, right: 0 }}
        />
        <span
          className="webui-design-clip-region"
          style={{ left: from, right: `calc(100% - ${to})` }}
        />
        <span
          ref={playhead}
          className="webui-design-clip-playhead"
          role="slider"
          tabIndex={0}
          aria-label="播放头"
          aria-valuemin={selection.startMs}
          aria-valuemax={selection.endMs}
          aria-valuenow={Math.round(current)}
          aria-valuetext={clipClock(current, selection.durationMs)}
          style={{ left: stripAt(stripPercent(current, selection.durationMs)) }}
        />
        {(["start", "end"] as const).map((edge) => (
          <WebuiButton
            key={edge}
            variant="plain"
            size="inline-tiny"
            className="webui-design-clip-handle"
            data-design-clip-handle={edge}
            aria-label={edge === "start" ? "剪辑起点" : "剪辑终点"}
            title={edge === "start" ? "拖动改起点" : "拖动改终点"}
            style={{ left: edge === "start" ? from : to }}
            onPointerDown={(event) => drag(event, edge)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              choose(
                edge,
                range.current[edge === "start" ? "startMs" : "endMs"] +
                  (event.key === "ArrowRight" ? 100 : -100),
              );
            }}
          />
        ))}
      </div>
      {error ? (
        <FeedbackLiveRegion className="webui-design-clip-error">
          {error}
        </FeedbackLiveRegion>
      ) : null}
      {previewWarning && !error ? (
        <FeedbackLiveRegion className="webui-design-clip-hint">
          {previewWarning}
        </FeedbackLiveRegion>
      ) : null}
      <div className="webui-design-clip-transport">
        <WebuiIconButton
          label={playing ? "暂停预览" : "预览这一段"}
          tone="bare"
          size="compact"
          disabled={!selection.durationMs}
          onClick={togglePreview}
        >
          {playing ? (
            <IconPlayerPause size={16} />
          ) : (
            <IconPlayerPlay size={16} />
          )}
        </WebuiIconButton>
        <span className="webui-design-clip-clock">
          {clipClock(current, selection.durationMs)}
        </span>
        <span className="webui-design-clip-range">
          {clipClock(selection.startMs, selection.endMs)}
        </span>
        <div className="webui-design-clip-actions">
          <WebuiButton
            variant="quiet-action"
            size="inline-dense"
            onClick={onCancel}
          >
            取消
          </WebuiButton>
          <span className="webui-design-clip-hint">Esc</span>
          <WebuiButton
            variant="accent"
            size="inline-dense"
            disabled={!selection.durationMs || Boolean(error)}
            onClick={async () => {
              await onApply(clipSeconds(range.current));
            }}
          >
            确认
          </WebuiButton>
        </div>
      </div>
    </div>
  );
}
