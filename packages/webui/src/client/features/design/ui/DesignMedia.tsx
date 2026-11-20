import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  IconDownload,
  IconPlayerPause,
  IconPlayerPlay,
} from "@tabler/icons-react";
import type { DesignNode } from "../../../../shared/contracts/design.js";
import { mediaBoxFor } from "../../../../shared/design/tools.mjs";
import { WebuiButtonLink, WebuiIconButton } from "../../../ui/button.js";
import { paintWaveform, forgetStrip } from "../bindings/strip.mjs";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { useWebuiToastError } from "../../../ui/toast.js";
import { captureDesignVideoPoster } from "../bindings/poster.mjs";

export interface DesignMediaProps {
  readonly node: DesignNode;
  readonly assetUrl: (url: string) => string;
  readonly onOutputMetadata?: (
    patch: Readonly<Record<string, unknown>>,
  ) => void;
  readonly onFit?: (size: { width: number; height: number }) => void;
  readonly overlay?: ReactNode;
  readonly onPoster?: (input: {
    sourceUrl: string;
    base64: string;
  }) => Promise<unknown> | void;
}
const clock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** The material itself: original image sizing, custom video transport and decoded audio waveform. */
export function DesignMedia({
  node,
  assetUrl,
  onOutputMetadata,
  onFit,
  overlay,
  onPoster,
}: DesignMediaProps): ReactElement {
  const media = node.metadata.output.media[0];
  const { dom } = useWebuiBrowserCapabilities();
  const element = useRef<HTMLMediaElement | null>(null);
  const waveform = useRef<HTMLCanvasElement>(null);
  const callbacks = useRef({ onOutputMetadata, onFit, onPoster });
  callbacks.current = { onOutputMetadata, onFit, onPoster };
  const posterEpoch = useRef(0),
    previousPoster = useRef("");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(
    Number(node.metadata.output.durationMs ?? 0) / 1000,
  );
  const [missing, setMissing] = useState(Boolean(node.metadata.output.missing));
  const [retry, setRetry] = useState(0),
    [operationError, setOperationError] = useState<string>();
  useWebuiToastError(operationError);
  const bindEngine = useCallback((value: HTMLMediaElement | null) => {
    if (element.current !== value) {
      posterEpoch.current++;
      element.current?.pause();
      previousPoster.current = "";
    }
    element.current = value;
  }, []);
  const canonicalUrl = media ? assetUrl(media.url) : "";
  // Chromium can retain a rejected decoder resource even after a new element.
  // Only native assets accept a retry query; provider-signed URLs stay intact.
  const url =
    retry > 0 && media?.url.startsWith("/design-assets/")
      ? `${canonicalUrl}${canonicalUrl.includes("?") ? "&" : "?"}designRetry=${retry}`
      : canonicalUrl;
  useEffect(() => {
    setPlaying(false);
    setCurrent(0);
    setMissing(Boolean(node.metadata.output.missing));
  }, [url, node.metadata.output.missing]);
  // A missing source may be restored at the same URL while React retains its card.
  useEffect(() => {
    if (!missing) return;
    const timer = setTimeout(() => setRetry((value) => value + 1), 3000);
    return () => clearTimeout(timer);
  }, [url, missing, retry]);
  useEffect(() => {
    const canvas = waveform.current;
    if (!canvas || media?.kind !== "audio") return;
    const draw = () => {
      void paintWaveform(canvas, url, 120, { oversample: 2 });
    };
    draw();
    const observer = new MutationObserver(draw);
    const themeRoot = canvas.closest(".webui-design");
    if (themeRoot)
      observer.observe(themeRoot, {
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
    return () => {
      observer.disconnect();
      stopTheme();
      stopSize();
      forgetStrip(canvas);
    };
  }, [url, media?.kind, retry, dom]);
  useEffect(() => {
    const captured = element.current;
    return () => captured?.pause();
  }, [url, retry]);
  const loaded = (width: number, height: number, seconds = 0) => {
    setMissing(false);
    if (seconds > 0) setDuration(seconds);
    const output = node.metadata.output;
    const patch: Record<string, unknown> = {};
    if (output.missing) patch.missing = false;
    if (width && output.width !== width) patch.width = width;
    if (height && output.height !== height) patch.height = height;
    if (seconds > 0 && output.durationMs !== Math.round(seconds * 1000))
      patch.durationMs = Math.round(seconds * 1000);
    if (Object.keys(patch).length) callbacks.current.onOutputMetadata?.(patch);
    if (width && height) {
      const size = mediaBoxFor(
        width / height,
        Math.max(1, node.width),
        Boolean(node.metadata.userSized),
      );
      callbacks.current.onFit?.({ width: size.width, height: size.height });
    }
  };
  const failed = () => {
    if (missing) return;
    setMissing(true);
    callbacks.current.onOutputMetadata?.({ missing: true });
  };
  const toggle = async () => {
    const engine = element.current;
    if (!engine) return;
    setOperationError(undefined);
    try {
      if (!engine.paused && !engine.ended) {
        engine.pause();
        if (media?.kind === "video") engine.muted = true;
      } else {
        if (engine.ended) engine.currentTime = 0;
        engine.muted = false;
        await engine.play();
      }
    } catch (reason) {
      if (element.current === engine) {
        setPlaying(false);
        setOperationError(
          `无法播放素材：${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    }
  };
  const savePoster = async (engine: HTMLVideoElement) => {
    const epoch = ++posterEpoch.current,
      sourceUrl = media?.url;
    try {
      const base64 = await captureDesignVideoPoster(engine);
      if (
        !base64 ||
        !sourceUrl ||
        posterEpoch.current !== epoch ||
        element.current !== engine ||
        previousPoster.current === base64
      )
        return;
      const saved = await callbacks.current.onPoster?.({ sourceUrl, base64 });
      if (
        saved !== undefined &&
        posterEpoch.current === epoch &&
        element.current === engine
      )
        previousPoster.current = base64;
    } catch (reason) {
      if (posterEpoch.current === epoch && element.current === engine)
        setOperationError(
          `无法保存视频封面：${reason instanceof Error ? reason.message : String(reason)}`,
        );
    }
  };
  if (!media) return <div className="webui-design-media-empty">还没有产物</div>;
  const progress = duration > 0 ? Math.min(1, current / duration) * 100 : 0;
  const events = {
    onError: failed,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: () => setCurrent(element.current?.currentTime ?? 0),
  };
  return (
    <div
      className="webui-design-material"
      data-media-kind={media.kind}
      data-media-missing={missing ? "true" : undefined}
      data-design-media-url={media.url}
    >
      <div className="webui-design-material-preview" data-canvas-no-zoom="true">
        {media.kind === "image" ? (
          <img
            key={`${url}:${retry}`}
            className="webui-design-material-image"
            src={url}
            alt={node.title}
            draggable={false}
            onLoad={(event) =>
              loaded(
                event.currentTarget.naturalWidth,
                event.currentTarget.naturalHeight,
              )
            }
            onError={failed}
          />
        ) : media.kind === "video" ? (
          <>
            <video
              key={`${url}:${retry}`}
              className="webui-design-material-video"
              ref={bindEngine}
              src={url}
              poster={
                typeof node.metadata.output.posterUrl === "string" &&
                node.metadata.output.posterUrl
                  ? assetUrl(node.metadata.output.posterUrl)
                  : undefined
              }
              preload="metadata"
              playsInline
              muted
              data-design-media-engine={node.id}
              {...events}
              onSeeking={() => {
                posterEpoch.current++;
              }}
              onSeeked={(event) => {
                void savePoster(event.currentTarget);
              }}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                loaded(video.videoWidth, video.videoHeight, video.duration);
              }}
            />
            <WebuiIconButton
              label={playing ? "暂停视频" : "播放视频"}
              tone="bare"
              className="webui-design-video-play"
              onClick={toggle}
            >
              {playing ? (
                <IconPlayerPause size={22} />
              ) : (
                <IconPlayerPlay size={22} />
              )}
            </WebuiIconButton>
            {duration > 0 ? (
              <span className="webui-design-video-duration">
                {clock(duration)}
              </span>
            ) : null}
          </>
        ) : media.kind === "audio" ? (
          <>
            <audio
              key={`${url}:${retry}`}
              ref={bindEngine}
              src={url}
              preload="metadata"
              data-design-media-engine={node.id}
              {...events}
              onLoadedMetadata={(event) =>
                loaded(0, 0, event.currentTarget.duration)
              }
            />
            <canvas
              ref={waveform}
              className="webui-design-audio-wave"
              aria-label="音频波形"
            />
            <span
              className="webui-design-audio-ahead"
              style={{ left: `${progress}%` }}
            />
            <span
              className="webui-design-audio-head"
              style={{ left: `${progress}%` }}
            />
          </>
        ) : (
          <pre className="webui-design-material-text">
            {node.metadata.output.text}
          </pre>
        )}
        {overlay}
        {missing ? (
          <span className="webui-design-material-missing">
            素材已不在，请重新生成或从资产库插入
          </span>
        ) : null}
      </div>
      {media.kind === "audio" ? (
        <div className="webui-design-audio-bar">
          <span className="webui-design-audio-clock">
            {clock(current)} / {clock(duration)}
          </span>
          <WebuiIconButton
            label={playing ? "暂停音频" : "播放音频"}
            tone="bare"
            size="compact"
            onClick={toggle}
          >
            {playing ? (
              <IconPlayerPause size={16} />
            ) : (
              <IconPlayerPlay size={16} />
            )}
          </WebuiIconButton>
          <WebuiButtonLink
            aria-label="保存音频到本地"
            title="把这个文件存到电脑"
            variant="quiet-action"
            size="inline-tiny"
            href={assetUrl(
              `${media.url}?download=${encodeURIComponent(media.name ?? `${node.title}.mp3`)}`,
            )}
            download={media.name}
          >
            <IconDownload size={16} />
          </WebuiButtonLink>
        </div>
      ) : null}
    </div>
  );
}
