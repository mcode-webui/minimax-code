import { FRAME_TYPES, makeFrame } from "./frame-codec.js";
import { createCommandRouter } from "./command-router.js";
import { PermissionUpstream } from "./permission-upstream.js";
import { RcConnection, type RcWebSocketFactory } from "./connection.js";
import { StreamPump } from "./stream-pump.js";
import type { AttachmentFetcher } from "./attachment-fetch.js";
import type {
  CommandRouter,
  RcConnectionEvent,
  RcCredentialProvider,
  RcDisconnectReason,
  RcFrameSender,
  RcGlobalEventSource,
  RcLogger,
  RcSessionComposerModeChange,
} from "./types.js";

export interface RcDataPlaneOptions {
  logger: RcLogger;
  clientVersion: string;
  isRuntimeHealthy: () => boolean;
  localRuntimeInvoke?: (request: Request) => Promise<Response>;
  globalEventSource?: RcGlobalEventSource;
  getRemoteControlFileContentMaxBytes?: () => number | undefined;
  attachmentFetcher?: AttachmentFetcher;
  onSessionComposerModeChange?: (change: RcSessionComposerModeChange) => void | Promise<void>;
  commandRouter?: CommandRouter;
  getWebSocketHeaders?: () => Record<string, string>;
  wsFactory?: RcWebSocketFactory;
}

/** Owns the socket, admitted command scopes and upstream subscriptions. No binding writes. */
export class RcDataPlane {
  private connection: RcConnection | null = null;
  private activeStreamScope: string | undefined;
  private readonly sender: RcFrameSender;
  private readonly router: CommandRouter | undefined;
  private readonly pump: StreamPump | undefined;
  private readonly upstream: PermissionUpstream | undefined;

  constructor(private readonly opts: RcDataPlaneOptions) {
    const acceptsScope = (scope?: string) =>
      scope === undefined || scope === this.activeStreamScope;
    this.sender = {
      isConnected: () => this.connection?.isConnected() ?? false,
      sendFrame: (frame, scope) =>
        acceptsScope(scope) && (this.connection?.sendFrame(frame) ?? false),
      sendFrameText: (text, frameType, scope) =>
        (acceptsScope(scope) ? this.connection?.sendFrameText(text, frameType) : undefined) ?? {
          ok: false,
          reason: "not_connected",
        },
    };
    if (opts.localRuntimeInvoke) {
      this.pump = new StreamPump({ sender: this.sender, logger: opts.logger });
      this.router = createCommandRouter({
        invoke: opts.localRuntimeInvoke,
        pump: this.pump,
        logger: opts.logger,
        ...(opts.getRemoteControlFileContentMaxBytes
          ? { getRemoteControlFileContentMaxBytes: opts.getRemoteControlFileContentMaxBytes }
          : {}),
        ...(opts.attachmentFetcher ? { attachments: opts.attachmentFetcher } : {}),
        ...(opts.onSessionComposerModeChange
          ? { onSessionComposerModeChange: opts.onSessionComposerModeChange }
          : {}),
      });
    } else this.router = opts.commandRouter;
    if (opts.globalEventSource)
      this.upstream = new PermissionUpstream({
        eventSource: opts.globalEventSource,
        sender: this.sender,
        getActiveCmdId: (sessionId) => this.pump?.getActiveCmdId(sessionId, this.activeStreamScope),
        logger: opts.logger,
      });
  }

  isActive(): boolean {
    return this.connection !== null;
  }
  retryNow(): void {
    this.connection?.retryNow();
  }
  restart(): void {
    this.connection?.start();
  }

  start(input: {
    credentials: RcCredentialProvider;
    commandScope: string;
    onEvent: (event: RcConnectionEvent) => void;
  }): void {
    this.stop("app_quit");
    const connection = new RcConnection({
      credentials: input.credentials,
      commandScope: input.commandScope,
      clientVersion: this.opts.clientVersion,
      isRuntimeHealthy: this.opts.isRuntimeHealthy,
      logger: this.opts.logger,
      ...(this.router ? { commandRouter: this.router } : {}),
      ...(this.opts.getWebSocketHeaders
        ? { getWebSocketHeaders: this.opts.getWebSocketHeaders }
        : {}),
      ...(this.opts.wsFactory ? { wsFactory: this.opts.wsFactory } : {}),
      onEvent: (event) => {
        if (this.connection !== connection) return;
        switch (event.kind) {
          case "connected":
            this.activeStreamScope = event.connectionId;
            this.upstream?.start();
            this.upstream?.onConnected();
            break;
          case "reconnecting":
          case "need-credentials":
            this.abortScope(`ws-${event.kind}`);
            break;
          case "stopped":
            this.abortScope("ws-stopped");
            this.upstream?.stop();
            if (event.cause === "superseded" || event.cause === "server-unbind")
              this.connection = null;
            break;
        }
        input.onEvent(event);
      },
    });
    this.connection = connection;
    connection.start();
  }

  stop(reason: RcDisconnectReason = "app_quit"): void {
    this.upstream?.stop();
    const connection = this.connection;
    connection?.stop(reason);
    if (this.connection === connection) this.connection = null;
    this.abortScope("owner-stopped");
  }

  publishSessionComposerMode(change: RcSessionComposerModeChange): boolean {
    if (!this.opts.localRuntimeInvoke && !this.opts.globalEventSource) return false;
    if (!this.sender.isConnected()) return false;
    return this.sender.sendFrame(
      makeFrame(FRAME_TYPES.EVT_SESSION_COMPOSER_MODE_CHANGED, {
        session_id: change.sessionId,
        mode: change.mode,
      }),
    );
  }

  private abortScope(cause: string): void {
    const scope = this.activeStreamScope;
    if (!scope) return;
    this.pump?.abortAll(cause, scope);
    if (this.activeStreamScope === scope) this.activeStreamScope = undefined;
  }
}
