// Pure-presentation transcript primitives — leaves of the component tree.
//
// The transcript structure and data attributes remain stable; the live thinking
// marker is intentionally shared with ActivityIndicator so streaming never
// renders a second, static animation implementation.
//
// `WebuiToolRow` stays private — it is a non-exported helper used only by
// `WebuiToolResults`.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { IconBrowser, IconBrain, IconCode, IconFile, IconHammer, IconHexagon, IconListCheck, IconMusic, IconPhoto, IconRobot, IconSearch, IconSparkles, IconSquares, IconTarget, IconTerminal2, IconVideo, IconWorld } from "@tabler/icons-react";
import { ActivityIndicator } from "./ActivityIndicator.js";
import {
  WebuiIconChevronDown,
  WebuiIconDiffFile,
  WebuiIconDiffSummary,
} from "../../../shell/icons.js";
import { WebuiMarkdown } from "./markdown.public.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiStack } from "../../../ui/layout-primitives.js";
import {
  isWebuiEditTool,
  toolCallInputText,
  toolCallName,
  toolCallIconCategory,
  toolCallLabel,
  toolCallResultText,
  toolCallErrorText,
  toolCallStatus,
  toolCallStatusLabel,
  toolCallResourcePath,
  webuiActivitySummary,
  webuiEditFileStat,
} from "../projection/tool-projection.js";

function WebuiToolRow({
  tool,
  index,
}: {
  readonly tool: Record<string, unknown>;
  readonly index: number;
}): ReactElement {
  const input = toolCallInputText(tool);
  const result = toolCallResultText(tool);
  const error = toolCallErrorText(tool);
  const status = toolCallStatus(tool);
  const statusLabel = status === "completed" ? undefined : toolCallStatusLabel(status);
  const resourcePath = toolCallResourcePath(tool);
  const pathSegments = resourcePath?.replaceAll("\\", "/").split("/").filter(Boolean) ?? [];
  const resourceLabel = pathSegments[pathSegments.length - 1] ?? resourcePath;
  return (
    <details
      key={`tool-call-${toolCallName(tool)}-${index}`}
      className="webui-tool-row"
      data-webui-tool-call={toolCallName(tool)}
      data-webui-tool-status={status}
    >
      <summary className="webui-tool-row-summary">
        <span className={`webui-tool-icon webui-tool-icon--${toolCallIconCategory(tool)}`} aria-hidden="true">
          <WebuiToolIcon category={toolCallIconCategory(tool)} />
        </span>
        <span className="webui-tool-label">
          {toolCallLabel(tool)}
          {statusLabel ? ` · ${statusLabel}` : ""}
        </span>
        {resourcePath ? <span className="webui-tool-resource-path" title={resourcePath}>{resourceLabel}</span> : null}
        {!resourcePath ? <WebuiIconChevronDown className="webui-tool-chevron" /> : null}
      </summary>
      {status === "running" && !input && !result && !error ? (
        <WebuiToolDetailShell title={toolCallLabel(tool)}>
          <div className="webui-tool-detail-running">运行中…</div>
        </WebuiToolDetailShell>
      ) : input || result || error ? (
        <WebuiToolDetailShell title={toolCallLabel(tool)}>
          {input !== undefined ? <WebuiToolDetailSection label="输入" value={formatToolInputForDisplay(input)} /> : null}
          {result !== undefined ? <WebuiToolDetailSection label="结果" value={result} /> : null}
          {error !== undefined ? <WebuiToolDetailSection label="错误" value={error} error /> : status === "error" ? <WebuiToolDetailSection label="错误" value="执行失败" error /> : null}
        </WebuiToolDetailShell>
      ) : null}
    </details>
  );
}

function WebuiToolDetailShell({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="webui-tool-detail" data-webui-tool-result="true">
      <div className="webui-tool-detail-surface">
        <WebuiStack gap="small" className="webui-tool-detail-body">
          <div className="webui-tool-detail-title">{title}</div>
          <div className="webui-tool-detail-divider" aria-hidden="true" />
          <WebuiStack gap="small" className="webui-tool-detail-content">{children}</WebuiStack>
        </WebuiStack>
      </div>
    </div>
  );
}

function formatToolInputForDisplay(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(parsed, null, 2) ?? value;
    }
  } catch {
    // Non-JSON inputs such as shell commands remain unchanged.
  }
  return value;
}

