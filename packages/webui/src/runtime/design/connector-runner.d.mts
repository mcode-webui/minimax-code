import type { NativeDesignExecution } from "@mavis/local-runtime-v2/process-local";

export interface ConnectorDiscovery {
  readonly status: string;
  readonly message?: string;
  readonly code?: string;
  readonly providerFailures: readonly {
    readonly provider: string;
    readonly code: string;
    readonly retryable?: boolean;
  }[];
  readonly partial: boolean;
}

export interface ConnectorRunner {
  available(): boolean;
  discover(force?: boolean): Promise<ConnectorDiscovery & { readonly tools: readonly Record<string, unknown>[] }>;
  listTools(force?: boolean): Promise<readonly Record<string, unknown>[]>;
  grantedToolNames(fresh?: boolean): Promise<{
    readonly names: readonly string[];
    readonly discovery: ConnectorDiscovery;
  }>;
}

export function createConnectorRunner(
  context: {
    readonly dataDir: string;
    readonly signal: AbortSignal;
    readonly hostConnector?: NativeDesignExecution["hostConnector"];
    readonly logger: {
      info(message: string, fields?: unknown): void;
      warn(message: string, fields?: unknown): void;
      error(message: string, fields?: unknown): void;
    };
  },
  options?: Readonly<Record<string, unknown>>,
): ConnectorRunner;
