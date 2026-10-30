import type { MiniAppInspectDiagnostics } from '@mavis/agent-extension';

/** Largest `agentConcurrency` a Mini App manifest may declare. */
export const MINIAPP_AGENT_MAX_CONCURRENCY = 32;

/**
 * Session `purpose` label that marks a Mini App-owned session, followed by the plugin id.
 *
 * It lives here, with the rest of the Mini App policy constants, because the session boundary rejects
 * client-supplied `purpose` values starting with it and the turn owner reads it for approval lineage.
 */
export const MINIAPP_AGENT_PURPOSE_PREFIX = 'miniapp:';


/** Runs of one plugin at once when its manifest omits `agentConcurrency`. */
export const MINIAPP_AGENT_DEFAULT_CONCURRENCY = 4;

type MiniAppAgentCapability = 'session.run' | 'session.read';

/**
 * Derived from the parsed manifest's `agentAccess`; absent or empty means deny-all.
 * `maxConcurrent` is the manifest's `agentConcurrency` (runs of this plugin at once).
 */
export type MiniAppAgentPolicy =
  | { readonly kind: 'deny-all' }
  | {
      readonly kind: 'allowlist';
      readonly capabilities: readonly MiniAppAgentCapability[];
      readonly maxConcurrent: number;
    };

/** Every Mini App HTTP server answers this path from the guard, never from plugin code. */
export const MINIAPP_LOOPBACK_HEALTH_PATH = '/__mavis/health';

/** Request header carrying the Host-issued loopback credential. */
export const MINIAPP_LOOPBACK_TOKEN_HEADER = 'x-mavis-miniapp-token';

export type MiniAppHostConnectorPolicy =
  | { readonly kind: 'deny-all' }
  | { readonly kind: 'allowlist'; readonly providers: readonly string[] };

interface MiniAppCandidateBase {
  readonly pluginId: string;
  readonly packageRoot: string;
  readonly packageDigest: string;
  readonly clientDigest: string;
  readonly surfacePath: string;
}

export interface ProcessMiniAppCandidate extends MiniAppCandidateBase {
  readonly lifecycle: 'on-demand';
  readonly nodeDigest: string;
  readonly nodeEntry: string;
  readonly mcpEndpoints: readonly {
    readonly id: string;
    readonly path: string;
  }[];
  readonly hostConnectorPolicy: MiniAppHostConnectorPolicy;
  /** Optional so existing fixtures stay valid; missing is treated as deny-all. */
  readonly agentPolicy?: MiniAppAgentPolicy;
}

/** Process-only package contract consumed by the PluginSystem composition layer. */
export type MiniAppCandidate = ProcessMiniAppCandidate;

export interface MiniAppRuntimeExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly shutdownRequested: boolean;
}

export interface MiniAppHostConnectorQuiesceAttempt {
  readonly result: Promise<'drained' | 'busy'>;
  /** Re-opens admission after a non-destructive pre-PONR failure. */
  resume(): boolean;
  /** Irreversibly retires the drained Connector binding before root shutdown. */
  commit(): Promise<void>;
}

export interface MiniAppHostConnectorSession {
  startHandshake(): void;
  activate(): void;
  beginQuiesce(input: {
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
  }): MiniAppHostConnectorQuiesceAttempt;
  retire(): Promise<void>;
  close(): Promise<void>;
}

/** One message on the parent/child IPC channel; lifecycle frames carry their own `type`. */
export interface MiniAppIpcMessage {
  readonly type: 'miniapp:connector';
  readonly payload: unknown;
}