function WebuiToolDetailSection({
  label,
  value,
  error = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly error?: boolean;
}): ReactElement {
  return (
    <WebuiStack as="section" gap="small" className="webui-tool-detail-section">
      <div className={error ? "webui-tool-detail-label is-error" : "webui-tool-detail-label"}>{label}</div>
      <pre>{value.length > 2000 ? `${value.slice(0, 2000)}...` : value}</pre>
    </WebuiStack>
  );
}

function WebuiToolIcon({ category }: { readonly category: ReturnType<typeof toolCallIconCategory> | "combine" }): ReactElement {
  const icons = {
    command: IconTerminal2, file: IconFile, code: IconCode, search: IconSearch,
    web: IconWorld, browser: IconBrowser, logo: IconHexagon, memory: IconBrain,
    image: IconPhoto, video: IconVideo, music: IconMusic, tool: IconHammer,
    task: IconListCheck, bot: IconRobot, goal: IconTarget, thinking: IconSparkles,
    combine: IconSquares,
  } as const;
  const Glyph = icons[category];
  return <Glyph aria-hidden="true" size={20} stroke={1.55} />;
}

/** Tool rows remain the fallback only when the runtime diff facade is absent. */
export function WebuiToolResults({
  tools,
  authoritativeDiffAvailable = false,
  showEditToolRows = false,
}: {
  readonly tools: readonly Record<string, unknown>[];
  readonly authoritativeDiffAvailable?: boolean;
  /** Activity disclosures list each tool call even when the turn diff card is available. */
  readonly showEditToolRows?: boolean;
}): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  const edits = tools.filter(isWebuiEditTool);
  const others = tools.filter((tool) => !isWebuiEditTool(tool));
  const renderRows = (rows: readonly Record<string, unknown>[]) =>
    rows.map((tool, index) => (
      <WebuiToolRow
        key={`tool-call-${toolCallName(tool)}-${index}`}
        tool={tool}
        index={index}
      />
    ));
  if (edits.length === 0) {
    return (
      <WebuiStack gap="small" className="webui-tool-list" data-webui-tool-list="true">
        {renderRows(tools)}
      </WebuiStack>
    );
  }
  if (authoritativeDiffAvailable) {
    return (
      <WebuiStack gap="small" className="webui-tool-list" data-webui-tool-list="true">
        {renderRows(showEditToolRows ? tools : others)}
      </WebuiStack>
    );
  }
  const stats = edits.map(webuiEditFileStat);
  const totalAdded = stats.reduce((sum, stat) => sum + stat.added, 0);
  const totalDeleted = stats.reduce((sum, stat) => sum + stat.deleted, 0);
  const shown = expanded ? stats : stats.slice(0, 3);
  return (
    <div className="webui-diff-card" data-webui-diff-card="true">
      <div className="webui-diff-header">
        <div className="webui-diff-summary">
          <span className="webui-diff-icon" aria-hidden="true"><WebuiIconDiffSummary /></span>
          <span className="webui-diff-header-content">
            <span className="webui-diff-header-title" data-webui-diff-title="true">
              {`已编辑 ${edits.length} 个文件`}
            </span>
            {totalAdded > 0 || totalDeleted > 0 ? (
              <span className="webui-diff-header-stats">
                {totalAdded > 0 ? (
                  <span className="webui-diff-add">{`+${totalAdded}`}</span>
                ) : null}
                {totalDeleted > 0 ? (
                  <span className="webui-diff-del">{`-${totalDeleted}`}</span>
                ) : null}
              </span>
            ) : null}
          </span>
        </div>
      </div>
      <ul className="webui-diff-files">
        {shown.map((stat, index) => (
          <li
            className="webui-diff-file"
            key={`${stat.name ?? "file"}-${index}`}
          >
            <span className="webui-diff-file-icon" data-testid="turn-diff-file-icon"><WebuiIconDiffFile fileName={stat.name ?? undefined} /></span>
            <span className="webui-diff-file-name">{stat.name ?? "文件"}</span>
            {stat.added > 0 || stat.deleted > 0 ? (
              <span className="webui-diff-file-stats">
                {stat.added > 0 ? (
                  <span className="webui-diff-add">{`+${stat.added}`}</span>
                ) : null}
                {stat.deleted > 0 ? (
                  <span className="webui-diff-del">{`-${stat.deleted}`}</span>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {stats.length > 3 ? (
        <WebuiButton
          variant="plain"
          size="regular"
          className="webui-diff-expand"
          data-webui-diff-expand="true"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : `展开其余 ${stats.length - 3} 个`}
        </WebuiButton>
      ) : null}
      {others.length > 0 ? (
        <WebuiStack gap="small" className="webui-tool-list" data-webui-tool-list="true">
          {renderRows(others)}
        </WebuiStack>
      ) : null}
    </div>
  );
}

/** Activity group: a 16px activity header and a timeline body. */
export function WebuiActivityGroup({
  tools,
  authoritativeDiffAvailable = false,
  activityItems,
  initiallyExpanded = false,
  showStreamingStatus = true,
}: {
  readonly tools: readonly Record<string, unknown>[];
  readonly authoritativeDiffAvailable?: boolean;
  readonly activityItems?: readonly WebuiActivityGroupItem[];
  readonly initiallyExpanded?: boolean;
  readonly showStreamingStatus?: boolean;
}): ReactElement | null {
  const active = tools.some((tool) => {
    const status = toolCallStatus(tool);
    return status === "pending" || status === "running";
  });
  const [expanded, setExpanded] = useState(initiallyExpanded);
  if (tools.length === 0) return null;
  const thinkingCount = activityItems?.filter((item) => item.type === "thinking").length ?? 0;
  const summary = [
    ...(thinkingCount > 0 ? [`思考 ${thinkingCount} 次`] : []),
    webuiActivitySummary(tools),
  ].join("，");
  const categories = [...new Set(tools.map(toolCallIconCategory))];
  const iconCategory = categories.length > 1 ? "combine" : categories[0] ?? "tool";
  const detailItems: ReactElement[] = [];
  if (activityItems) {
    for (let index = 0; index < activityItems.length; index += 1) {
      const item = activityItems[index];
      if (!item) continue;
      if (item.type === "thinking") {
        detailItems.push(<WebuiThinkingBlock key={`thinking-${index}`} text={item.text} durationMs={item.durationMs} streaming={item.streaming} showStreamingStatus={showStreamingStatus} summaryLabel="思考过程" />);
        continue;
      }
      const groupedTools: Record<string, unknown>[] = [item.tool];
      while (activityItems[index + 1]?.type === "tool") {
        index += 1;
        const next = activityItems[index];
        if (next?.type === "tool") groupedTools.push(next.tool);
      }
      detailItems.push(<WebuiToolResults key={`tools-${index}`} tools={groupedTools} authoritativeDiffAvailable={authoritativeDiffAvailable} showEditToolRows />);
    }
  }
  return (
    <details
      className="activity-group"
      data-testid="activity-group"
      data-active={active ? "true" : undefined}
      open={active || expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="activity-group-header">
        <span className="activity-group-icon" data-webui-activity-icon-category={iconCategory} aria-hidden="true"><WebuiToolIcon category={iconCategory} /></span>
        <span className="activity-group-summary">{summary}</span>
        <WebuiIconChevronDown className="activity-group-chevron" />
      </summary>
      <div className="activity-group-body">
        <span className="timeline-spine" aria-hidden="true" />
        <div className="activity-group-items">
          {activityItems ? detailItems : <WebuiToolResults tools={tools} authoritativeDiffAvailable={authoritativeDiffAvailable} showEditToolRows />}
        </div>
      </div>
    </details>
  );
}

export type WebuiActivityGroupItem =
  | { readonly type: "thinking"; readonly text: string; readonly durationMs?: number; readonly streaming?: boolean }
  | { readonly type: "tool"; readonly tool: Record<string, unknown> };

export function WebuiTurnProcess({
  active,
  startedAtMs,
  endedAtMs,
  tokenCount,
  requestDurationMs,
  wallClockDurationMs,
  children,
  collapsedContent,
  hasExpandableContent = true,
  forceExpanded = false,
  disabled = false,
  initiallyExpanded = false,
  summaryPrefix,
  showLiveActivity = false,
}: {
  readonly active: boolean;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  /** Approximate token count streamed during the turn. Used to derive the
   *  "output rate" (`{N} token/s`) when the turn has finished. */
  readonly tokenCount?: number;
  /** Wall-clock duration of the turn measured by the runtime
   *  (`usage.request_duration_ms`). When this is present it wins over the
   *  wall-clock fallback for finished turns. */
  readonly requestDurationMs?: number;
  /** Wall-clock duration computed from message timestamps (oldest user →
   *  newest assistant inside the turn). Used when neither the runtime nor
   *  `startedAtMs` give us a number — this is the only honest signal the
   *  runtime hands us, so render its real value rather than guess. */
  readonly wallClockDurationMs?: number;
  readonly children: ReactElement | ((expanded: boolean) => ReactElement);
  /** Content that remains visible outside the collapsible details while the
   *  process is collapsed (for example, the final assistant reply). */
  readonly collapsedContent?: (expanded: boolean) => ReactNode;
  /** An outer disclosure control renders only when this turn has
   *  content that can actually be expanded. The duration summary can remain
   *  visible without the control. */
  readonly hasExpandableContent?: boolean;
  /** Turn-process modes: these states suppress the toggle
   *  and keep available details open. */
  readonly forceExpanded?: boolean;
  readonly disabled?: boolean;
  readonly initiallyExpanded?: boolean;
  readonly summaryPrefix?: string;
  /** Render one live thinking indicator after the complete turn content. */
  readonly showLiveActivity?: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) setExpanded(false);
    wasActive.current = active;
  }, [active]);
  const canToggle = hasExpandableContent && !forceExpanded && !disabled;
  const contentExpanded = forceExpanded || disabled || active || expanded;
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => forceTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
  // Priority for finished turns:
  //   1. `requestDurationMs` from the runtime usage block
  //   2. `wallClockDurationMs` from the message timestamp span
  //   3. fall back to "0 秒" so we never lie about elapsed time
  // Live turns tick from `startedAtMs` → now.
  const seconds =
    typeof startedAtMs === "number"
      ? Math.max(
          0,
          Math.floor(
            ((active
              ? Date.now()
              : typeof requestDurationMs === "number"
                ? startedAtMs + requestDurationMs
                : endedAtMs ?? Date.now()) -
              startedAtMs) /
              1000,
          ),
        )
      : typeof requestDurationMs === "number"
        ? Math.floor(requestDurationMs / 1000)
        : typeof wallClockDurationMs === "number"
          ? Math.floor(wallClockDurationMs / 1000)
          : undefined;
  // The wall-clock duration renders as "M 分 N 秒" / "N 秒".
  const durationLabel =
    typeof seconds === "number"
      ? seconds >= 60
        ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
        : `${seconds} 秒`
      : undefined;
  const outputRateLabel =
    !active &&
    typeof seconds === "number" &&
    seconds > 0 &&
    typeof tokenCount === "number" &&
    tokenCount > 0
      ? `${Math.round(tokenCount / seconds)} token/s`
      : undefined;
  const durationSummary = durationLabel
    ? active
      ? `已执行 ${durationLabel}`
      : `共执行 ${durationLabel}`
      : active
        ? "已执行 0 秒"
        : "共执行 0 秒";
  const summary = summaryPrefix ? `${summaryPrefix}，${durationSummary}` : durationSummary;
  return (
    <section className="pt-2" data-testid="turn-process-disclosure">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2" data-testid="turn-process-summary">
        {canToggle ? (
          <WebuiButton
            variant="quiet-subtle"
            size="inline"
            className="group/turn-process flex items-center gap-1 py-1 text-center text-sm font-normal leading-5 tracking-normal"
            aria-expanded={contentExpanded}
            data-testid="turn-process-trigger"
            data-summary-text={summary}
            onClick={() => setExpanded((value) => !value)}
          >
            <span data-testid="turn-process-summary-text">{summary}</span>
            <span
              data-testid="turn-process-chevron"
              className={`-ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center text-icon_interaction_tertiary_default transition-transform duration-200 ease-out motion-reduce:transition-none group-hover/turn-process:text-icon_interaction_tertiary_hover ${contentExpanded ? "rotate-90" : ""}`}
            >
              <WebuiIconChevronDown className="size-4" />
            </span>
          </WebuiButton>
        ) : (
          <span
            className="text-activity-body-small flex items-center gap-2 py-1 text-center text-sm font-normal leading-5 tracking-normal text-text_label_tertiary_default"
            data-testid="turn-process-summary-text"
            data-summary-text={summary}
          >
            {summary}
          </span>
        )}
        {!active && outputRateLabel ? (
          <span
            className="ml-auto text-text_default_tertiary text-size_12"
            data-testid="turn-output-rate"
          >
            <span className="sr-only">输出速度：</span>
            {outputRateLabel}
          </span>
        ) : null}
      </div>
      <div className="mt-2 border-b-[0.5px] border-border_default" data-testid="turn-process-separator" aria-hidden="true" />
      {hasExpandableContent ? (
        <WebuiStack gap="roomy" className="mt-2" data-testid="turn-process-detail" hidden={!contentExpanded}>
          {typeof children === "function" ? children(contentExpanded) : contentExpanded ? children : null}
        </WebuiStack>
      ) : null}
      {collapsedContent?.(contentExpanded)}
      {active && showLiveActivity ? (
        <div className="webui-thinking-live-status" data-webui-thinking-live-status="true">
          <ActivityIndicator aria-hidden="true" />
          <span>推理中...</span>
          {typeof seconds === "number" && seconds >= 1 ? (
            <span className="webui-thinking-elapsed">{seconds}s</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function WebuiThinkingBlock({
  text,
  durationMs,
  streaming = false,
  processingStartedAtMs,
  summaryLabel,
  showDetailHeading = false,
  showStreamingStatus = true,
  initiallyExpanded = false,
}: {
  readonly text: string;
  readonly durationMs?: number;
  readonly streaming?: boolean;
  readonly processingStartedAtMs?: number;
  readonly summaryLabel?: string;
  readonly showDetailHeading?: boolean;
  readonly showStreamingStatus?: boolean;
  readonly initiallyExpanded?: boolean;
}): ReactElement | null {
  const [, forceTick] = useState(0);
  const [detailOpen, setDetailOpen] = useState(initiallyExpanded);
  const [contentExpanded, setContentExpanded] = useState(false);
  const [contentOverflows, setContentOverflows] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!streaming || !showStreamingStatus) return undefined;
    const timer = setInterval(() => forceTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [streaming, showStreamingStatus]);
  useEffect(() => {
    const content = contentRef.current;
    if (!detailOpen || !content) return undefined;
    const measure = () => setContentOverflows(content.scrollHeight > 224);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [detailOpen, text]);
  if (!text.trim()) return null;
  // `think-container`: a pulse dot + 推理中... with a live-second
  // counter while streaming, collapsing to 已完成推理 + total seconds.
  const elapsed = streaming
    ? typeof processingStartedAtMs === "number"
      ? Math.max(0, Math.floor((Date.now() - processingStartedAtMs) / 1000))
      : undefined
    : typeof durationMs === "number" && durationMs > 0
      ? Math.max(1, Math.floor(durationMs / 1000))
      : undefined;
  return (
    <details className="webui-thinking-block" data-webui-thinking-block="true" open={streaming || detailOpen} onToggle={(event) => setDetailOpen(event.currentTarget.open)}>
      <summary className="webui-thinking-summary" data-webui-thinking="true">
        {summaryLabel === "思考过程" ? (
          <span className="webui-tool-icon webui-tool-icon--thinking" aria-hidden="true"><WebuiToolIcon category="thinking" /></span>
        ) : null}
        <span>{summaryLabel ?? (streaming ? "推理中..." : "已完成推理")}</span>
        {!streaming && typeof elapsed === "number" && elapsed >= 1 ? (
          <span className="webui-thinking-elapsed">{elapsed}s</span>
        ) : null}
        <WebuiIconChevronDown className="webui-thinking-chevron" />
      </summary>
      <div className="webui-thinking-detail">
        {showDetailHeading ? (
          <div className="webui-thinking-detail-heading">
            <span className="webui-tool-icon webui-tool-icon--thinking" aria-hidden="true"><WebuiToolIcon category="thinking" /></span>
            <span>思考过程</span>
          </div>
        ) : null}
        <div className={`webui-thinking-detail-content${contentOverflows && !contentExpanded ? " is-clamped" : ""}`} ref={contentRef}>
          <WebuiMarkdown source={text} />
        </div>
        {contentOverflows ? (
          <WebuiButton variant="quiet-subtle" size="inline" className="webui-thinking-expand" onClick={() => setContentExpanded((expanded) => !expanded)}>
            {contentExpanded ? "收起" : "展开"}
          </WebuiButton>
        ) : null}
      </div>
      {streaming && showStreamingStatus ? (
        <div className="webui-thinking-live-status" data-webui-thinking-live-status="true">
          <ActivityIndicator aria-hidden="true" />
          <span>推理中...</span>
          {typeof elapsed === "number" && elapsed >= 1 ? (
            <span className="webui-thinking-elapsed">{elapsed}s</span>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

/** The `turn_process` row: 已执行 N 秒, ticking once per second. */
export function TurnElapsedRow({
  startedAtMs,
  running,
}: {
  readonly startedAtMs: number;
  readonly running: boolean;
}): ReactElement | null {
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => forceTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const seconds = Math.floor((Date.now() - startedAtMs) / 1000);
  if (seconds < 1) return null;
  return (
    <p className="webui-turn-elapsed" data-webui-turn-elapsed="true">
      {running ? `已执行 ${seconds} 秒` : `共执行 ${seconds} 秒`}
    </p>
  );
}
