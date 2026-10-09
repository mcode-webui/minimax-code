// WebuiAssistantBody — the assistant message body, deferred from W3 tier 1
// because it directly renders <WebuiDiffCard>.
//
// W3 tier 2 lift: this component was moved verbatim out of `app.tsx`. The
// body is byte-identical to what used to live there; the lift is move-only.
// `app.tsx` keeps a thin re-export block so existing consumers (the shell
// and tests) keep their current import path during the W3 wave.

import { useState, type ReactElement } from "react";
import { WebuiMarkdown } from "../markdown.js";
import { parseWebuiMessageFileReference, type WebuiMessageFileReference } from "../projection/message-file-reference.js";
import { webuiActivitySummary } from "../projection/tool-projection.js";
import { MessageAttachments, type MessageAttachment } from "./MessageAttachments.js";
import type { WebuiTurnDiffView } from "../../shared/contracts/session.js";
import type {
  WebuiTranscriptProcessSegment,
  WebuiTranscriptActivityPart,
  WebuiTransport,
} from "../contracts.js";

/** Capability subset the assistant body passes through to its diff card.
 *  Single source of truth lives in `WebuiTransport`; this alias keeps the
 *  prop block free of per-key `WebuiTransport["x"]` redeclarations. */
type WebuiAssistantBodyCapabilities = Pick<
  WebuiTransport,
  "getTurnDiff" | "revertTurnDiff" | "reapplyTurnDiff"
>;
import { WebuiDiffCard } from "./DiffCard.js";
import {
  WebuiActivityGroup,
  type WebuiActivityGroupItem,
  WebuiThinkingBlock,
  WebuiTurnProcess,
} from "./TranscriptPrimitives.js";

interface WebuiTranscriptActivityEntry {
  readonly messageId: string;
  readonly part: WebuiTranscriptActivityPart;
}

interface RenderedWebuiTranscriptActivityRow {
  readonly messageId: string;
  readonly element: ReactElement;
}

function renderActivityParts(
  entries: readonly WebuiTranscriptActivityEntry[],
  streaming: boolean,
  authoritativeDiffAvailable: boolean,
  processExpanded: boolean,
  processingStartedAtMs?: number,
  onOpenFile?: (reference: WebuiMessageFileReference) => void,
  workspaceDir?: string,
  collapsedVisiblePart?: WebuiTranscriptActivityPart,
  collapseNestedThinking = false,
): RenderedWebuiTranscriptActivityRow[] {
  const rows: RenderedWebuiTranscriptActivityRow[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const { messageId, part } = entry;
    if (part.type === "text" && !processExpanded && part === collapsedVisiblePart) continue;
    if (part.type === "tool" || part.type === "thinking") {
      const activityItems: WebuiActivityGroupItem[] = [];
      let cursor = index;
      while (cursor < entries.length) {
        const next = entries[cursor]?.part;
        if (next?.type === "thinking") {
          const thoughtTexts = [next.text];
          let durationMs = next.durationMs;
          cursor += 1;
          while (entries[cursor]?.part.type === "thinking") {
            const thought = entries[cursor]?.part;
            if (thought?.type === "thinking") {
              thoughtTexts.push(thought.text);
              durationMs ??= thought.durationMs;
            }
            cursor += 1;
          }
          activityItems.push({ type: "thinking", text: thoughtTexts.join("\n\n"), ...(durationMs !== undefined ? { durationMs } : {}), ...(streaming ? { streaming: true } : {}) });
          continue;
        }
        if (next?.type === "tool") {
          activityItems.push({ type: "tool", tool: next.tool });
          cursor += 1;
          continue;
        }
        break;
      }
      const tools = activityItems.flatMap((item) => item.type === "tool" ? [item.tool] : []);
      const thoughts = activityItems.filter((item): item is Extract<WebuiActivityGroupItem, { type: "thinking" }> => item.type === "thinking");
      if (tools.length > 0 && thoughts.length > 0) {
        rows.push({ messageId, element: <WebuiActivityGroup key={`${messageId}-activity-${index}`} tools={tools} activityItems={activityItems} authoritativeDiffAvailable={authoritativeDiffAvailable} showStreamingStatus={false} initiallyExpanded /> });
      } else if (tools.length > 0) {
        rows.push({ messageId, element: <WebuiActivityGroup key={`${messageId}-tools-${index}`} tools={tools} authoritativeDiffAvailable={authoritativeDiffAvailable} /> });
      } else {
        thoughts.forEach((thought, thoughtIndex) => rows.push({ messageId, element: <WebuiThinkingBlock key={`${messageId}-thinking-${index}-${thoughtIndex}`} text={thought.text} durationMs={thought.durationMs} streaming={streaming} processingStartedAtMs={processingStartedAtMs} summaryLabel="思考 1 次" showDetailHeading showStreamingStatus={false} initiallyExpanded={!collapseNestedThinking} /> }));
      }
      index = cursor - 1;
    } else if (part.type === "text") {
      rows.push({ messageId, element: <div className="webui-assistant-answer" key={`${messageId}-ordered-text-${index}`} data-webui-message-kind="assistant"><WebuiMarkdown source={part.text} onOpenFile={onOpenFile} workspaceDir={workspaceDir} /></div> });
    } else if (part.type === "cognitive" || part.type === "compaction") {
      rows.push({ messageId, element: <WebuiThinkingBlock key={`${messageId}-${part.type}-${index}`} text={part.text} streaming={streaming} processingStartedAtMs={processingStartedAtMs} summaryLabel={part.type === "compaction" ? "上下文整理" : "思考过程"} showDetailHeading={part.type !== "compaction"} showStreamingStatus={false} initiallyExpanded={part.type === "cognitive"} /> });
    } else if (part.type === "delegation") {
      rows.push({ messageId, element: <div className="webui-agent-delegation" key={`${messageId}-delegation-${index}`} data-webui-agent-activity="delegation" data-active={streaming && index === entries.length - 1 ? "true" : undefined}><span className="webui-agent-delegation-summary"><span className="webui-agent-delegation-avatar" aria-hidden="true">{String(part.message.fromAgent ?? "Agent").slice(0, 1).toUpperCase()}</span><span className="webui-agent-activity-title">{`${String(part.message.fromAgent ?? "Agent")} 发给 ${String(part.message.toAgent ?? "Agent")}`}</span></span>{typeof part.message.content === "string" ? <WebuiMarkdown source={part.message.content} onOpenFile={onOpenFile} workspaceDir={workspaceDir} /> : null}</div> });
    } else if (part.type === "agent_joined") {
      const agents: Record<string, unknown>[] = [];
      while (entries[index]?.part.type === "agent_joined") {
        const joined = entries[index]?.part;
        if (joined?.type === "agent_joined") agents.push(joined.agent);
        index += 1;
      }
      index -= 1;
      rows.push({ messageId, element: <WebuiAgentJoinedGroup key={`${messageId}-joined-${index}`} agents={agents} /> });
    } else {
      rows.push({ messageId, element: <WebuiDeliveredAssets key={`${messageId}-assets-${index}`} assets={part.assets} workspaceDir={workspaceDir} onOpenFile={onOpenFile} /> });
    }
  }
  return rows;
}

