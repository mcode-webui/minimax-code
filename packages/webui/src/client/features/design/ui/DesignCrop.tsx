import { useRef, useState, type ReactElement } from "react";
import { WebuiButton } from "../../../ui/button.js";
import { useWebuiToastError } from "../../../ui/toast.js";

export interface DesignCropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export function DesignCrop({
  onApply,
  onCancel,
}: {
  readonly onApply: (rect: DesignCropRect) => Promise<void>;
  readonly onCancel: () => void;
}): ReactElement {
  const [rect, setRect] = useState<DesignCropRect>({
    x: 0.1,
    y: 0.1,
    width: 0.8,
    height: 0.8,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  useWebuiToastError(error);
  const drag = useRef<{
    readonly x: number;
    readonly y: number;
    readonly rect: DesignCropRect;
    readonly handle: string;
  }>();
  return (
    <div
      className="webui-design-crop-overlay"
      data-canvas-no-zoom="true"
      aria-label="剪裁区域"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onCancel();
        }
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          rect,
          handle:
            (event.target as HTMLElement).dataset.cropHandle ??
            ((event.target as HTMLElement).closest("[data-crop-box]")
              ? "move"
              : "draw"),
        };
      }}
      onPointerMove={(event) => {
        const origin = drag.current;
        if (!origin) return;
        const box = event.currentTarget.getBoundingClientRect(),
          dx = (event.clientX - origin.x) / box.width,
          dy = (event.clientY - origin.y) / box.height,
          before = origin.rect;
        const clamp = (value: number, min: number, max: number) =>
          Math.min(max, Math.max(min, value));
        if (origin.handle === "move") {
          setRect({
            ...before,
            x: clamp(before.x + dx, 0, 1 - before.width),
            y: clamp(before.y + dy, 0, 1 - before.height),
          });
          return;
        }
        if (origin.handle === "draw") {
          const x = clamp((origin.x - box.left) / box.width, 0, 1),
            y = clamp((origin.y - box.top) / box.height, 0, 1),
            endX = clamp(x + dx, 0, 1),
            endY = clamp(y + dy, 0, 1);
          setRect({
            x: Math.min(x, endX),
            y: Math.min(y, endY),
            width: Math.max(0.02, Math.abs(endX - x)),
            height: Math.max(0.02, Math.abs(endY - y)),
          });
          return;
        }
        const left = origin.handle.includes("w")
          ? clamp(before.x + dx, 0, before.x + before.width - 0.02)
          : before.x;
        const top = origin.handle.includes("n")
          ? clamp(before.y + dy, 0, before.y + before.height - 0.02)
          : before.y;
        const right = origin.handle.includes("e")
          ? clamp(before.x + before.width + dx, left + 0.02, 1)
          : before.x + before.width;
        const bottom = origin.handle.includes("s")
          ? clamp(before.y + before.height + dy, top + 0.02, 1)
          : before.y + before.height;
        setRect({ x: left, y: top, width: right - left, height: bottom - top });
      }}
      onPointerUp={(event) => {
        drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
      }}
    >
      <div
        data-crop-box="true"
        className="webui-design-crop-selection"
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
        }}
      >
        <i className="webui-design-crop-guide-horizontal" />
        <i className="webui-design-crop-guide-vertical" />
        {["nw", "ne", "sw", "se"].map((handle) => (
          <span
            key={handle}
            data-crop-handle={handle}
            className={`webui-design-crop-handle webui-design-crop-${handle}`}
          />
        ))}
      </div>
      <div className="webui-design-crop-actions">
        <WebuiButton
          variant="primary"
          size="inline-tiny"
          disabled={busy}
          onClick={async () => {
            setError(undefined);
            setBusy(true);
            try {
              await onApply(rect);
            } catch (reason) {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          完成裁剪
        </WebuiButton>
        <WebuiButton
          variant="plain"
          size="inline-tiny"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </WebuiButton>
      </div>
    </div>
  );
}
