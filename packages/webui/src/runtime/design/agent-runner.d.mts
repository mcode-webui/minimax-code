import type { NativeDesignExecution } from "@mavis/local-runtime-v2/process-local";
import type { DesignTask, DesignModel } from "../../shared/contracts/design.js";
export interface DesignExecutionContext {
  readonly dataDir: string;
  readonly signal: AbortSignal;
  readonly agent?: NativeDesignExecution["agent"];
  readonly hostConnector?: NativeDesignExecution["hostConnector"];
  readonly logger: { info(message: string, fields?: unknown): void; warn(message: string, fields?: unknown): void; error(message: string, fields?: unknown): void };
  readonly withPersistenceLock?: <T>(work: () => Promise<T>) => Promise<T>;
}
export interface ExtractedDesignRunner {
  modelCatalog(force?: boolean): Promise<{ items: DesignModel[]; defaultKey?: string }>;
  restore(allowedTaskIds?: readonly string[]): Promise<void>;
  connectorTools(options?: { fresh?: boolean }): Promise<{
    tools: readonly Record<string, unknown>[];
    discovery: Record<string, unknown>;
  }>;
  capabilities(mode: string, modelKey?: string | null): Record<string, unknown>;
  startRun(
    input: Record<string, unknown>,
    options?: { readonly defer?: boolean },
  ): Promise<DesignTask>;
  dispatchRun(id: string): void;
  get(id: string): DesignTask | null;
  listForPage(): readonly DesignTask[];
  cancelRun(id: string): Promise<DesignTask>;
  replyPermission(id: string, input: Record<string, unknown>): Promise<DesignTask>;
  answer(id: string, input: Record<string, unknown>): Promise<DesignTask>;
  understand(input: Record<string, unknown>): Promise<unknown>;
  transformImage(input: Record<string, unknown>): Promise<unknown>;
}
export function createAgentRunner(context: DesignExecutionContext): ExtractedDesignRunner;