export interface MiniAppIpcTransport {
  readonly connected?: boolean;
  send(message: MiniAppIpcMessage, callback: (error: Error | null) => void): boolean;
  on(event: 'message' | 'disconnect' | 'error', listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface MiniAppHostConnectorSessionFactory {
  create(input: {
    readonly pluginId: string;
    readonly processGeneration: string;
    readonly providers: readonly string[];
    /** Missing is treated as deny-all; the child then receives no `agent` context. */
    readonly agentPolicy?: MiniAppAgentPolicy;
    /** The parent/child IPC channel, shared with lifecycle frames and told apart by `type`. */
    readonly transport: MiniAppIpcTransport;
    readonly onFatal: (error: Error) => void;
  }): MiniAppHostConnectorSession;
}

export interface MiniAppRuntimeLogEvent {
  readonly processGeneration: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly byteLength: number;
  readonly fieldKeys: readonly string[];
}

export interface MiniAppRuntimeLogEntry extends MiniAppRuntimeLogEvent {
  readonly sequence: number;
  readonly atMs: number;
  readonly miniAppGeneration: string;
}

export interface MiniAppNodeRuntime {
  readonly processGeneration: string;
  readonly nodeDigest: string;
  readonly port: number;
  readonly origin: string;
  /** Server-only: the proxy injects it. Never forwarded to a renderer or a published view. */
  readonly loopbackToken: string;
  readonly hostConnectorSession?: MiniAppHostConnectorSession;
  readonly closed: Promise<MiniAppRuntimeExit>;
  stop(): Promise<{ readonly proven: boolean }>;
}

export interface MiniAppNodeRuntimeFactory {
  /** Reads the renderer-safe owner label after the process guard proves another client is live. */
  ownerClient?(pluginId: string): Promise<string | undefined>;
  prepare(input: {
    readonly candidate: ProcessMiniAppCandidate;
    readonly processGeneration: string;
    readonly preferredPort?: number;
    readonly signal: AbortSignal;
    readonly onLog: (event: MiniAppRuntimeLogEvent) => void;
  }): Promise<MiniAppNodeRuntime>;
}

export interface MiniAppPersistedState {
  readonly pluginId: string;
  readonly acceptedSourceDigest: string;
  readonly clientDigest: string;
  readonly nodeDigest: string;
  readonly preferredPort?: number;
  readonly lastErrorJson?: string;
  readonly updatedAtMs: number;
}

export interface MiniAppStateStore {
  read(pluginId: string): MiniAppPersistedState | undefined;
  list(): readonly MiniAppPersistedState[];
  write(state: MiniAppPersistedState): void;
  remove(pluginId: string): void;
}

export interface MiniAppPublishedView {
  readonly pluginId: string;
  readonly miniAppGeneration: string;
  readonly packageRoot: string;
  readonly packageDigest: string;
  readonly clientDigest: string;
  readonly surfacePath: string;
  readonly nodeDigest: string;
  readonly processGeneration?: string;
  readonly lifecycle: 'on-demand';
  readonly origin?: string;
}

export interface MiniAppGenerationLease {
  release(): Promise<boolean>;
}

export interface PreparedMiniAppTransition {
  readonly candidate: MiniAppCandidate;
  readonly target: MiniAppPublishedView;
  readonly willPublishCold: boolean;
  commit(): Promise<MiniAppPublishedView>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface PreparedMiniAppDisableTransition {
  readonly pluginId: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface PreparedMiniAppStopTransition {
  readonly pluginId: string;
  readonly target: MiniAppPublishedView;
  commit(): Promise<MiniAppPublishedView>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface MiniAppPreparationOptions {
  /** Starts the direct Node root for an explicit open/publish/restart operation. */
  readonly forceStart?: boolean;
  readonly signal?: AbortSignal;
  /** Absolute wall-clock deadline for pre-PONR managed and Connector drain. */
  readonly deadlineMs?: number;
}

export interface MiniAppStopOptions {
  readonly signal?: AbortSignal;
  /** Absolute wall-clock deadline for pre-PONR managed and Connector drain. */
  readonly deadlineMs?: number;
}

export interface MiniAppStatus {
  readonly pluginId: string;
  readonly phase:
    | 'inactive'
    | 'cold'
    | 'starting'
    | 'active'
    | 'preparing'
    | 'disabled'
    | 'failed'
    | 'quarantined';
  readonly active?: MiniAppPublishedView;
  readonly retiringGenerationIds: readonly string[];
  readonly leaseCount: number;
  readonly failureCode?: string;
  readonly logs: readonly MiniAppRuntimeLogEntry[];
  readonly diagnostics?: MiniAppInspectDiagnostics;
}

interface MiniAppPublicationCoordinator {
  prepare(
    candidate: MiniAppCandidate,
    options?: MiniAppPreparationOptions,
  ): Promise<PreparedMiniAppTransition>;
  prepareDisable(pluginId: string): Promise<PreparedMiniAppDisableTransition>;
  prepareStop(
    pluginId: string,
    options?: MiniAppStopOptions,
  ): Promise<PreparedMiniAppStopTransition>;
  canReusePreparedPackage(input: {
    readonly pluginId: string;
    readonly packageDigest: string;
    readonly clientDigest: string;
    readonly nodeDigest: string;
  }): boolean;
  disable(pluginId: string): Promise<void>;
  stop(pluginId: string, options?: MiniAppStopOptions): Promise<void>;
}

export interface MiniAppSupervisor extends MiniAppPublicationCoordinator {
  ready(): Promise<void>;
  /** Synchronous, side-effect-free fence for an operation on a managed runtime endpoint. */
  assertCurrentRun(input: { readonly pluginId: string; readonly runId: string }): undefined;
  acquire(input: {
    readonly pluginId: string;
    readonly expectedMiniAppGeneration?: string;
    readonly expectedProcessGeneration?: string;
  }): Promise<MiniAppGenerationLease>;
  inspect(pluginId?: string): readonly MiniAppStatus[];
  /** The label recorded by a live external Mini App owner, when readable. */
  ownerClient?(pluginId: string): Promise<string | undefined>;
  /**
   * Server-only: the live generation's loopback credential, so the proxy that injects it has something
   * to inject. Never part of a published view and never forwarded to a renderer.
   */
  launchCredential(pluginId: string): string | undefined;
  close(): Promise<void>;
}

export interface MiniAppSupervisorOptions {
  readonly stateStore: MiniAppStateStore;
  readonly nodeRuntime: MiniAppNodeRuntimeFactory;
  /** Host logger used for best-effort startup failure records. */
  readonly logger?: { error(fields: Record<string, unknown>, message: string): void };
  readonly verifyCandidate: (candidate: MiniAppCandidate) => Promise<boolean>;
  readonly nowMs?: () => number;
  readonly makeMiniAppGeneration?: () => string;
  readonly makeProcessGeneration?: () => string;
  readonly makeLeaseId?: () => string;
  readonly closeTimeoutMs?: number;
  readonly logCapacity?: number;
  readonly idleTimeoutMs?: number;
  readonly scheduleIdle?: (delayMs: number, callback: () => void) => { cancel(): void };
}
