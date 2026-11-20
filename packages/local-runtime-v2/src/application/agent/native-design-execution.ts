import { randomUUID } from 'node:crypto';
import type { NativeDesignExecution } from '../../local/design-host-contract.js';
import type { HostProcessConnectorGateway, ConnectorToolHandle } from '../../service/host-connector-system/index.js';

/** Native identity over the existing epoch-fenced, account-grant Connector gateway. */
export function createNativeDesignExecution(agent: NativeDesignExecution['agent'], gateway: HostProcessConnectorGateway, clientId = 'design'): NativeDesignExecution {
  let caller = { kind: 'native-client' as const, clientId, processGeneration: randomUUID() };
  gateway.registerNativeClient(caller);
  const handles = new Map<string, ConnectorToolHandle>();
  let listQueue: Promise<void> = Promise.resolve();
  let closed = false;
  const assertOpen = () => { if (closed) throw Object.assign(new Error('Native Design execution is closed'), { code: 'SERVICE_RESTARTED' }); };
  const codeOf = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return {
    agent,
    hostConnector: {
      async list(input = {}) {
        const run = listQueue.then(async () => {
          assertOpen();
          let inventory;
          try { inventory = await gateway.list({ providerAllowlist: 'all', caller, ...input }); }
          catch (error) {
            if (!['CONNECTOR_HOST_PROCESS_RELEASED', 'CONNECTOR_HOST_PROCESS_NOT_REGISTERED'].includes(codeOf(error))) throw error;
            gateway.releaseNativeClient(caller);
            handles.clear();
            caller = { kind: 'native-client', clientId, processGeneration: randomUUID() };
            gateway.registerNativeClient(caller);
            inventory = await gateway.list({ providerAllowlist: 'all', caller, ...input });
          }
          // The gateway reuses the same opaque handle for the same tool identity
          // and account, and republishes its grant on every inventory. Keep the
          // reference that already names that handle so an uploader, a
          // capability refresh or an adjacent node cannot invalidate it. Drop
          // references whose tool is no longer in the inventory; that is where
          // a revoked tool or an account/generation change becomes stale.
          const byHandle = new Map<ConnectorToolHandle, string>();
          for (const [reference, handle] of handles) {
            if (!byHandle.has(handle)) byHandle.set(handle, reference);
          }
          const next = new Map<string, ConnectorToolHandle>();
          const tools = inventory.tools.map((tool) => {
            const toolRef = byHandle.get(tool.handle) ?? randomUUID();
            next.set(toolRef, tool.handle);
            return { toolRef, name: tool.runtimeToolName, description: tool.description, inputSchema: JSON.parse(tool.inputSchemaJson) as unknown };
          });
          handles.clear();
          for (const [reference, handle] of next) handles.set(reference, handle);
          return {
            tools,
            providerFailures: inventory.providerFailures.map((failure) => ({
              provider: failure.provider,
              code: failure.code,
              ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
            })),
            partial: inventory.partial,
          };
        });
        listQueue = run.then(() => undefined, () => undefined);
        return run;
      },
      async call(toolRef, input, options = {}) {
        assertOpen();
        const handle = handles.get(toolRef);
        if (!handle) throw Object.assign(new Error('Design connector reference is stale; list tools again'), { code: 'TOOL_REF_STALE' });
        let result;
        try { result = await gateway.call({ handle, arguments: input, caller, hostRequest: { clientRequestId: randomUUID(), invocationId: randomUUID() }, ...options }); }
        catch (error) {
          const outcome = typeof error === 'object' && error !== null && 'outcome' in error ? error.outcome : undefined;
          const hostFenced = ['CONNECTOR_HOST_PROCESS_RELEASED', 'CONNECTOR_HOST_PROCESS_NOT_REGISTERED', 'CONNECTOR_PRINCIPAL_CHANGED'].includes(codeOf(error));
          const toolStale = codeOf(error) === 'CONNECTOR_TOOL_HANDLE_INVALID';
          if (hostFenced) handles.clear();
          else if (toolStale && outcome !== 'unknown_after_dispatch') handles.delete(toolRef);
          if (outcome === 'unknown_after_dispatch') throw Object.assign(new Error('Design Connector request was dispatched but its result could not be confirmed; inspect provider state before retrying', { cause: error }), { code: 'CONNECTOR_OUTCOME_UNKNOWN', outcome, ...(typeof error === 'object' && error !== null && 'invocationId' in error ? { invocationId: error.invocationId } : {}) });
          if ((hostFenced || toolStale) && outcome === 'not_dispatched') throw Object.assign(new Error('Design connector reference expired after an identity or inventory change; list again'), { code: 'TOOL_REF_STALE' });
          throw error;
        }
        if (result.isError) throw Object.assign(new Error(result.errorMessage || 'Design connector failed'), { code: result.errorCode || 'CONNECTOR_CALL_FAILED' });
        return { value: result.resultJson ? JSON.parse(result.resultJson) as unknown : result };
      },
    },
    async close() { if (closed) return; closed = true; handles.clear(); gateway.releaseNativeClient(caller); },
  };
}
