// TranscriptSkeletons — the first-paint placeholder shown when the transcript
// viewport is still loading history: `chat-skeleton` for ongoing sessions and
// `greeting-skeleton` for fresh / no-history cases.
//
// The line widths (8 primary + 4 secondary) are fixed, and the gradient mask
// lives in `transcript-widgets.css`'s
// `@keyframes transcript-shimmer` + `.animate-shimmer` rule. Both are pinned
// by `transcript-skeletons.test.tsx`.
//
// The 736px content column below MUST track `.webui-session-layout
// .message-list`'s `max-width` in `shell.css`. These skeletons stand in for
// the message list while history loads, so a wider skeleton makes the
// transcript jump sideways when the real content lands.
// `webui-w0-css-structure.test.ts` asserts the two stay in lockstep.
//
// The shimmer is just a background colour rectangle —
// `--shimmer-duration` is set by the CSS file at the body level so the
// animation interval stays in lockstep with the rest of the WebUI shell.

import type { CSSProperties } from "react";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";

/**
 * Matches `.webui-session-layout .message-list`'s `max-width` in `shell.css`.
 * Kept as a named constant so the coupling is visible at the call sites and
 * the guard test can assert against it directly.
 */
export const SKELETON_CONTENT_MAX_WIDTH_PX = 736;

const LINE_WIDTHS: readonly string[] = [
  "76%",
  "53%",
  "63%",
  "35%",
  "53%",
  "35%",
  "73%",
  "53%",
];

const SECONDARY_WIDTHS: readonly string[] = ["76%", "53%", "63%", "35%"];

const gradientMask: CSSProperties = {
  maskImage: "linear-gradient(180deg, black 0%, transparent 100%)",
  WebkitMaskImage: "linear-gradient(180deg, black 0%, transparent 100%)",
};

const shimmerBase = {
  background: "var(--bg_default_tertiary)",
};

function ShimmerBar(props: { width: string | number; height: number; rounded?: string }): React.JSX.Element {
  const { width, height, rounded = "0.5rem" } = props;
  return (
    <div
      className="animate-shimmer"
      style={{
        ...shimmerBase,
        width,
        height,
        borderRadius: rounded,
      }}
    />
  );
}

export function ChatSkeleton(): React.JSX.Element {
  return (
    <WebuiStack className="flex-1 overflow-hidden" data-testid="chat-skeleton">
      <WebuiStack
        className="mx-auto"
        style={{ maxWidth: `${SKELETON_CONTENT_MAX_WIDTH_PX}px` }}
      >
        <WebuiInline justify="end">
          <ShimmerBar width={280} height={48} rounded="1rem" />
        </WebuiInline>
        <WebuiStack className="mt-5">
          <WebuiStack className="webui-transcript-skeleton-lines">
            {LINE_WIDTHS.map((width, index) => (
              <ShimmerBar key={`a${index}`} width={width} height={22} />
            ))}
          </WebuiStack>
          <WebuiStack gap="small" className="mt-2" style={gradientMask}>
            {SECONDARY_WIDTHS.map((width, index) => (
              <ShimmerBar key={`b${index}`} width={width} height={24} />
            ))}
          </WebuiStack>
        </WebuiStack>
      </WebuiStack>
    </WebuiStack>
  );
}

export function GreetingSkeleton(): React.JSX.Element {
  return (
    <WebuiStack className="flex-1 overflow-hidden" data-testid="greeting-skeleton">
      <WebuiStack
        className="mx-auto"
        style={{ maxWidth: `${SKELETON_CONTENT_MAX_WIDTH_PX}px` }}
      >
        <ShimmerBar width={40} height={40} rounded="9999px" />
        <WebuiStack className="mt-4">
          <WebuiStack className="webui-transcript-skeleton-lines">
            {LINE_WIDTHS.map((width, index) => (
              <ShimmerBar key={`a${index}`} width={width} height={22} />
            ))}
          </WebuiStack>
          <WebuiStack gap="small" className="mt-2" style={gradientMask}>
            {SECONDARY_WIDTHS.map((width, index) => (
              <ShimmerBar key={`b${index}`} width={width} height={24} />
            ))}
          </WebuiStack>
        </WebuiStack>
      </WebuiStack>
    </WebuiStack>
  );
}
