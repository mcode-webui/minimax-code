import type {
  AgentTurnCapabilitySelection,
  AgentTurnModelSelection,
  AgentTurnPermissionDecision,
  AgentTurnRunEvent,
  AgentTurnResult,
} from "../service/agent-turn/contracts.js";

/** Consumer-owned native Design capability; no Plugin or Mini App identity. */
export interface NativeDesignToolAdapter {
  readonly clientId?: string;
  readonly executionWorkspaceDir: string;
  execute(context: { readonly sessionId: string; readonly turnId: string; readonly signal?: AbortSignal }, input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface NativeDesignAgentInput {
  readonly text: string;
  readonly sessionId?: string;
  readonly model?: AgentTurnModelSelection;
  /** Server-enforced narrowing for this node execution; never widens the session profile. */
  readonly capabilitySelection?: AgentTurnCapabilitySelection;
}
export interface NativeDesignAgentOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentTurnRunEvent) => void;
}
export interface NativeDesignExecution {
  readonly agent: {
    models(): Promise<{ readonly models: readonly { readonly providerId: string; readonly modelId: string; readonly displayName: string }[]; readonly default: AgentTurnModelSelection }>;
    run(input: NativeDesignAgentInput, options?: NativeDesignAgentOptions): Promise<AgentTurnResult>;
    reply(input: { readonly sessionId: string; readonly requestId: string; readonly decision: AgentTurnPermissionDecision }): Promise<unknown>;
    answer(input: { readonly sessionId: string; readonly requestId: string; readonly answers: readonly unknown[] }, options?: NativeDesignAgentOptions): Promise<AgentTurnResult>;
  };
  readonly hostConnector: {
    list(input?: { readonly signal?: AbortSignal }): Promise<{
      readonly tools: readonly { readonly toolRef: string; readonly name: string; readonly description?: string; readonly inputSchema: unknown }[];
      readonly providerFailures: readonly { readonly provider: string; readonly code: string; readonly retryable?: boolean }[];
      readonly partial: boolean;
    }>;
    call(toolRef: string, input: Readonly<Record<string, unknown>>, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
  };
  close(): Promise<void>;
}
