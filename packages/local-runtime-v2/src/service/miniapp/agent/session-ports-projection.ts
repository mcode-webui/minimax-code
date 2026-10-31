import {
  MsgType,
  RespDataType,
  Role,
  RuntimeEventStatus,
  RuntimeEventType,
  ToolCallStatus,
} from '@mavis/agent-core/protocol';

import type { SessionFrame } from '../../session-system/index.js';
import type { MiniAppAgentModelSelection, MiniAppAgentRunEvent } from './contracts.js';

export interface MiniAppAgentFrameProjector {
  /** Never throws; frames that carry nothing a Mini App needs project to `[]`. */
  project(frame: SessionFrame): MiniAppAgentRunEvent[];
}

interface ProjectorState {
  readonly sessionId: string;
  readonly turnId: string;
  readonly model: MiniAppAgentModelSelection;
  started: boolean;
  /** Tool calls reported as started, by `tool_call_id`; results may omit the name. */
  readonly tools: Map<string, { readonly name: string; finished: boolean }>;
}

/**
 * Projects one run's post-policy session frames onto the Mini App event vocabulary.
 * `turn.finished` is not produced here: the run emits it from its settled result.
 */
export function createFrameProjector(
  sessionId: string,
  turnId: string,
  model: MiniAppAgentModelSelection,
): MiniAppAgentFrameProjector {
  const state: ProjectorState = { sessionId, turnId, model, started: false, tools: new Map() };
  return {
    project(frame) {
      if (frame.kind !== 'runtime-event' || frame.turnId !== turnId) return [];
      try {
        return projectData(state, frame.data);
      } catch {
        return [];
      }
    },
  };
}

function projectData(state: ProjectorState, data: unknown): MiniAppAgentRunEvent[] {
  if (isRecord(data)) {
    if (state.started || !isRunningStatus(data)) return [];
    state.started = true;
    return [
      {
        type: 'turn.started',
        sessionId: state.sessionId,
        turnId: state.turnId,
        model: state.model,
      },
    ];
  }
  const response = parseStreamResponse(data);
  if (response?.type === RespDataType.AgentMessageChunk) {
    return projectMessage(state, response.agent_message_chunk, 'text.delta');
  }
  if (response?.type === RespDataType.AgentMessage) {
    return projectMessage(state, response.agent_message, 'message.committed');
  }
  return [];
}

/** Chunks stream text deltas; completed messages commit their text. Both carry tool calls. */
function projectMessage(
  state: ProjectorState,
  value: unknown,
  textType: 'text.delta' | 'message.committed',
): MiniAppAgentRunEvent[] {
  const message = assistantMessage(value);
  if (!message) return [];
  const text = typeof message.msg_content === 'string' ? message.msg_content : '';
  // Whitespace deltas are part of the reply; a whitespace-only message is not worth committing.
  const hasText = textType === 'text.delta' ? text.length > 0 : text.trim().length > 0;
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return [
    ...(hasText
      ? [{ type: textType, sessionId: state.sessionId, turnId: state.turnId, text }]
      : []),
    ...toolCalls.flatMap((call) => projectToolCall(state, call)),
  ];
}

/** Reports each call once as started and once as finished, whichever frame shows it first. */
function projectToolCall(state: ProjectorState, value: unknown): MiniAppAgentRunEvent[] {
  const call = readToolCall(value);
  if (!call) return [];
  const known = state.tools.get(call.id);
  const name = call.name ?? known?.name;
  if (!name) return [];
  const events: MiniAppAgentRunEvent[] = [];
  const tool = known ?? { name, finished: false };
  if (!known) {
    state.tools.set(call.id, tool);
    events.push({ type: 'tool.started', sessionId: state.sessionId, turnId: state.turnId, name });
  }
  if (call.done && !tool.finished) {
    tool.finished = true;
    events.push({
      type: 'tool.finished',
      sessionId: state.sessionId,
      turnId: state.turnId,
      name: tool.name,
      ok: call.ok,
    });
  }
  return events;
}

/** Argument-streaming stages (`Preparing` / `Prepared`) are not tool execution and are skipped. */
function readToolCall(
  value: unknown,
):
  | { readonly id: string; readonly name?: string; readonly done: boolean; readonly ok: boolean }
  | undefined {
  if (!isRecord(value) || typeof value.tool_call_id !== 'string') return undefined;
  const status = value.tool_call_status;
  if (
    status !== ToolCallStatus.Start &&
    status !== ToolCallStatus.Finished &&
    status !== ToolCallStatus.Failed
  ) {
    return undefined;
  }
  const name = typeof value.tool_name === 'string' && value.tool_name ? value.tool_name : undefined;
  return {
    id: value.tool_call_id,
    ...(name ? { name } : {}),
    done: status !== ToolCallStatus.Start,
    ok: status === ToolCallStatus.Finished,
  };
}

function isRunningStatus(event: Record<string, unknown>): boolean {
  return (
    event.type === RuntimeEventType.SESSION_STATUS &&
    isRecord(event.payload) &&
    event.payload.status === RuntimeEventStatus.RUNNING
  );
}

/** Stream responses reach the frame as the JSON `RespData` string written by the agent projection. */
function parseStreamResponse(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const response: unknown = JSON.parse(data);
    return isRecord(response) ? response : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Only the Agent's own reply counts: user echoes, system events, compaction/review cards and
 * terminal error bubbles (reported through `turn.finished`) are skipped.
 */
function assistantMessage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || value.role !== Role.Assistant || value.kind !== undefined) {
    return undefined;
  }
  return value.msg_type === MsgType.SystemEvent || value.finish_reason === 'error'
    ? undefined
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
