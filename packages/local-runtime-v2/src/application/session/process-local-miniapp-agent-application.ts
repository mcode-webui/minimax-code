import type { MiniAppAgentCaller, MiniAppAgentGateway } from '../../service/miniapp/index.js';
import type { LocalRuntimeApplication } from './process-local-application-contract.js';

type ProcessLocalMiniAppAgentApplication = NonNullable<LocalRuntimeApplication['miniAppAgent']>;
type PageCaller = Parameters<ProcessLocalMiniAppAgentApplication['run']>[0]['caller'];

function toGatewayCaller(caller: PageCaller): MiniAppAgentCaller {
  return {
    pluginId: caller.pluginId,
    processGeneration: caller.runId,
    source: 'page',
    ...(caller.hostSessionId !== undefined ? { hostSessionId: caller.hostSessionId } : {}),
  };
}

/** Page-path entry: the Electron bridge supplies the trusted tab identity, the gateway enforces policy. */
export function createProcessLocalMiniAppAgentApplication(
  gateway: Pick<
    MiniAppAgentGateway,
    | 'run'
    | 'reply'
    | 'answer'
    | 'open'
    | 'panelOpened'
    | 'panelClosed'
    | 'models'
    | 'agents'
    | 'sessions'
    | 'session'
    | 'create'
  >,
): ProcessLocalMiniAppAgentApplication {
  return {
    run: ({ caller, text, sessionId, agent, model, signal, onEvent }) =>
      gateway.run(
        toGatewayCaller(caller),
        {
          text,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(agent !== undefined ? { agent } : {}),
          ...(model !== undefined ? { model } : {}),
        },
        { ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}) },
      ),
    models: ({ caller }) => gateway.models(toGatewayCaller(caller)),
    agents: ({ caller }) => gateway.agents(toGatewayCaller(caller)),
    sessions: ({ caller }) => gateway.sessions(toGatewayCaller(caller)),
    session: ({ caller, sessionId }) => gateway.session(toGatewayCaller(caller), { sessionId }),
    create: ({ caller, agent }) =>
      gateway.create(toGatewayCaller(caller), agent === undefined ? undefined : { agent }),
    reply: ({ caller, sessionId, requestId, decision }) =>
      gateway.reply(toGatewayCaller(caller), { sessionId, requestId, decision }),
    answer: ({ caller, sessionId, requestId, answers, model, signal, onEvent }) =>
      gateway.answer(
        toGatewayCaller(caller),
        { sessionId, requestId, answers, ...(model !== undefined ? { model } : {}) },
        { ...(signal ? { signal } : {}), ...(onEvent ? { onEvent } : {}) },
      ),
    open: ({ caller, sessionId }) => gateway.open(toGatewayCaller(caller), { sessionId }),
    panelOpened: async ({ sessionId, hostSessionId }) =>
      gateway.panelOpened({ sessionId, hostSessionId }),
    panelClosed: async ({ sessionId, hostSessionId }) =>
      gateway.panelClosed({ sessionId, hostSessionId }),
  };
}
