// TurnNavigator — the right-edge tick strip + hover preview card.
//
// The heavy state (history paging, scroll sync, mask edges, artefacts
// overflow detection, intersection observers, debounced hover transitions)
// stays in the parent; this component is the presentational seam and receives
// pre-computed `turnSummaries`. Each tick carries a `data-turn-id` and a
// `data-state`, both pinned by `turn-navigator.test.tsx`.
//
// All testids are preserved verbatim:
//
//   message-turn-navigator, -strip, -tick, -tick-hit-target, -mask-top,
//   -mask-bottom, -preview, -preview-title, -preview-time, -preview-previous-query,
//   -preview-next-query, -preview-response, -preview-divider, -preview-artifacts,
//   -preview-file-change-count, -preview-artifact-icon, -preview-artifact-label.
//
// The mask gradients (left/right artefacts scroll edge; top/bottom strip edge)
// are written as inline gradients — see `transcript-widgets.css` for the
// utility classes (`shadow-s1`,
// `transcript-navigator-mask-{left,right,top,bottom}`).
//
// Interaction (hover, scroll, jump) is owned by the integrator; this surface
// accepts `onTickHover`, `onTickActivate`, `onMaskTopClick`, `onMaskBottomClick`.

import { useState, type CSSProperties, type MouseEvent } from "react";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";

export type TurnState = "default" | "active" | "running" | "completed" | "error";

export interface TurnSummary {
  id: string;
  state: TurnState;
}

