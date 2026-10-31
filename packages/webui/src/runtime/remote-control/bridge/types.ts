/**
 * Remote Control Desktop bridge — shared types.
 *
 * Contract sources (in priority order, see plan §12 / drift list):
 *   1. the remote_gateway_base IDL (WsEnvelope + ctrl payloads — wire authority)
 *   2. the remote-control desktop plan (v1.5, aligned to the IDL per
 *      rc-ws-protocol-desktop-doc-drift)
 *   3. the archon_biz RemoteControlService IDL
 */

/**
 * Generic-command route descriptor (additive, dual-channel). When present on
 * an envelope the router bypasses the 17-case switch and drives the call
 * through the generic executor instead. `path` is a concrete, complete
 * absolute path (including the API prefix like `/mavis/api` or
 * `/minimax-desktop/api/v1`, already URL-encoded, with any GET query
 * appended) produced by archon_biz — the desktop side does no template
 * filling and no base prefixing. Route allowlisting is the sole
 * responsibility of RGW Apollo (ops-controlled, hot-reload); the desktop
 * only enforces structural path-traversal guards.
 */
export interface WsRoute {
  kind: "http" | "http_stream";
  method: string;
  path: string;
  /**
   * Optional daemon-local headers stamped by the gateway from server-side
   * policy, for example common_config-backed file size caps. The desktop
   * router only forwards the small allowlist it understands.
   */
  headers?: Record<string, string | number | boolean>;
}

/**
 * WS JSON frame envelope. Field set follows IDL `remote_gateway_base.WsEnvelope`:
 * v / id / ts / event_id? / type / payload (JSON object on the wire) /
 * in_reply_to? / source? / trace_id?.
 */
export interface WsEnvelope {
  v: number;
  id: string;
  ts: number;
  type: string;
  payload?: Record<string, unknown>;
  /** Only on evt.* frames; monotonically increasing, assigned by gateway. */
  event_id?: number;
  /** Set on ack/err and cmd-triggered evt frames; value = originating cmd.id. */
  in_reply_to?: string;
  /** "desktop" | "gateway" — origin tag for cross-link debugging. */
  source?: string;
  /** Cross-component RC trace id; cmd-triggered replies/evt echo the cmd value. */
  trace_id?: string;
  /**
   * Generic-channel bypass — when set, the router's 17-case switch is
   * skipped and the call is executed via the generic executor. See
   * command-router.genericExecute / WsRoute.
   */
  route?: WsRoute;
}

/** Connection phase of the proxy facade (plan §8.1). */
export type RCPhase =
  | "idle" // not connected, no binding
  | "pairing" // pairing code issued, waiting for phone confirm
  | "connecting" // got binding+ticket, WS handshake in progress
  | "connected" // WS established
  | "reconnecting" // WS dropped, backoff retry in progress
  | "error" // failed (see last_error)
  | "unbound"; // after explicit unbind (local or server initiated)

/**
 * producer 身份 —— 多对多改造后的连接身份判据组成部分（方案 §4.5.1 / ADR-011 D12）。
 *
 * 为什么需要它：改造前连接身份 == `binding_id`，代表 binding 从 b1 轮换到 b2 就会
 * 停掉 WS 重建。多对多下同一个 producer 可以同时被多个 consumer 绑定，代表 binding
 * 只是「拿来签 ticket 的那一条」，它的轮换不代表被控端换了人，因此不能作为连接身份。
 * 新判据 = `user + producer identity + producer_generation`。
 */
export interface RcProducerIdentity {
  /** Desktop 端固定 'desktop'；预留给未来 cli 等 producer 类型（方案 §4.5.11）。 */
  producer_type: string;
  /** 本机稳定 device id（= desktop_device_id），不随解绑重置。 */
  producer_device_id: string;
}

/**
 * 连接身份完整判据。三元组任一项变化才允许「停旧连接 → 建新连接」；
 * 仅代表 binding 变化时只刷新凭据（走 connection.retryNow()）。
 */
