// The thinking scale as a slider.
//
// The scale's SHAPE is the model's own (see `effort-scale.ts`); this is the
// control that draws it and moves it.
//
// The commit happens when the drag ENDS, not on every stop it crosses: a
// change of level is a `selectModel` round trip, so a drag across four stops
// would otherwise fire four of them, and four answers arriving in the order
// the runtime felt like answering them would leave the slider showing a level
// the user did not choose. The drag moves the thumb; the release commits it.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

import {
  effortStopIndex,
  effortStopRatio,
  type WebuiEffortScale,
} from "../projection/effort-scale.js";

export interface WebuiModelEffortSliderProps {
  readonly scale: WebuiEffortScale;
  /** The level the model is on now. */
  readonly value: string;
  /** A switch has only its two end states, so it uses a shorter rail. */
  readonly binary: boolean;
  /** Called once, when the drag ends on a level. */
  readonly onCommit: (value: string) => void;
  /** The level under the pointer, for live labels while dragging. */
  readonly onPreviewChange?: (value: string | undefined) => void;
}

/**
 * The travel of the thumb, as a CSS length expression.
 *
 * The stops sit inside the track by the thumb's radius on each side, so the
 * thumb is always whole on the track — a circle at the very end of a bar
 * hangs off it, and a scale whose end stop is half off the rail reads as a
 * control that was cut short.
 */
const TRAVEL = "calc(var(--spacing_20) + (100% - var(--spacing_40)) *";

export function WebuiModelEffortSlider({
  scale,
  value,
  binary,
  onCommit,
  onPreviewChange,
}: WebuiModelEffortSliderProps): ReactElement {
  const railRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const [preview, setPreview] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (draggingRef.current || preview === undefined || preview !== value) return;
    setPreview(undefined);
    onPreviewChange?.(undefined);
  }, [onPreviewChange, preview, value]);

  const total = scale.stops.length;
  const index = effortStopIndex(scale, preview ?? value);
  const ratio = effortStopRatio(Math.max(index, 0), total);
  const position = `${TRAVEL} ${ratio})`;
  const fillWidth = ratio === 0 ? "0px" : position;

  /** The stop under a pointer, as the nearest one. */
  const stopAt = useCallback(
    (clientX: number): string | undefined => {
      const rail = railRef.current;
      if (!rail || total === 0) return undefined;
      const rect = rail.getBoundingClientRect();
      if (rect.width <= 0) return undefined;
      // The travel is inset, so the pointer is measured against the inset
      // range rather than against the whole rail.
      const inset = 20;
      const travel = rect.width - inset * 2;
      if (travel <= 0) return undefined;
      const ratio = (clientX - rect.left - inset) / travel;
      const last = total - 1;
      const at = Math.min(last, Math.max(0, Math.round(ratio * last)));
      return scale.stops[at]?.value;
    },
    [scale, total],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (scale.disabled) return;
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const stop = stopAt(event.clientX);
    if (stop !== undefined) {
      setPreview(stop);
      onPreviewChange?.(stop);
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    const stop = stopAt(event.clientX);
    if (stop !== undefined) {
      setPreview(stop);
      onPreviewChange?.(stop);
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const stop = stopAt(event.clientX);
    if (stop !== undefined && stop !== value) {
      // Keep the chosen stop visible while the owner commits it. The owner
      // updates `value` on success; the effect above then releases this preview.
      setPreview(stop);
      onPreviewChange?.(stop);
      onCommit(stop);
    } else {
      setPreview(undefined);
      onPreviewChange?.(undefined);
    }
  };

  /**
   * A cancelled gesture is not a choice.
   *
   * The browser took the pointer away — a scroll, a system gesture — so the
   * drag ends without committing: the thumb goes back to where the model
   * actually is.
   */
  const handlePointerCancel = (): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setPreview(undefined);
    onPreviewChange?.(undefined);
  };

  return (
    <div
      className="webui-model-effort-slider"
      data-webui-model-effort-slider="true"
      data-ultra={ratio === 1 ? "true" : "false"}
      data-disabled={scale.disabled ? "true" : "false"}
      data-binary={binary ? "true" : "false"}
    >
      <div
        ref={railRef}
        className="webui-model-effort-rail"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        <div className="webui-model-effort-track" />
        <div
          className="webui-model-effort-fill"
          data-empty={ratio === 0 ? "true" : "false"}
          data-ultra={ratio === 1 ? "true" : "false"}
          style={{ width: fillWidth }}
        />
        {scale.stops.map((stop, at) => (
          <span
            key={stop.value}
            className="webui-model-effort-dot"
            data-passed={at <= index ? "true" : "false"}
            style={{ left: `${TRAVEL} ${effortStopRatio(at, total)})` }}
          />
        ))}
        <span
          className="webui-model-effort-thumb"
          style={{ left: position }}
        />
      </div>
    </div>
  );
}