export interface TurnNavigatorPreviewArtefact {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

export interface TurnNavigatorPreviewFileChange {
  additions: number;
  deletions: number;
}

export interface TurnNavigatorPreview {
  title: string;
  time?: string;
  previousQuery?: string;
  nextQuery?: string;
  response?: string;
  artefacts?: readonly TurnNavigatorPreviewArtefact[];
  fileChangeCount?: TurnNavigatorPreviewFileChange;
  showLeftMask?: boolean;
  showRightMask?: boolean;
  showTopMask?: boolean;
  showBottomMask?: boolean;
}

export interface TurnNavigatorProps {
  mode?: "default" | "compact";
  hidden?: boolean;
  turns: readonly TurnSummary[];
  preview?: TurnNavigatorPreview | null;
  className?: string;
  onTickHover?: (turnId: string, event: MouseEvent<HTMLDivElement>) => void;
  onTickLeave?: (turnId: string, event: MouseEvent<HTMLDivElement>) => void;
  onTickActivate?: (turnId: string, event: MouseEvent<HTMLButtonElement>) => void;
  onMaskTopClick?: (event: MouseEvent<HTMLSpanElement>) => void;
  onMaskBottomClick?: (event: MouseEvent<HTMLSpanElement>) => void;
}

const stripStyle: CSSProperties = {
  position: "absolute",
};

const previewStyle: CSSProperties = {};

const tickHitTargetBase =
  "flex h-3 w-full items-center justify-center";

const tickBase =
  "block size-2 rounded-full transition-colors";

const STATE_CLASS: Record<TurnState, string> = {
  default: "bg-bg_default_tertiary",
  active: "bg-bg_interaction_accent_default",
  running: "bg-bg_status_blue",
  completed: "bg-bg_default_tertiary",
  error: "bg-bg_status_error",
};

export function TurnNavigator(props: TurnNavigatorProps): React.JSX.Element {
  const {
    mode = "default",
    hidden = false,
    turns,
    preview = null,
    className,
    onTickHover,
    onTickLeave,
    onTickActivate,
    onMaskTopClick,
    onMaskBottomClick,
  } = props;

  const containerClass = [
    "absolute right-2 top-1/2 z-10 flex w-3 -translate-y-1/2 flex-col items-center",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const [internalShowTop, setInternalShowTop] = useState(true);
  const [internalShowBottom, setInternalShowBottom] = useState(true);
  const showTop = preview?.showTopMask ?? internalShowTop;
  const showBottom = preview?.showBottomMask ?? internalShowBottom;

  return (
    <div
      className={containerClass}
      data-testid="message-turn-navigator"
      data-mode={mode}
      data-hidden={hidden ? "true" : "false"}
      style={previewStyle}
    >
      <WebuiStack
        align="center"
        className="relative h-full w-full"
        data-testid="message-turn-navigator-strip"
        style={stripStyle}
      >
        {turns.map((turn) => (
          <div
            key={turn.id}
            className={tickHitTargetBase}
            data-testid="message-turn-navigator-tick-hit-target"
            data-turn-id={turn.id}
            onMouseEnter={(event) => onTickHover?.(turn.id, event)}
            onMouseLeave={(event) => onTickLeave?.(turn.id, event)}
          >
            <WebuiButton
              variant="plain"
              size="regular"
              className={`${tickBase} ${STATE_CLASS[turn.state]}`}
              data-testid="message-turn-navigator-tick"
              data-turn-id={turn.id}
              data-state={turn.state}
              aria-label={`Turn ${turn.id}`}
              onClick={(event) => onTickActivate?.(turn.id, event)}
            />
          </div>
        ))}
        {showTop ? (
          <span
            className="transcript-navigator-mask-top pointer-events-none absolute left-0 top-0 z-10 h-5 w-full"
            data-testid="message-turn-navigator-mask-top"
            onClick={onMaskTopClick}
          />
        ) : null}
        {showBottom ? (
          <span
            className="transcript-navigator-mask-bottom pointer-events-none absolute bottom-0 left-0 z-10 h-5 w-full"
            data-testid="message-turn-navigator-mask-bottom"
            onClick={onMaskBottomClick}
          />
        ) : null}
      </WebuiStack>

      {preview ? (
        <div
          className="pointer-events-auto absolute rounded-xl border border-border_light bg-bg_grouped_secondary_elevated p-3 text-text_default_primary shadow-s1"
          data-testid="message-turn-navigator-preview"
          style={{
            right: "calc(100% + 8px)",
            top: "0",
            width: "min(360px, calc(100vw - 32px))",
          }}
        >
          {preview.previousQuery ? (
            <div
              className="absolute left-0 box-border flex h-10 w-max max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-xl border border-border_light bg-bg_grouped_secondary_elevated p-3 text-xs font-medium leading-4 text-text_default_secondary shadow-s1"
              data-testid="message-turn-navigator-preview-previous-query"
              style={{ top: "-12px" }}
            >
              {preview.previousQuery}
            </div>
          ) : null}

          <div
            className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5 text-text_default_primary"
            data-testid="message-turn-navigator-preview-title"
          >
            {preview.title}
          </div>
          {preview.time ? (
            <div
              className="mt-1 text-xs leading-4 tabular-nums text-text_default_tertiary"
              data-testid="message-turn-navigator-preview-time"
            >
              {preview.time}
            </div>
          ) : null}

          {preview.response ? (
            <div
              className="mt-2 max-h-[60px] overflow-hidden text-ellipsis text-sm leading-5 text-text_default_secondary"
              data-testid="message-turn-navigator-preview-response"
              style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}
            >
              {preview.response}
            </div>
          ) : null}

          {preview.fileChangeCount || (preview.artefacts && preview.artefacts.length > 0) ? (
            <WebuiInline
              align="center"
              className="h-5"
              data-testid="message-turn-navigator-preview-divider"
            >
              <div className="h-px w-full bg-border_default" />
            </WebuiInline>
          ) : null}

          {preview.artefacts && preview.artefacts.length > 0 ? (
            <WebuiInline
              gap="medium"
              className="pointer-events-auto scrollbar-hide flex-nowrap overflow-x-auto overflow-y-hidden"
              data-testid="message-turn-navigator-preview-artifacts"
            >
              {preview.artefacts.map((artefact) => (
                <WebuiInline key={artefact.id} gap="small" className="shrink-0">
                  <span
                    className="flex size-5 shrink-0 items-center justify-center rounded bg-bg_grouped_primary_elevated"
                    data-testid="message-turn-navigator-preview-artifact-icon"
                  >
                    {artefact.icon ?? null}
                  </span>
                  <span
                    className="max-w-[140px] truncate text-sm leading-5 text-text_default_secondary"
                    data-testid="message-turn-navigator-preview-artifact-label"
                  >
                    {artefact.label}
                  </span>
                </WebuiInline>
              ))}
            </WebuiInline>
          ) : null}

          {preview.fileChangeCount ? (
            <WebuiInline
              inline
              gap="small"
              className="mt-1 shrink-0 text-sm leading-5 text-text_default_secondary"
              data-testid="message-turn-navigator-preview-file-change-count"
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded bg-bg_grouped_tertiary">
                <span data-testid="message-turn-navigator-preview-file-change-count-icon" />
              </span>
              <span>
                +{preview.fileChangeCount.additions} / -{preview.fileChangeCount.deletions}
              </span>
            </WebuiInline>
          ) : null}

          {preview.nextQuery ? (
            <div
              className="absolute left-0 box-border flex h-10 w-max max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-xl border border-border_light bg-bg_grouped_secondary_elevated p-3 text-xs font-medium leading-4 text-text_default_secondary shadow-s1"
              data-testid="message-turn-navigator-preview-next-query"
              style={{ bottom: "-12px" }}
            >
              {preview.nextQuery}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