export interface RcConnectionIdentity extends RcProducerIdentity {
  /** 绑定所属账号；账号切换必须重建连接。 */
  user_id: string | undefined;
  /**
   * 服务端下发的 producer 连接代次。缺省（旧服务端不返回）时按 undefined 处理，
   * 此时该维度不参与判定 —— 不能把「服务端没给」误判成「代次变了」而误断连。
   */
  producer_generation: number | undefined;
}

/** 连接身份比较结果，用于日志与分支决策（每个分支都要能从日志读出原因）。 */
export type RcIdentityChangeReason =
  | "user_changed"
  | "producer_type_changed"
  | "producer_device_changed"
  | "producer_generation_changed"
  | "unchanged";

export interface RCStatus {
  phase: RCPhase;
  binding_id?: number;
  /** Peer (phone) display name — not populated in wave 1. */
  display_name?: string;
  /** Present while phase=pairing. */
  pairing_code?: string;
  /** Remaining seconds of the pairing code while phase=pairing. */
  expires_in?: number;
  last_error?: { code: string; message: string };
  /**
   * main 侧请求代次（方案 §4.5.2 / ADR-011 D12）。renderer 在发起异步凭据请求前
   * 快照该值并随 IPC 回传，main 用它拒绝迟到的旧凭据。语义与 renderer 侧
   * `store/remote-control.ts` 的 `lifecycleEpoch` 对齐：只增不减，任何会让旧凭据
   * 失效的事件（账号切换/解绑/binding lost/lane 变化）都 +1。
   */
  request_epoch?: number;
  /** 当前连接身份中的 producer 代次，随状态推送给 renderer 便于对账。 */
  producer_generation?: number;
  /** 当前连接身份中的 producer 类型（Desktop 固定 'desktop'）。 */
  producer_type?: string;
  /**
   * 存在未确认的 producer 全删解绑请求时携带其 request_id（方案 §4.5.4）。
   * renderer 据此展示「待确认」中间态并做恢复重放。
   */
  pending_unbind_request_id?: string;
}

export interface RCConnectResult {
  phase: RCPhase;
  binding_id?: number;
  pairing_code?: string;
  expires_in?: number;
  /** Mirror of RCStatus.last_error so callers can surface a hint without a second IPC. */
  last_error?: { code: string; message: string };
}

export type Unsubscribe = () => void;

/**
 * Persisted local state (`<userData>/remote-control/state.json`).
 * Never contains tickets or JWTs (plan §10 hard constraint).
 */
export interface RcPersistedState {
  desktop_device_id: string;
  binding_id?: number;
  bound_user_id?: string;
  /**
   * 服务端下发的 producer 连接代次（方案 §4.5.1）。持久化是为了让重启后的第一次
   * 凭据推送能和重启前的代次比较 —— 否则每次冷启动都会被判成「代次变了」而重建连接。
   */
  producer_generation?: number;
  /** producer 类型，Desktop 固定 'desktop'；持久化用于跨重启的身份比较。 */
  producer_type?: string;
  /**
   * 未确认的 producer 全删解绑（方案 §4.5.4 / ADR-011 D12：request_id 持久化放 main
   * 进程，因为 renderer 刷新会丢）。存在该记录 == 解绑处于「待确认」中间态：
   * 本地绑定状态**不得**清除，恢复后必须用同一个 request_id 重放，靠服务端幂等收敛。
   */
  pending_unbind?: RcPendingUnbind;
}

/** 待确认解绑记录 —— 仅存路由信息，绝不含 ticket/JWT（方案 §10 硬约束）。 */
export interface RcPendingUnbind {
  /** 幂等键：同一次用户解绑意图的所有重试都复用它。 */
  request_id: string;
  /** 首次发起时间（unix ms），用于日志与超时观测。 */
  created_at_ms: number;
  /** 发起解绑的账号；账号切换后不得用新账号凭据重放旧账号的解绑（禁止冒认）。 */
  user_id?: string;
  /** 发起时的代表 binding_id，仅作日志定位用，不参与全删语义。 */
  binding_id?: number;
  /** 已尝试次数（含首次），用于日志定位「重放了几轮」。 */
  attempts: number;
}

