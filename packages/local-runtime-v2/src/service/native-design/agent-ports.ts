import { mkdir } from 'node:fs/promises';

import type { GlobalEvent } from '@mavis/shared/global-events';

import type {
  DisplayMessageRecord,
  InternalSessionCreateInput,
  ResumeSessionInput,
  SessionFrame,
  SessionRecord,
} from '../session-system/index.js';
import type { LocalConversationRuntimeConfig, ModelProviderModelEntry } from '../model-system/index.js';
import type { TurnService } from '../turn-system/index.js';
import { AgentTurnError, type AgentTurnPermissionAsk } from '../agent-turn/contracts.js';
import {
  createAgentTurnSession,
  resolveAgentTurnModel,
  resolveDefaultAgentTurnModel,
} from '../agent-turn/session-turn.js';
import { sessionModelFields } from '../agent-turn/model-selection.js';
import type { NativeDesignExecution } from '../../local/design-host-contract.js';

const NATIVE_DESIGN_PURPOSE = 'webui-design';
const NATIVE_DESIGN_AGENT = 'mavis';
const MAX_ROOT_HOPS = 16;

/** Everything the native Design Agent consumer needs from the Session/Turn owners. */
export interface NativeDesignAgentPortsOptions {
  readonly records: {
    createInternalSession(input: InternalSessionCreateInput): Promise<SessionRecord>;
  };
  readonly lifecycle: {
    mutateSession(
      sessionId: string,
      fields: ReturnType<typeof sessionModelFields> & {
        readonly effectiveModelContextWindow: null;
        readonly effectiveModelMaxOutputTokens: null;
      },
    ): Promise<unknown>;
  };
  readonly repository: {
    get(sessionId: string): Promise<
      | Pick<
          SessionRecord,
          | 'sessionId'
          | 'purpose'
          | 'visibility'
          | 'archived'
          | 'agentName'
          | 'parentSessionId'
          | 'workspaceDir'
          | 'effectiveModel'
          | 'effectiveModelVariant'
          | 'effectiveModelThinking'
        >
      | undefined
    >;
  };
  readonly turns: Pick<TurnService, 'steer' | 'abort'>;
  readonly stream: {
    resume(input: ResumeSessionInput): AsyncIterableIterator<SessionFrame>;
  };
  readonly messages: {
    listTurn(sessionId: string, turnId: string): Promise<readonly DisplayMessageRecord[]>;
    listRecent(
      sessionId: string,
      options: { readonly limit: number; readonly role?: string },
    ): Promise<readonly DisplayMessageRecord[]>;
  };
  readonly questionnaires: {
    getPending(input: {
      agentName: string;
      sessionId: string;
    }): Promise<import('@mavis/shared/questionnaire').AskQuestionnaireRequest | undefined>;
    reply(input: {
      agentName: string;
      requestId: string;
      answers: import('@mavis/shared/questionnaire').AskQuestionnaireReplyAnswer[];
      submittedAt: number;
    }): Promise<{ readonly ok: true; readonly injected?: boolean }>;
  };
  readonly permissions: {
    listPending(): Promise<readonly { readonly requestId: string; readonly sessionId: string }[]>;
    reply(input: {
      requestIds: readonly string[];
      decision: 'allowOnce' | 'deny';
    }): Promise<{ readonly processed: readonly string[] }>;
  };
  readonly eventBus: {
    subscribe(subscriber: { next(event: GlobalEvent): void }): () => void;
  };
  readonly logger: {
    warn(fields: Record<string, unknown>, message: string): void;
  };
  readonly modelConfig: () => LocalConversationRuntimeConfig;
  readonly models: { list(): Promise<readonly ModelProviderModelEntry[]> };
  readonly nowMs: () => number;
}

/**
 * Native Design owns its hidden `webui-design` sessions; the neutral turn seam
 * owns the post-policy lifecycle. No Plugin owner, Mini App purpose prefix,
 * manifest grant or Mini App gateway registration is involved.
 */
