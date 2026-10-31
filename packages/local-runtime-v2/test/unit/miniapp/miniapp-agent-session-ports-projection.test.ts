import {
  MsgType,
  RespDataType,
  Role,
  RuntimeEventStatus,
  RuntimeEventType,
  ToolCallStatus,
} from '@mavis/agent-core/protocol';
import { describe, expect, it } from 'vitest';

import type { SessionFrame } from '../../../src/service/session-system/index.js';
import { createFrameProjector } from '../../../src/service/miniapp/agent/session-ports-projection.js';

const MODEL = { providerId: 'minimax', modelId: 'M3', thinking: { effort: 'high' } };

describe('createFrameProjector', () => {
  it('emits turn.started once for the running session status', () => {
    const projector = createFrameProjector('session-1', 'turn-1', MODEL);

    expect(projector.project(runtimeFrame(runningStatus()))).toEqual([
      { type: 'turn.started', sessionId: 'session-1', turnId: 'turn-1', model: MODEL },
    ]);
    expect(projector.project(runtimeFrame(runningStatus()))).toEqual([]);
  });

  it('maps assistant text chunks to text.delta and skips chunks without text', () => {
    const projector = createFrameProjector('session-1', 'turn-1', MODEL);

    expect(projector.project(chunkFrame({ msg_content: 'Hel' }))).toEqual([
      { type: 'text.delta', sessionId: 'session-1', turnId: 'turn-1', text: 'Hel' },
    ]);
    expect(projector.project(chunkFrame({ thinking_content: 'hmm' }))).toEqual([]);
    expect(projector.project(chunkFrame({ finish: true, finish_reason: 'stop' }))).toEqual([]);
    expect(projector.project(chunkFrame({ msg_content: 'echo', role: Role.User }))).toEqual([]);
  });

  it('maps a completed assistant message to message.committed', () => {
    const projector = createFrameProjector('session-1', 'turn-1', MODEL);

    expect(
      projector.project(messageFrame({ msg_content: 'final', msg_type: MsgType.AgentContent })),
    ).toEqual([
      { type: 'message.committed', sessionId: 'session-1', turnId: 'turn-1', text: 'final' },
    ]);
    expect(projector.project(messageFrame({ msg_content: '  ' }))).toEqual([]);
    expect(
      projector.project(messageFrame({ msg_content: '[Error] boom', finish_reason: 'error' })),
    ).toEqual([]);
    expect(
      projector.project(messageFrame({ msg_content: 'compacted', kind: 'compaction' })),
    ).toEqual([]);
  });

  it('maps tool lifecycle chunks to tool.started and tool.finished once per call', () => {
    const projector = createFrameProjector('session-1', 'turn-1', MODEL);

    expect(projector.project(toolChunk('call-1', 'read', ToolCallStatus.Preparing))).toEqual([]);
    expect(projector.project(toolChunk('call-1', 'read', ToolCallStatus.Start))).toEqual([
      { type: 'tool.started', sessionId: 'session-1', turnId: 'turn-1', name: 'read' },
    ]);
    expect(projector.project(toolChunk('call-1', 'read', ToolCallStatus.Failed))).toEqual([
      { type: 'tool.finished', sessionId: 'session-1', turnId: 'turn-1', name: 'read', ok: false },
    ]);
    // The completed message repeats the settled calls; they were already reported.
    expect(
      projector.project(
        messageFrame({
          msg_content: 'let me check',
          msg_type: MsgType.AgentToolCall,
          tool_calls: [toolCall('call-1', 'read', ToolCallStatus.Failed)],
        }),
      ),
    ).toEqual([
      { type: 'message.committed', sessionId: 'session-1', turnId: 'turn-1', text: 'let me check' },
    ]);
  });

  it('reports tool calls first seen on a completed message, even without text', () => {
    const projector = createFrameProjector('session-1', 'turn-1', MODEL);

    expect(
      projector.project(
        messageFrame({
          msg_content: '',
          msg_type: MsgType.AgentToolCall,
          tool_calls: [
            toolCall('call-1', 'bash', ToolCallStatus.Finished),
            toolCall('call-2', 'grep', ToolCallStatus.Start),
          ],
        }),
      ),
    ).toEqual([
      { type: 'tool.started', sessionId: 'session-1', turnId: 'turn-1', name: 'bash' },
      { type: 'tool.finished', sessionId: 'session-1', turnId: 'turn-1', name: 'bash', ok: true },
      { type: 'tool.started', sessionId: 'session-1', turnId: 'turn-1', name: 'grep' },
    ]);
  });

  it('resolves a tool result without a name from its started call', () => {
    const projector = createFrameProjector('session-1', 'turn-1', MODEL);
    projector.project(toolChunk('call-1', 'write', ToolCallStatus.Start));

    expect(projector.project(toolChunk('call-1', '', ToolCallStatus.Finished))).toEqual([
      { type: 'tool.finished', sessionId: 'session-1', turnId: 'turn-1', name: 'write', ok: true },
    ]);
    expect(projector.project(toolChunk('call-9', '', ToolCallStatus.Finished))).toEqual([]);
  });

  it('ignores malformed data, other turns and non-runtime frames', () => {
    const projector = createFrameProjector('session-1', 'turn-1', MODEL);

    expect(projector.project(runtimeFrame('{not json'))).toEqual([]);
    expect(projector.project(runtimeFrame(JSON.stringify([1, 2])))).toEqual([]);
    expect(
      projector.project(runtimeFrame(JSON.stringify({ type: RespDataType.AgentMessageChunk }))),
    ).toEqual([]);
    expect(
      projector.project(
        runtimeFrame(
          JSON.stringify({
            type: RespDataType.AgentMessageChunk,
            agent_message_chunk: { msg_id: 'm', role: Role.Assistant, tool_calls: 'x' },
          }),
        ),
      ),
    ).toEqual([]);
    expect(projector.project(runtimeFrame(null))).toEqual([]);
    expect(projector.project(chunkFrame({ msg_content: 'other' }, 'turn-0'))).toEqual([]);
    expect(projector.project({ ...runtimeFrame(runningStatus()), kind: 'session-status' })).toEqual(
      [],
    );
    expect(
      projector.project({ ...chunkFrame({ msg_content: 'x' }), kind: 'durable-message' }),
    ).toEqual([]);
  });
});

