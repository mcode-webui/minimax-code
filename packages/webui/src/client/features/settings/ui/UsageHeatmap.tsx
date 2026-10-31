// The account page's usage heat map.
//
// A transcription of the Desktop's `t4` component: the same week-column
// layout, the same cell geometry, the same four usage buckets and the same
// month labels. The Desktop's calendar model is produced by
// `projection/usage-report.ts`; this module only draws it.
//
// The Desktop renders the cell tooltip through a portal so it is not clipped
// by the calendar's own scroll container. The WebUI does the same: one tooltip
// element is rendered into the page's portal target and positioned from the
// hovered cell's own rectangle.

import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { useDialogLayer } from "../../../ui/overlay-listeners.js";
import { WebuiButton } from "../../../ui/button.js";
import type {
  WebuiUsageHeatmapCell,
  WebuiUsageHeatmapModel,
} from "../projection/usage-report.js";
import { formatCompactToken, formatUsageCellDate } from "../projection/usage-report.js";

export interface UsageHeatmapProps {
  readonly model: WebuiUsageHeatmapModel;
  /** How many week columns to show, counted from the right. */
  readonly columnCount?: number;
  /** Whether the month labels under the calendar are drawn. */
  readonly showMonths?: boolean;
  /** Whether the calendar is centred in its container. */
  readonly align?: "center" | "start";
  readonly testId?: string;
}

interface HoveredCell {
  readonly cell: WebuiUsageHeatmapCell;
  readonly left: number;
  readonly top: number;
}

/** The four usage buckets, as the Desktop colours them. */
function levelClassName(level: WebuiUsageHeatmapCell["level"]): string {
  switch (level) {
    case 1:
      return "bg-icon_default_accent opacity-25";
    case 2:
      return "bg-icon_default_accent opacity-50";
    case 3:
      return "bg-icon_default_accent opacity-75";
    case 4:
      return "bg-icon_default_accent";
    default:
      return "bg-bg_grouped_tertiary";
  }
}

/** The cell's own label: the day, and how much was used on it. */
function cellLabel(cell: WebuiUsageHeatmapCell): string {
  const date = formatUsageCellDate(cell.date);
  return cell.totalToken > 0
    ? `${date}, ${formatCompactToken(cell.totalToken)} tokens`
    : `${date}, 无用量`;
}

export function UsageHeatmap({
  model,
  columnCount = 50,
  showMonths = true,
  align = "center",
  testId = "account-usage-heatmap",
}: UsageHeatmapProps): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<HoveredCell | null>(null);
  /**
   * The cell tooltip is a floating layer above the page (ADR 0028 § Overlay
   * coordination), so it registers with the coordinator rather than floating
   * outside the client's order. It has no way out of its own — it follows the
   * cell under the pointer — so it leaves a dismissal unanswered, and it sits
   * behind the page's own layers so it never takes a key away from them.
   */
  const tipLayerId = useDialogLayer({
    id: "usage-heatmap-tip",
    order: -10,
    dismissible: false,
    active: hovered !== null,
  });
  const columns = model.columns.slice(-columnCount);
  const firstColumnIndex = columns[0]?.cells[0]?.columnIndex ?? 0;
  const width = 10 * columns.length + 4 * Math.max(0, columns.length - 1);
  const monthLabels = model.monthLabels
    .filter(
      (label) =>
        label.columnIndex >= firstColumnIndex &&
        label.columnIndex < firstColumnIndex + columns.length,
    )
    .map((label) => ({ ...label, visibleColumnIndex: label.columnIndex - firstColumnIndex }));

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [columnCount, model]);

  const portalTarget = dom.portalTarget();

  return (
    <div ref={scrollRef} className="max-w-full overflow-x-auto" data-testid={testId}>
      <div className={align === "center" ? "mx-auto" : undefined} style={{ width }}>
        <div
          className="grid grid-flow-col gap-1"
          style={{
            gridTemplateColumns: `repeat(${columns.length}, 10px)`,
            gridTemplateRows: "repeat(7, 10px)",
          }}
        >
          {columns.flatMap((column) =>
            column.cells.map((cell) => {
              if (cell.kind === "future") {
                return (
                  <span
                    key={cell.date}
                    className="h-2.5 w-2.5 rounded-sm bg-transparent"
                    data-testid={`usage-cell-${cell.date}`}
                    aria-hidden="true"
                  />
                );
              }
              if (cell.kind === "unregistered") {
                return (
                  <span
                    key={cell.date}
                    className="h-2.5 w-2.5 rounded-sm bg-bg_grouped_tertiary opacity-50"
                    data-testid={`usage-cell-${cell.date}`}
                    aria-hidden="true"
                  />
                );
              }
              return (
                <WebuiButton
                  key={cell.date}
                  variant="plain"
                  size="heatmap-cell"
                  className={levelClassName(cell.level)}
                  aria-label={cellLabel(cell)}
                  data-testid={`usage-cell-${cell.date}`}
                  onMouseEnter={(event) =>
                    setHovered(readHoveredCell(cell, event.currentTarget))
                  }
                  onMouseLeave={() => setHovered(null)}
                  onFocus={(event) =>
                    setHovered(readHoveredCell(cell, event.currentTarget))
                  }
                  onBlur={() => setHovered(null)}
                />
              );
            }),
          )}
        </div>
        {showMonths ? (
          <div className="relative mt-2 h-4 text-xs leading-4 text-text_default_tertiary">
            {monthLabels.map((label) => (
              <span
                key={`${label.label}-${label.columnIndex}`}
                className="absolute top-0"
                style={{ left: 14 * label.visibleColumnIndex }}
              >
                {label.label}月
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {portalTarget && hovered
        ? createPortal(
            <div
              className="webui-account-usage-cell-tip"
              style={{ left: hovered.left, top: hovered.top }}
              data-overlay-layer={tipLayerId}
              role="presentation"
            >
              <div className="webui-account-usage-cell-tip-date">
                {formatUsageCellDate(hovered.cell.date)}
              </div>
              <div className="webui-account-usage-cell-tip-value">
                {hovered.cell.totalToken > 0
                  ? `${formatCompactToken(hovered.cell.totalToken)} tokens`
                  : "无用量"}
              </div>
            </div>,
            portalTarget,
          )
        : null}
    </div>
  );
}

/**
 * The hovered cell and where its tooltip goes. The tooltip is placed above the
 * cell and centred on it, the way the Desktop's top-placed tooltip sits.
 */
function readHoveredCell(
  cell: WebuiUsageHeatmapCell,
  element: HTMLElement,
): HoveredCell {
  const rect = element.getBoundingClientRect();
  return {
    cell,
    left: rect.left + rect.width / 2,
    top: rect.top,
  };
}