/**
 * `GET /desktop/bindings` response body — IDL `archon_biz_base.RCBindingInfo`.
 * bound state carries a freshly signed one-shot ticket (60s) + endpoint.
 */
export interface RCBindingInfo {
  state?: "none" | "pairing" | "bound" | string;
  ticket?: string;
  endpoint?: string;
  bound_at_ms?: number;
  /** Only while state=pairing: pairing code expiry (unix ms). */
  expires_at_ms?: number;
  binding_id?: number;
  producer_generation?: number;
  consumer_count?: number;
  online_consumer_count?: number;
  last_disconnected_at_ms?: number;
  producer_version?: string;
}

/** `POST /pairing/code` response body — IDL `RCPairingCodeResp`. */
export interface RCPairingCodeResult {
  pairing_code: string;
  expires_in_s: number;
}

/**
 * Credentials consumed by the WS connection. Resolved fresh per attempt.
 *
 * The provider no longer queries `GET /desktop/bindings` itself (the main-process
 * token cannot sign the matrix gateway request — the renderer's axios owns
 * that pipeline), so it can only ever yield:
 *   - `bound`  — the renderer has pushed a fresh one-shot ticket bundle;
 *   - `stale`  — no usable ticket in hand (missing / expired / already
 *                consumed). The owner must ask the renderer to re-sign via
 *                the `rc:refresh-binding` reverse-IPC loop.
 * `none`/`pairing` are NOT credential states here — the renderer drives the
 * unbound decision through `rc:binding-lost` (see index.onRendererBindingLost).
 */
export type RcCredentials =
  { state: "bound"; bindingId: number; ticket: string; endpoint: string } | { state: "stale" };

export interface RcCredentialProvider {
  /**
   * Return the renderer-supplied one-shot ticket if fresh, else `stale`.
   * Never hits the network (the main process cannot sign `GET /desktop/bindings`).
   */
  getCredentials(): Promise<RcCredentials>;
}

/**
 * Minimal logger surface consumed by bridge modules; the host supplies the
 * concrete sink. Call sites MUST only
 * pass sanitized values (no ticket / JWT / raw device id — plan §10).
 */
export interface RcLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Host-neutral projection of one frontend-facing Global Event.
 *
 * The host adapter owns Thrift transport, frame decoding, and admission
 * against the shared frontend catalog. The bridge intentionally accepts a
 * structural event here so it does not depend on desktop contract packages.
 */