function WebuiDeliveredAssets({ assets, workspaceDir, onOpenFile }: {
  readonly assets: readonly Record<string, unknown>[];
  readonly workspaceDir?: string;
  readonly onOpenFile?: (reference: WebuiMessageFileReference) => void;
}): ReactElement | null {
  if (assets.length === 0) return null;
  return <ul className="webui-delivered-assets" data-testid="delivered-assets-list">{assets.map((asset, index) => {
    const src = typeof asset.src === "string" ? asset.src : "";
    const name = String(asset.name ?? src.split(/[\\/]/u).at(-1) ?? "文件");
    const caption = typeof asset.caption === "string" && asset.caption !== name ? asset.caption : undefined;
    const reference = src ? parseWebuiMessageFileReference(src, workspaceDir) : undefined;
    const extension = name.split(".").at(-1)?.toLowerCase();
    const icon = ["svg", "png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension ?? "") ? "🖼️" : extension === "py" ? "🐍" : "📄";
    const label = <><span className="webui-delivered-asset-icon" aria-hidden="true">{icon}</span><span>{name}</span></>;
    return <li key={`${src}-${index}`} className="webui-delivered-asset" data-deleted={asset.deleted === true ? "true" : undefined}>{reference && onOpenFile ? <a className="webui-message-file-link" href={reference.path} title={reference.path} data-webui-file-reference={reference.path} onClick={(event) => { event.preventDefault(); onOpenFile(reference); }}>{label}</a> : <span>{label}</span>}{caption ? <span className="webui-delivered-asset-caption"> — {caption}</span> : null}{asset.deleted === true ? <span className="webui-delivered-asset-deleted">已删除</span> : null}</li>;
  })}</ul>;
}

function WebuiAgentJoinedGroup({
  agents,
}: {
  readonly agents: readonly Record<string, unknown>[];
}): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  if (agents.length === 0) return null;
  return (
    <section className="webui-agent-joined-group" data-webui-agent-activity="agent-joined-group">
      <button
        type="button"
        className="webui-agent-joined-toggle"
        aria-expanded={expanded}
        aria-label="分配任务"
        onClick={() => setExpanded((value) => !value)}
      >
        <span>分配任务</span>
        <span className={`webui-agent-joined-chevron${expanded ? "" : " is-collapsed"}`} aria-hidden="true">⌄</span>
      </button>
      <div className="webui-agent-joined-list" data-testid="agent-task-list" hidden={!expanded}>
        {agents.map((agent, index) => {
          const name = String(agent.agentName ?? agent.name ?? "Agent");
          const title = String(agent.title ?? name);
          return (
            <div
              className="webui-agent-joined-row"
              key={String(agent.sessionId ?? `${name}-${index}`)}
              data-testid="agent-task-row"
              data-webui-agent-task-session={typeof agent.sessionId === "string" ? agent.sessionId : undefined}
            >
              <span className="webui-agent-joined-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
              <span className="webui-agent-joined-name">@{name}</span>
              <span className="webui-agent-joined-title">{title}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function WebuiAssistantBody({
  messageId,
  sessionId,
  workspaceDir,
  assistantMessageId,
  turnId,
  changeSetId,
  initialDiff,
  getTurnDiff,
  revertTurnDiff,
  reapplyTurnDiff,
  onOpenFile,
  onOpenTurnReview,
  thinking,
  thinkingDurationMs,
  processingStartedAtMs,
  totalRequestDurationMs,
  totalOutputTokens,
  wallClockDurationMs,
  tools,
  answers,
  attachments,
  streaming = false,
  processSegments,
  processInitiallyExpanded,
  processForceExpanded,
}: {
  readonly messageId: string;
  readonly sessionId?: string;
  readonly workspaceDir?: string;
  readonly onOpenFile?: (reference: WebuiMessageFileReference) => void;
  readonly onOpenTurnReview?: (view: WebuiTurnDiffView, selectedPath?: string) => void;
  readonly assistantMessageId?: string;
  readonly turnId?: string;
  readonly changeSetId?: string;
  readonly initialDiff?: WebuiTurnDiffView;

  readonly thinking?: string;
  readonly thinkingDurationMs?: number;
  readonly processingStartedAtMs?: number;
  /** Sum of `usage.requestDurationMs` across the turn's assistant messages
   *  when the runtime reports it. Falls back to `wallClockDurationMs`. */
  readonly totalRequestDurationMs?: number;
  /** Sum of `usage.outputTokens` across the turn's assistant messages. */
  readonly totalOutputTokens?: number;
  /** Wall-clock duration computed from message timestamps inside the turn
   *  (oldest user → newest assistant). Used when the runtime doesn't emit
   *  a per-request duration. */
  readonly wallClockDurationMs?: number;
  readonly tools?: readonly Record<string, unknown>[];
  readonly answers: readonly string[];
  readonly attachments?: readonly MessageAttachment[];
  readonly streaming?: boolean;
  readonly processSegments?: readonly WebuiTranscriptProcessSegment[];
  readonly processInitiallyExpanded?: boolean;
  readonly processForceExpanded?: boolean;
} & WebuiAssistantBodyCapabilities): ReactElement {
  const segments = processSegments?.length
    ? processSegments
    : [
        {
          messageId,
          ...(thinking ? { thinking } : {}),
          ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
          ...(tools?.length ? { tools } : {}),
        } satisfies WebuiTranscriptProcessSegment,
      ];
  const processTextParts = segments.flatMap((segment) =>
    (segment.activityParts ?? []).filter(
      (part): part is Extract<WebuiTranscriptActivityPart, { type: "text" }> => part.type === "text",
    ),
  );
  const primaryAnswerPart = processTextParts[processTextParts.length - 1];
  // Desktop builds one activity disclosure for each run between assistant
  // replies. Keep each part's source message so rows can be returned to their
  // original segment, but group over the flattened sequence so a tool round
  // split across messageIds does not create a second disclosure.
  const orderedProcessEntries: WebuiTranscriptActivityEntry[] = segments.flatMap((segment) => {
    if (segment.activityParts?.length) return segment.activityParts.map((part) => ({ messageId: segment.messageId, part }));
    return [
      ...(segment.thinking?.trim()
        ? [{ messageId: segment.messageId, part: { type: "thinking", text: segment.thinking, ...(segment.thinkingDurationMs !== undefined ? { durationMs: segment.thinkingDurationMs } : {}) } satisfies WebuiTranscriptActivityPart }]
        : []),
      ...(segment.tools ?? []).map((tool) => ({ messageId: segment.messageId, part: { type: "tool", tool } satisfies WebuiTranscriptActivityPart })),
    ];
  });
  const processSummaryParts = [
    ...(() => {
      const count = orderedProcessEntries.filter((entry) => entry.part.type === "thinking").length;
      return count > 0 ? [`思考 ${count} 次`] : [];
    })(),
    ...(() => {
      const toolsInProcess = orderedProcessEntries.flatMap((entry) => entry.part.type === "tool" ? [entry.part.tool] : []);
      return toolsInProcess.length > 0 ? [webuiActivitySummary(toolsInProcess)] : [];
    })(),
  ];
  const hasExpandableProcessContent = Boolean(
    thinking?.trim() ||
    tools?.length ||
    processSegments?.some((segment) => segment.activityParts?.length),
  );
  const activityEntryCount = orderedProcessEntries.filter((entry) => entry.part.type !== "text").length;
  const hasMergedActivity = activityEntryCount > 1;
  const expandProcessByDefault = processInitiallyExpanded ?? (
    hasMergedActivity || orderedProcessEntries.filter((entry) => entry.part.type === "thinking").length === 1
  );
  const hasProcessDuration =
    typeof processingStartedAtMs === "number" ||
    typeof totalRequestDurationMs === "number" ||
    typeof wallClockDurationMs === "number";
  const renderProcessContent = (processExpanded: boolean) => {
    const renderedRows = renderActivityParts(
      orderedProcessEntries,
      streaming,
      Boolean(getTurnDiff),
      processExpanded,
      processingStartedAtMs,
      onOpenFile,
      workspaceDir,
      primaryAnswerPart,
      hasMergedActivity,
    );
    return (
      <div className="activity-group-content webui-turn-process-segments">
        {segments.map((segment, index) => <div key={`${segment.messageId}-${index}`} className="webui-turn-process-segment">
          {renderedRows.filter((row) => row.messageId === segment.messageId).map((row) => row.element)}
        </div>)}
      </div>
    );
  };
  return (
    <div
      className="webui-assistant-body text-sm space-y-4"
      data-webui-assistant-body={messageId}
    >
      {hasExpandableProcessContent || hasProcessDuration ? (
        <WebuiTurnProcess
          active={streaming}
          startedAtMs={processingStartedAtMs}
          {...(!streaming && totalRequestDurationMs !== undefined
            ? { endedAtMs: (processingStartedAtMs ?? 0) + totalRequestDurationMs }
            : {})}
          tokenCount={
            !streaming && typeof totalOutputTokens === "number"
              ? totalOutputTokens
              : answers.reduce((sum, answer) => sum + answer.length, 0)
          }
          requestDurationMs={totalRequestDurationMs}
          wallClockDurationMs={wallClockDurationMs}
          hasExpandableContent={hasExpandableProcessContent}
          summaryPrefix={processSummaryParts.join("，")}
          forceExpanded={processForceExpanded}
          initiallyExpanded={expandProcessByDefault}
          showLiveActivity={streaming && Boolean(thinking?.trim())}
          children={renderProcessContent}
          collapsedContent={(expanded) => !expanded && primaryAnswerPart
            ? <div className="mt-2 webui-assistant-answer" data-webui-message-kind="assistant"><WebuiMarkdown source={primaryAnswerPart.text} onOpenFile={onOpenFile} workspaceDir={workspaceDir} /></div>
            : null}
        />
      ) : null}
      {primaryAnswerPart && !hasExpandableProcessContent ? (
        <div className="webui-assistant-answer" data-webui-message-kind="assistant">
          <WebuiMarkdown source={primaryAnswerPart.text} onOpenFile={onOpenFile} workspaceDir={workspaceDir} />
        </div>
      ) : processTextParts.length > 0 ? null : answers.map((answer, index) => (
        <div
          key={`${messageId}-answer-${index}`}
          className="webui-assistant-answer"
          data-webui-message-kind="assistant"
        >
          <WebuiMarkdown source={answer} onOpenFile={onOpenFile} workspaceDir={workspaceDir} />
        </div>
      ))}
      {/* Desktop places the diff card after the assistant body so the
       * edited-files summary sits at the end of the message. */}
      <WebuiDiffCard
        sessionId={sessionId}
        assistantMessageId={assistantMessageId ?? messageId}
        turnId={turnId}
        changeSetId={changeSetId}
        initialView={initialDiff}
        getTurnDiff={getTurnDiff}
        revertTurnDiff={revertTurnDiff}
        reapplyTurnDiff={reapplyTurnDiff}
        onReview={onOpenTurnReview}
      />
      {attachments?.length ? (
        <MessageAttachments attachments={attachments} />
      ) : null}
    </div>
  );
}