function runningStatus(): Record<string, unknown> {
  return {
    event_id: 'e1',
    session_id: 'session-1',
    turn_id: 'turn-1',
    type: RuntimeEventType.SESSION_STATUS,
    payload: { status: RuntimeEventStatus.RUNNING },
  };
}

function chunkFrame(chunk: Record<string, unknown>, turnId = 'turn-1'): SessionFrame {
  return runtimeFrame(
    JSON.stringify({
      type: RespDataType.AgentMessageChunk,
      agent_message_chunk: { msg_id: 'm1', role: Role.Assistant, turn_id: turnId, ...chunk },
    }),
    turnId,
  );
}

function messageFrame(message: Record<string, unknown>): SessionFrame {
  return runtimeFrame(
    JSON.stringify({
      type: RespDataType.AgentMessage,
      agent_message: { msg_id: 'm1', role: Role.Assistant, turn_id: 'turn-1', ...message },
    }),
  );
}

function toolChunk(id: string, name: string, status: ToolCallStatus): SessionFrame {
  return chunkFrame({ tool_calls: [toolCall(id, name, status)] });
}

function toolCall(id: string, name: string, status: ToolCallStatus): Record<string, unknown> {
  return { tool_call_id: id, tool_name: name, tool_call_status: status };
}

function runtimeFrame(data: unknown, turnId = 'turn-1'): SessionFrame {
  return {
    identity: 'runtime:e1',
    sessionId: 'session-1',
    turnId,
    kind: 'runtime-event',
    data,
    cursor: 'cursor-1',
    createdAtMs: 5,
  };
}