export interface RcGlobalEvent {
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export type RcSessionComposerMode = "default" | "goal" | "plan";

export interface RcSessionComposerModeChange {
  sessionId: string;
  mode: RcSessionComposerMode;
}

/** Opens one admitted Global Event subscription tied to the supplied signal. */
export type RcGlobalEventSource = (signal: AbortSignal) => AsyncIterable<RcGlobalEvent>;

/**
 * Downstream command handling injection point (wave 2: command-router.ts).
 * Wave 1 installs a NOT_IMPLEMENTED placeholder (see frame-codec err helper).
 */
export interface CommandRouterContext {
  /** Stable Remote Gateway connection_id from ctrl.hello. */
  streamScope?: string;
  /** Owned by one socket attempt; permanently aborted when that attempt ends. */
  signal?: AbortSignal;
  /** Stable across reconnects, replaced when the binding/producer owner changes. */
  commandScope?: string;
}

export interface CommandRouter {
  /**
   * Handle one inbound cmd.* envelope. Replies (ack/err/evt) are emitted
   * through `reply`; implementations must stamp in_reply_to = cmd.id.
   */
  handleCommand(
    cmd: WsEnvelope,
    reply: (frame: WsEnvelope) => void,
    context?: CommandRouterContext,
  ): Promise<void>;
}

/** Outcome of a raw/text outbound send (byte-level evt frames, wave 2). */
export type RcSendResult =
  | { ok: true }
  | { ok: false; reason: "not_connected" | "frame_too_large" | "send_failed"; sizeBytes?: number };

/**
 * Live outbound frame surface always targeting the CURRENT WS connection
 * (facade-owned). Command streams supply their original scope, which the
 * sender must reject after reconnect. Global notifications omit that scope.
 */
export interface RcFrameSender {
  isConnected(): boolean;
  sendFrame(frame: WsEnvelope, streamScope?: string): boolean;
  /**
   * Byte-level send: `text` must already be a complete envelope JSON string
   * (M3 — chunk payloads are template-spliced, never re-serialized).
   * `frameType` is only for size-cap audit logging.
   */
  sendFrameText(text: string, frameType: string, streamScope?: string): RcSendResult;
}

/** Stream-pump surface the command router drives (T3 implements). */
export interface RcStreamPump {
  /** Pump one opened daemon SSE response as evt frames for cmd `cmdId`. */
  start(input: {
    sessionId: string;
    cmdId: string;
    cmdType: string;
    response: Response;
    traceId?: string | undefined;
    streamScope?: string | undefined;
    signal?: AbortSignal | undefined;
  }): void;
  /** cmd.session.stop / abort cascade: end every active pump for one session. */
  abortSession(sessionId: string, cause: string, streamScope?: string): void;
  /** WS down: abort in-flight pumps, optionally isolated to one connection scope. */
  abortAll(cause: string, streamScope?: string): void;
  /** session_id → active send cmd.id, or a resume cmd.id (permission evt correlation). */
  getActiveCmdId(sessionId: string, streamScope?: string): string | undefined;
}

/** Reason strings for ctrl.disconnect_reason (IDL DisconnectCode names, snake_case). */
export type RcDisconnectReason =
  | "app_quit"
  | "server_shutdown"
  | "superseded"
  | "auth_expired"
  | "ticket_invalid"
  | "daemon_unavailable"
  | "server_initiated_unbind";

/** Why a reconnect was scheduled — surfaced on the reconnecting event so the
 * root cause is machine-consumable, not something you must reconstruct by
 * time-aligning free-text log lines (plan §7 observability gap). */
export type RcReconnectCause =
  | "credential_refresh" // GET /desktop/bindings ticket fetch threw (often 401 token_expired)
  | "invalid_endpoint" // endpoint from GET /desktop/bindings did not parse
  | "ws_create_failed" // wsFactory threw before a socket existed
  | "handshake_timeout" // socket opened but ctrl.hello never arrived
  | "idle_timeout" // 60s with no inbound frame → forced reconnect
  | "ws_closed" // gateway/network closed the socket (1006, server_shutdown, …)
  | "health_recovered"; // daemon health gate cleared → immediate re-attempt

/** Events surfaced from RcConnection to the facade. */
export type RcConnectionEvent =
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; connectionId: string }
  | { kind: "reconnecting"; attempt: number; delayMs: number; cause: RcReconnectCause }
  /**
   * No usable ticket in hand (credential provider returned `stale`). The WS
   * is NOT built; the owner must drive the `rc:refresh-binding` reverse-IPC
   * loop to have the renderer re-sign. The connection re-attempts on backoff
   * regardless, so a slow/absent renderer never wedges the retry loop.
   */
  | { kind: "need-credentials"; attempt: number; delayMs: number }
  /** Terminal for the current start(): no further automatic reconnect. */
  | {
      kind: "stopped";
      cause:
        | "requested" // stop() called by owner
        | "superseded" // another connection for the same binding took over
        | "credentials" // auth_expired / ticket_invalid — owner re-signs & retries
        | "server-unbind"; // server_initiated_unbind → owner clears binding
      reason?: string;
    }
  /**
   * ctrl.replay.overflow (IDL: empty payload) — the replay window was lost;
   * the owner must trigger a full snapshot refetch (wave 2: cmd.session.list).
   */
  | { kind: "replay-overflow" };