export function createNativeDesignAgentPorts(
  options: NativeDesignAgentPortsOptions,
  workspaceDir: string,
): NativeDesignExecution['agent'] {
  const turnOptions = {
    source: NATIVE_DESIGN_PURPOSE,
    repository: options.repository,
    turns: options.turns,
    stream: options.stream,
    messages: options.messages,
    questionnaires: options.questionnaires,
    logger: options.logger,
    modelConfig: options.modelConfig,
    nowMs: options.nowMs,
    createError: (code: string, message: string, retryable = false, reason?: string) =>
      new AgentTurnError(code, message, retryable, reason),
    isError: (error: unknown) => error instanceof AgentTurnError,
  };
  const turnSession = createAgentTurnSession(turnOptions);

  const requireOwned = async (sessionId: string) => {
    const record = await options.repository.get(sessionId);
    if (
      !record ||
      record.purpose !== NATIVE_DESIGN_PURPOSE ||
      record.visibility !== 'hidden' ||
      record.archived
    ) {
      throw new AgentTurnError(
        'REQUEST_NOT_FOUND',
        'Design execution session is not owned by native Design',
      );
    }
    return record;
  };
  const nativeRoot = async (sessionId: string): Promise<string | undefined> => {
    const visited = new Set<string>();
    let id: string | undefined = sessionId;
    while (id && visited.size < MAX_ROOT_HOPS && !visited.has(id)) {
      visited.add(id);
      const record = await options.repository.get(id);
      if (!record || record.archived) return undefined;
      if (record.purpose === NATIVE_DESIGN_PURPOSE && record.visibility === 'hidden') return id;
      id = record.parentSessionId ?? undefined;
    }
    return undefined;
  };
  const observePermissions = async <T>(
    sessionId: string,
    onEvent: ((event: import('../agent-turn/contracts.js').AgentTurnRunEvent) => void) | undefined,
    run: () => Promise<T>,
  ): Promise<T> => {
    let active = true;
    const pending = new Set<Promise<void>>();
    const unsubscribe = options.eventBus.subscribe({
      next(event) {
        if (event.type !== 'permission.ask' || !active) return;
        const ask = projectPermissionAsk(event.payload);
        const delivery = nativeRoot(ask.sessionId)
          .then((root) => {
            if (active && root === sessionId) {
              onEvent?.({ type: 'permission.requested', ...ask });
            }
          })
          .catch((error: unknown) => {
            options.logger.warn(
              { error: error instanceof Error ? error.message : String(error) },
              'Native Design permission routing failed',
            );
          });
        pending.add(delivery);
        void delivery.finally(() => pending.delete(delivery));
      },
    });
    try {
      return await run();
    } finally {
      await Promise.allSettled(pending);
      active = false;
      unsubscribe();
    }
  };

  return {
    async models() {
      const listed = (await options.models.list())
        .filter((entry) => entry.enabled)
        .map((entry) => ({
          providerId: entry.providerId,
          modelId: entry.modelId,
          displayName: entry.displayName,
        }));
      return {
        models: listed,
        default: (await resolveDefaultAgentTurnModel(turnOptions)).selection,
      };
    },
    async run(input, context = {}) {
      context.signal?.throwIfAborted();
      const model = input.model
        ? (await resolveAgentTurnModel(turnOptions, input.model)).selection
        : (await resolveDefaultAgentTurnModel(turnOptions)).selection;
      let sessionId = input.sessionId;
      if (sessionId) {
        await requireOwned(sessionId);
        await options.lifecycle.mutateSession(sessionId, {
          ...sessionModelFields(model),
          effectiveModelContextWindow: null,
          effectiveModelMaxOutputTokens: null,
        });
      } else {
        context.signal?.throwIfAborted();
        await mkdir(workspaceDir, { recursive: true });
        sessionId = (
          await options.records.createInternalSession({
            agentName: NATIVE_DESIGN_AGENT,
            sessionType: 'branch',
            sessionKind: 'conversation',
            visibility: 'hidden',
            purpose: NATIVE_DESIGN_PURPOSE,
            workspaceDir,
            isDefaultWorkspace: false,
            title: 'Design',
            ...sessionModelFields(model),
          })
        ).sessionId;
      }
      context.signal?.throwIfAborted();
      const ownedId = sessionId;
      return observePermissions(ownedId, context.onEvent, async () => {
        const result = await turnSession.run({
          sessionId: ownedId,
          text: input.text,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.onEvent ? { onEvent: context.onEvent } : {}),
          ...(input.capabilitySelection ? { capabilitySelection: input.capabilitySelection } : {}),
        });
        return { sessionId: ownedId, ...result };
      });
    },
    async reply(input) {
      const root = await nativeRoot(input.sessionId);
      if (!root) {
        throw new AgentTurnError(
          'REQUEST_NOT_FOUND',
          'Design permission session is not owned by native Design',
        );
      }
      const pending = await options.permissions.listPending();
      if (
        !pending.some(
          (entry) => entry.sessionId === input.sessionId && entry.requestId === input.requestId,
        )
      ) {
        throw new AgentTurnError('REQUEST_NOT_FOUND', 'Design permission request is not pending');
      }
      return options.permissions.reply({
        requestIds: [input.requestId],
        decision: input.decision,
      });
    },
    async answer(input, context = {}) {
      context.signal?.throwIfAborted();
      await requireOwned(input.sessionId);
      return observePermissions(input.sessionId, context.onEvent, async () => {
        const result = await turnSession.answer({
          sessionId: input.sessionId,
          requestId: input.requestId,
          answers: input.answers as import('@mavis/shared/questionnaire').AskQuestionnaireReplyAnswer[],
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.onEvent ? { onEvent: context.onEvent } : {}),
        });
        return { sessionId: input.sessionId, ...result };
      });
    },
  };
}

function projectPermissionAsk(
  payload: Extract<GlobalEvent, { type: 'permission.ask' }>['payload'],
): AgentTurnPermissionAsk {
  return {
    sessionId: payload.sessionId,
    requestId: payload.requestId,
    toolName: payload.toolName,
    reason: payload.reason,
    ...(payload.turnId ? { turnId: payload.turnId } : {}),
    ...(payload.toolInput === undefined ? {} : { toolInput: payload.toolInput }),
  };
}
