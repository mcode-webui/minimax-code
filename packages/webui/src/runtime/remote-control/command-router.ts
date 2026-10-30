// 桥的命令路由所调用的「本地运行时入口」。
//
// ## 为什么需要这个入口
//
// 桥自带一整套命令路由（`bridge/command-router.ts`）：17 条具名命令加一条通用 `cmd.route`
// 通道。每条命令都被翻译成一条 `/minimax-desktop/api/v1/...` 的 `Request`，再等一个 `Response`
// 回来。Desktop 里这个入口叫 `handleLocalRuntimeRequest`，住在 Electron 主进程里；本仓库没有
// 对应物 —— WebUI 的运行时是通过 `cliService` 调的，不是通过一个 fetch 形态的路由。
//
// 所以这里补上这个入口：把 Desktop 路由映射到 WebUI 运行时。`RcDataPlaneOptions.localRuntimeInvoke`
// 一旦存在，桥就自己装配 `StreamPump` 与 `createCommandRouter`（`bridge/data-plane.ts`），
// 不再需要外部传入 `commandRouter`。
//
// ## 边界
//
//   * 命令词汇、payload 形状、ack/err 信封由 bridge 拥有。这里不重新实现，只按桥的解析器
//     （`toSessionSummary`、`fetchPinnedSessionIds`、`workspaceList`、`rcCatalogModel`、
//     `ensureRcContinuationModel` 等）期望的形状喂响应体。
//   * 置顶、队列和会话等状态由运行时拥有，入口只转换请求与响应。
//   * 未知路径返回 404，并把 method/path/status 打进 `[rc.invoke]` 日志：真机跑一轮就能看出
//     手机实际要哪些路径，再补实现。
//
// ## 会话的帧
//
// Desktop 把这一轮的输出以 daemon SSE 的形式泵进 `evt.*` 帧；WebUI 运行时交出来的是已解码的
// 帧，其 `dataJson` 本身就是 SSE 的 `data:` 载荷，所以桥自己的 `StreamPump` 可以直接复用：
// 帧被重新写成 SSE 文本，泵按读 Desktop 的方式读它。
import { mapPermissionDecision, normalizePermissionResponses } from "./bridge/command-router.js";
import type { RcLogger } from "./bridge/types.js";
import type {
  WebuiHostRequest,
  WebuiRuntimeAttachment,
  WebuiRuntimeCliService,
} from "../harness/host-contract.js";

/** Desktop 生成的 API 前缀。 */
const DESKTOP_API_PREFIX = "/minimax-desktop/api/v1";
/** 旧版 Mavis API 前缀：桥在 Desktop 路由 404 时会回退到这里，同一套运行时能力。 */
const LEGACY_API_PREFIX = "/mavis/api";

/** 运行时没有的能力的 code。 */
const NOT_IMPLEMENTED = "NOT_IMPLEMENTED";

/** 本机唯一的 agent 名。 */
const DEFAULT_AGENT_NAME = "main";

/** 运行时的权限回复编号。 */
type RuntimePermissionReply = Parameters<
  WebuiRuntimeCliService["replyPermission"]
>[0]["reply"];

/**
 * 权限决策 → 运行时编号。
 *
 * 桥的 Desktop 批量回复编号（`toDesktopBatchPermissionDecision`）恰好与运行时一致：
 * allowOnce=0 / allowAlways=1 / deny=2。所以桥发过来的数字编号可以直接用，手机侧的原始
 * 形状（字符串决策）则先经桥自己的 `normalizePermissionResponses` / `mapPermissionDecision`
 * 归一化，再落到这张表上。
 */
const RUNTIME_PERMISSION_REPLY: Record<
  "allowOnce" | "allowAlways" | "deny",
  RuntimePermissionReply
> = {
  allowOnce: 0,
  allowAlways: 1,
  deny: 2,
};

/** 本运行时能设置的权限模式，取值同 `setPermissionMode`。 */
const PERMISSION_MODE_OPTIONS = [
  { value: "default", zh: ["主动询问", "需要权限时主动询问确认"], en: ["Ask for approval", "Ask for confirmation when permission is required"] },
  { value: "auto", zh: ["智能授权", "AI 判断操作安全性，仅高风险时询问"], en: ["Smart authorization", "AI evaluates risk, only asks on high-risk ops"] },
  { value: "bypassPermissions", zh: ["始终授权", "跳过所有权限检查，不再弹出授权确认"], en: ["Full access", "Skip all permission checks, no confirmation"] },
] as const;

export interface RemoteControlLocalRuntimeInvokeOptions {
  readonly cliService: WebuiRuntimeCliService;
  readonly logger: RcLogger;
  readonly browserPort?: Pick<import("../port.js").WebuiBrowserPort, "getAuthorization" | "setAuthorization">;
  /**
   * 无显式 agent 参数时使用的默认 agent 名。
   */
  readonly agentName?: string;
}

type RouteBody = Record<string, unknown>;

interface RouteContext {
  readonly method: string;
  /** 原始 pathname（含 API 前缀），用于日志。 */
  readonly pathname: string;
  /** 剥掉 API 前缀后的路径。 */
  readonly path: string;
  readonly url: URL;
  readonly body: RouteBody;
}

type RouteHandler = (ctx: RouteContext, match: RegExpExecArray) => Promise<Response>;

interface RouteEntry {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handle: RouteHandler;
}

/**
 * 桥的命令路由所调用的本地运行时入口。
 *
 * 入参是桥拼出来的 `Request`，出参是桥读得懂的 `Response`：命令词汇与手机侧形状由 bridge
 * 拥有，这里只负责把 Desktop 路由映射到 WebUI 运行时。
 */
export function createRemoteControlLocalRuntimeInvoke(
  options: RemoteControlLocalRuntimeInvokeOptions,
): (request: Request) => Promise<Response> {
  const cliService = options.cliService;
  const logger = options.logger;
  const agentName = options.agentName ?? DEFAULT_AGENT_NAME;

  /** `GET /agent/{agent}/session/tree` —— 手机侧的会话树。 */
  const sessionTree = async (ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const limit = readQueryNumber(ctx.url.searchParams.get("limit"));
    const cursor = readString(ctx.url.searchParams.get("cursor"));
    const page = await cliService.getSessionTree({
      name: decodeURIComponent(match[1] ?? ""),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    // Desktop 的 typed HTTP 响应使用 snake_case。
    return desktopViewResponse({
      sessions: page.sessions,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  };

  /** `GET /session/search?keyword=` —— 按关键字找会话。 */
  const sessionSearch = async (ctx: RouteContext): Promise<Response> => {
    const keyword = readString(ctx.url.searchParams.get("keyword"));
    const limit = readQueryNumber(ctx.url.searchParams.get("limit"));
    const cursor = readString(ctx.url.searchParams.get("cursor"));
    const page = await cliService.searchSessions({
      agentName: readString(ctx.url.searchParams.get("agent_name") ?? ctx.url.searchParams.get("agentName")) ?? agentName,
      ...(keyword !== undefined ? { keyword } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return desktopViewResponse({
      sessions: page.sessions,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  };

  /** `GET /preferences/pinned-items-order` —— 运行时拥有的置顶名册。 */
  const pinnedItemsOrderGet = async (): Promise<Response> =>
    desktopViewResponse(await cliService.getPinnedItemsOrder());

  /** `PUT /preferences/pinned-items-order` —— 调整置顶顺序。 */
  const pinnedItemsOrderPut = async (ctx: RouteContext): Promise<Response> => {
    const entries = ctx.body.items ?? [];
    if (!Array.isArray(entries)) return errorResponse(400, "INVALID_ARGUMENT", "items must be an array");
    const items: { itemType: 1 | 2 | 3; id: string }[] = [];
    for (const value of entries) {
      const entry = readRecord(value);
      const itemType = entry?.item_type ?? entry?.itemType;
      const id = readString(entry?.id);
      if ((itemType !== 1 && itemType !== 2 && itemType !== 3) || !id) {
        return errorResponse(400, "INVALID_ARGUMENT", "each item needs a valid item_type and id");
      }
      items.push({ itemType, id });
    }
    return desktopViewResponse(await cliService.putPinnedItemsOrder(items));
  };

  /** `GET /session/{id}/message` —— 一页会话记录。 */
  const sessionMessages = async (
    ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => {
    const limit = readQueryNumber(ctx.url.searchParams.get("limit"));
    const before = readString(ctx.url.searchParams.get("before"));
    const result = await cliService.getMessages({
      id: decodeURIComponent(match[1] ?? ""),
      ...(limit !== undefined ? { limit } : {}),
      ...(before !== undefined ? { before } : {}),
    });
    return jsonResponse(200, {
      messages: result.messages ?? [],
      ...(result.hasMore !== undefined ? { hasMore: result.hasMore } : {}),
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      ...(result.lastMsgId ? { lastMsgId: result.lastMsgId } : {}),
    });
  };

  /** `POST /session/{id}/message` —— 发消息，回一串 SSE 帧。 */
  const sessionMessage = async (
    ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => {
    const content = readString(ctx.body.content);
    const clientIntent = readString(ctx.body.client_intent ?? ctx.body.clientIntent);
    const attachments = toRuntimeAttachments(ctx.body.attachments);
    const model = toRuntimeModel(ctx.body.model);
    // 运行时认这一轮的 `model`，WebUI 的 host contract 只声明了 `id`/`content`/
    // `clientIntent`/`attachments`。多出来的字段由运行时自己消费，所以这里用一个更宽的
    // 局部类型把它带过去，而不是悄悄丢掉手机选定的模型。
    const sendRequest: {
      readonly id: string;
      readonly content?: string;
      readonly clientIntent?: string;
      readonly attachments?: WebuiRuntimeAttachment[];
      readonly model?: Record<string, unknown>;
    } = {
      id: decodeURIComponent(match[1] ?? ""),
      ...(content !== undefined ? { content } : {}),
      ...(clientIntent !== undefined ? { clientIntent } : {}),
      ...(attachments ? { attachments } : {}),
      ...(model ? { model } : {}),
    };
    const result = await cliService.sendMessage(sendRequest);
    if (!result.ok) return streamErrorResponse(result.status, result.body);
    return sseResponseFromFrames(result.source, () => undefined);
  };

  /** `POST /session/{id}/queue` —— 会话正忙时排队。 */
  const sessionQueue = async (
    ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => {
    const content = readString(ctx.body.content);
    if (content === undefined) {
      return errorResponse(400, "INVALID_ARGUMENT", "content is required");
    }
    const clientIntent = readString(ctx.body.client_intent ?? ctx.body.clientIntent);
    const attachments = toRuntimeAttachments(ctx.body.attachments);
    const model = toRuntimeModel(ctx.body.model);
    const result = await cliService.enqueueMessage({
      id: decodeURIComponent(match[1] ?? ""),
      content,
      ...(clientIntent !== undefined ? { clientIntent } : {}),
      ...(attachments ? { attachments } : {}),
      ...(model ? { model } : {}),
    });
    return desktopViewResponse({
      ...(result.itemId ? { itemId: result.itemId } : {}),
      ...(result.status ? { status: result.status } : {}),
      ...(result.position !== undefined ? { position: result.position } : {}),
    });
  };

  /** Desktop 的队列读取与删除使用同一运行时队列。 */
  const sessionQueueList = async (
    _ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => desktopViewResponse(await cliService.listQueueMessages({
    id: decodeURIComponent(match[1] ?? ""),
  }));

  const sessionQueueDelete = async (
    _ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => desktopViewResponse(await cliService.deleteQueueItem({
    id: decodeURIComponent(match[1] ?? ""),
    itemId: decodeURIComponent(match[2] ?? ""),
  }));

  const sessionQueueGet = async (_ctx: RouteContext, match: RegExpExecArray): Promise<Response> =>
    desktopViewResponse(await cliService.getQueueItem({ id: decodeURIComponent(match[1] ?? ""), itemId: decodeURIComponent(match[2] ?? "") }));

  const sessionQueueUpdate = async (ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const content = readString(ctx.body.content);
    const model = toRuntimeModel(ctx.body.model);
    if (ctx.body.model !== undefined && !model) return errorResponse(400, "INVALID_ARGUMENT", "model requires provider_id and model_id");
    const rawAttachments = ctx.body.attachments;
    if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) return errorResponse(400, "INVALID_ARGUMENT", "attachments must be an array");
    const attachments = Array.isArray(rawAttachments) && rawAttachments.length === 0 ? [] : toRuntimeAttachments(rawAttachments);
    const expiresAt = readNumber(ctx.body.expires_at ?? ctx.body.expiresAt);
    return desktopViewResponse(await cliService.updateQueueItem({
      id: decodeURIComponent(match[1] ?? ""), itemId: decodeURIComponent(match[2] ?? ""),
      ...(content !== undefined ? { content } : {}), ...(model !== undefined ? { model } : {}),
      ...(attachments !== undefined ? { attachments } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}),
    }));
  };

  const sessionQueueReorder = async (ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const itemIds = ctx.body.item_ids ?? ctx.body.itemIds;
    if (!Array.isArray(itemIds) || itemIds.some((item) => typeof item !== "string" || !item.trim())) return errorResponse(400, "INVALID_ARGUMENT", "item_ids must be an array of nonempty strings");
    return desktopViewResponse(await cliService.reorderQueue({ id: decodeURIComponent(match[1] ?? ""), itemIds }));
  };

  /** `POST /agent/{agent}/session` —— 新建会话。 */
  const sessionCreate = async (ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const workspaceDir = readString(ctx.body.workspace_dir ?? ctx.body.workspaceDir);
    const teamModeOff = readBoolean(ctx.body.team_mode_off ?? ctx.body.teamModeOff);
    const title = readString(ctx.body.title);
    const parentSessionId = readString(ctx.body.parent_session_id ?? ctx.body.parentSessionId);
    const visibility = readString(ctx.body.visibility);
    const purpose = readString(ctx.body.purpose);
    const projectId = readNumber(ctx.body.project_id ?? ctx.body.projectId);
    const model = toRuntimeModel(ctx.body.model);
    if (ctx.body.model !== undefined && !model) return errorResponse(400, "INVALID_ARGUMENT", "model requires provider_id and model_id");
    const location = readRecord(ctx.body.run_location ?? ctx.body.runLocation);
    const runLocation = location ? {
      ...(readString(location.mode) !== undefined ? { mode: readString(location.mode) } : {}),
      ...(readString(location.worktree_dir ?? location.worktreeDir) !== undefined ? { worktreeDir: readString(location.worktree_dir ?? location.worktreeDir) } : {}),
      ...(readString(location.branch) !== undefined ? { branch: readString(location.branch) } : {}),
      ...(readString(location.new_worktree_branch ?? location.newWorktreeBranch) !== undefined ? { newWorktreeBranch: readString(location.new_worktree_branch ?? location.newWorktreeBranch) } : {}),
      ...(readString(location.new_worktree_base ?? location.newWorktreeBase) !== undefined ? { newWorktreeBase: readString(location.new_worktree_base ?? location.newWorktreeBase) } : {}),
    } : undefined;
    const created = await cliService.createSession({
      name: decodeURIComponent(match[1] ?? ""),
      ...(workspaceDir !== undefined ? { workspaceDir } : {}),
      ...(teamModeOff !== undefined ? { teamModeOff } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
      ...(purpose !== undefined ? { purpose } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(runLocation !== undefined ? { runLocation } : {}),
    });
    return desktopViewResponse(created);
  };

  /** `GET /models/list` —— 可选模型。 */
  const modelsList = async (ctx: RouteContext): Promise<Response> => {
    const sessionId = readString(ctx.url.searchParams.get("session_id"));
    const models = await cliService.listModels(
      sessionId !== undefined ? { sessionId } : {},
    );
    return jsonResponse(200, { models });
  };

  /** `POST /models/select` —— 选模型。 */
  const modelsSelect = async (ctx: RouteContext): Promise<Response> => {
    const providerId = readString(ctx.body.provider_id ?? ctx.body.providerId);
    const modelId = readString(ctx.body.model_id ?? ctx.body.modelId);
    if (!providerId || !modelId) {
      return errorResponse(
        400,
        "INVALID_ARGUMENT",
        "provider_id and model_id are required",
      );
    }
    const variant = readString(ctx.body.variant);
    const contextLimit = readNumber(ctx.body.context_limit ?? ctx.body.contextLimit);
    const sessionId = readString(ctx.body.session_id ?? ctx.body.sessionId);
    const success = await cliService.selectModel({
      providerId,
      modelId,
      ...(variant !== undefined ? { variant } : {}),
      ...(contextLimit !== undefined ? { contextLimit } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    return jsonResponse(200, { success });
  };

  /** `POST /session/{id}/resume` —— 续上会话的流。 */
  const sessionResume = async (
    ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => {
    const afterMsgId = readString(ctx.body.after_msg_id ?? ctx.body.afterMsgId);
    const afterCursor = readString(ctx.body.after_cursor ?? ctx.body.afterCursor);
    const drainQueued = readBoolean(ctx.body.drain_queued ?? ctx.body.drainQueued);
    const result = await cliService.resumeSession({
      id: decodeURIComponent(match[1] ?? ""),
      ...(afterMsgId !== undefined ? { afterMsgId } : {}),
      ...(afterCursor !== undefined ? { afterCursor } : {}),
      ...(drainQueued !== undefined ? { drainQueued } : {}),
    });
    if (!result.ok) return streamErrorResponse(result.status, result.body);
    return sseResponseFromFrames(result.source, () => undefined);
  };

  /** `POST /session/{id}/abort` —— 停。 */
  const sessionAbort = async (
    ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => {
    const turnId = readString(ctx.body.turn_id ?? ctx.body.turnId);
    const reason = readString(ctx.body.reason);
    // 运行时认 `turnId` 与 `reason`：`user_stop` 会暂停目标与队列并触发用户停止的级联，
    // 而 WebUI 的 host contract 只声明了 `id`。丢掉 `reason` 会让手机的停止按钮与桌面端的
    // 停止按钮行为不同，所以这里用一个更宽的局部类型把两个字段带过去。
    const abortRequest: {
      readonly id: string;
      readonly turnId?: string;
      readonly reason?: string;
    } = {
      id: decodeURIComponent(match[1] ?? ""),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    const result = await cliService.abortSession(abortRequest);
    return jsonResponse(200, {
      ...(result.success !== undefined ? { success: result.success } : {}),
    });
  };

  /** `POST /pin/session` —— 置顶会话。 */
  const pinSession = async (ctx: RouteContext): Promise<Response> => {
    const sessionId = readString(ctx.body.session_id ?? ctx.body.sessionId);
    const pinned = readBoolean(ctx.body.pinned);
    if (!sessionId || pinned === undefined) return errorResponse(400, "INVALID_ARGUMENT", "session_id and pinned are required");
    const insertIndex = readNumber(ctx.body.insert_index ?? ctx.body.insertIndex);
    return desktopViewResponse(await cliService.pinSession({ sessionId, pinned, ...(insertIndex === undefined ? {} : { insertIndex }) }));
  };

  /** `POST /permission/batch-reply` —— 批量回复权限请求。 */
  const permissionBatchReply = async (ctx: RouteContext): Promise<Response> => {
    const groups = resolvePermissionGroups(ctx.body);
    if (!groups) {
      return errorResponse(
        400,
        "INVALID_ARGUMENT",
        "request_ids and a decision are required",
      );
    }
    const processed: string[] = [];
    const skipped: string[] = [];
    for (const [reply, requestIds] of groups) {
      for (const requestId of requestIds) {
        try {
          const result = await cliService.replyPermission({
            name: agentName,
            requestId,
            reply,
          });
          if (result.success === true || result.ok === true) {
            processed.push(requestId);
          } else {
            skipped.push(requestId);
          }
        } catch {
          skipped.push(requestId);
        }
      }
    }
    return jsonResponse(200, { processed, skipped });
  };

  const questionnairePending = async (ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const sessionId = readString(ctx.url.searchParams.get("session_id"));
    if (!sessionId) return errorResponse(400, "INVALID_ARGUMENT", "session_id is required");
    return desktopViewResponse(await cliService.getPendingQuestionnaire({ name: decodeURIComponent(match[1] ?? ""), sessionId }));
  };

  const questionnairePlanReview = async (_ctx: RouteContext, match: RegExpExecArray): Promise<Response> =>
    desktopViewResponse(await cliService.getLatestPlanReview({ name: decodeURIComponent(match[1] ?? ""), sessionId: decodeURIComponent(match[2] ?? "") }));

  const questionnaireReply = async (ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const schemaVersion = readNumber(ctx.body.schema_version ?? ctx.body.schemaVersion);
    const answers = ctx.body.answers;
    if (schemaVersion === undefined || !Array.isArray(answers)) return errorResponse(400, "INVALID_ARGUMENT", "schema_version and answers are required");
    const mapped: WebuiRuntimeCliService extends { replyQuestionnaire(request: infer R): unknown }
      ? R extends { answers: infer A } ? A : never : never = [];
    for (const value of answers) {
      const answer = readRecord(value);
      const stepId = readString(answer?.step_id ?? answer?.stepId);
      const selected = answer?.selected_option_ids ?? answer?.selectedOptionIds;
      if (!stepId || (selected !== undefined && (!Array.isArray(selected) || selected.some((item) => typeof item !== "string")))) {
        return errorResponse(400, "INVALID_ARGUMENT", "each answer needs a step_id and valid selected_option_ids");
      }
      const selectedOther = readBoolean(answer?.selected_other ?? answer?.selectedOther);
      const otherText = readString(answer?.other_text ?? answer?.otherText);
      const skipped = readBoolean(answer?.skipped);
      mapped.push({ stepId, ...(selected !== undefined ? { selectedOptionIds: selected as string[] } : {}), ...(selectedOther !== undefined ? { selectedOther } : {}), ...(otherText !== undefined ? { otherText } : {}), ...(skipped !== undefined ? { skipped } : {}) });
    }
    const submittedAt = readNumber(ctx.body.submitted_at ?? ctx.body.submittedAt);
    return desktopViewResponse(await cliService.replyQuestionnaire({ name: decodeURIComponent(match[1] ?? ""), requestId: decodeURIComponent(match[2] ?? ""), schemaVersion, answers: mapped, ...(submittedAt !== undefined ? { submittedAt } : {}) }));
  };

  const questionnaireDismiss = async (_ctx: RouteContext, match: RegExpExecArray): Promise<Response> =>
    desktopViewResponse(await cliService.dismissQuestionnaire({ name: decodeURIComponent(match[1] ?? ""), requestId: decodeURIComponent(match[2] ?? "") }));

  const pendingPermissions = async (): Promise<Response> =>
    desktopViewResponse(await cliService.listPendingPermissions({}));

  const sessionGoal = async (_ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const goal = await cliService.getGoal(decodeURIComponent(match[1] ?? ""));
    return goalResponse(goal);
  };

  const goalResponse = (goal: Awaited<ReturnType<WebuiRuntimeCliService["getGoal"]>>): Response => {
    if (!goal) return desktopViewResponse({});
    const { tokenBudget, statusReason, executionWait, objectiveResources, ...fields } = goal;
    return desktopViewResponse({ goal: {
      ...fields,
      objectiveResources: (objectiveResources ?? []).map((resource) => ({
        meta: { attachmentType: resource.type, fileName: resource.fileName, mimeType: resource.mimeType },
        local: { ...(resource.assetId !== undefined ? { assetId: resource.assetId } : {}), filePath: resource.filePath },
      })),
      ...(tokenBudget === null ? {} : { tokenBudget }),
      ...(statusReason === null ? {} : { statusReason }),
      ...(executionWait ? { execution: { waitReason: executionWait.reason, waitSince: executionWait.sinceMs } } : {}),
    } });
  };

  const sessionGoalCreate = async (ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const objective = readString(ctx.body.objective)?.trim();
    if (!objective) return errorResponse(400, "INVALID_ARGUMENT", "objective is required");
    const kickoff = toGoalAttachments(ctx.body.attachments);
    const resources = toGoalAttachments(ctx.body.objective_resources ?? ctx.body.objectiveResources);
    if (!kickoff.ok || !resources.ok) return errorResponse(400, "INVALID_ARGUMENT", "invalid goal attachments");
    const rawBudget = ctx.body.token_budget ?? ctx.body.tokenBudget;
    const budget = readNumber(rawBudget);
    if (rawBudget !== undefined && (budget === undefined || !Number.isSafeInteger(budget) || budget < 0)) return errorResponse(400, "INVALID_ARGUMENT", "token_budget must be a nonnegative integer");
    return goalResponse(await cliService.createGoal({ sessionId: decodeURIComponent(match[1] ?? ""), objective, ...(budget !== undefined && budget > 0 ? { tokenBudget: budget } : {}), ...(kickoff.items !== undefined ? { kickoffAttachments: kickoff.items } : {}), ...(resources.items !== undefined ? { objectiveResources: resources.items } : {}), requireKickoffAdmission: true }));
  };

  const sessionGoalPatch = async (ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const status = readString(ctx.body.status);
    if (status !== undefined && !["active", "paused", "blocked", "complete", "budget_limited", "usage_limited"].includes(status)) return errorResponse(400, "INVALID_ARGUMENT", "invalid goal status");
    const objective = readString(ctx.body.objective)?.trim();
    if (ctx.body.objective !== undefined && !objective) return errorResponse(400, "INVALID_ARGUMENT", "objective must not be empty");
    const resources = toGoalAttachments(ctx.body.objective_resources ?? ctx.body.objectiveResources);
    if (!resources.ok) return errorResponse(400, "INVALID_ARGUMENT", "invalid goal resources");
    if (resources.items !== undefined && objective === undefined) return errorResponse(400, "INVALID_ARGUMENT", "objective_resources requires objective");
    const rawBudget = ctx.body.token_budget ?? ctx.body.tokenBudget;
    const budget = readNumber(rawBudget);
    if (rawBudget !== undefined && (budget === undefined || !Number.isFinite(budget))) return errorResponse(400, "INVALID_ARGUMENT", "token_budget must be a number");
    const expectedId = readString(ctx.body.expected_goal_id ?? ctx.body.expectedGoalId);
    const expectedAtRaw = ctx.body.expected_updated_at ?? ctx.body.expectedUpdatedAt;
    const expectedAt = readNumber(expectedAtRaw);
    if ((expectedId === undefined) !== (expectedAtRaw === undefined) || (expectedAtRaw !== undefined && (expectedAt === undefined || !Number.isSafeInteger(expectedAt) || expectedAt < 0))) return errorResponse(400, "INVALID_ARGUMENT", "valid goal concurrency fields must be supplied together");
    if (status === undefined && objective === undefined && budget === undefined) return errorResponse(400, "INVALID_ARGUMENT", "goal patch is empty");
    return goalResponse(await cliService.patchGoal(decodeURIComponent(match[1] ?? ""), {
      ...(status !== undefined ? { status: status as NonNullable<Parameters<WebuiRuntimeCliService["patchGoal"]>[1]["status"]> } : {}),
      ...(objective !== undefined ? { objective } : {}),
      ...(budget !== undefined ? { tokenBudget: budget > 0 ? Math.floor(budget) : null } : {}),
      ...(resources.items !== undefined ? { objectiveResources: resources.items } : {}),
      ...(expectedId !== undefined ? { expectedGoalId: expectedId, rejectIfUpdatedAtChangedFrom: expectedAt } : {}),
    }));
  };

  const sessionGoalDelete = async (_ctx: RouteContext, match: RegExpExecArray): Promise<Response> => {
    const sessionId = decodeURIComponent(match[1] ?? "");
    if (!await cliService.getGoal(sessionId)) return jsonResponse(200, { success: true });
    return jsonResponse(200, { success: await cliService.clearGoal(sessionId) });
  };

  /**
   * `GET /projects` —— 项目分组，每个项目内嵌它自己的会话。
   *
   * 这是 Desktop 的 `ListProjectsResp`：手机侧的「最近」就是从每个 project 的
   * sessions 渲染出来的，所以只回 project 而不带 sessions，手机既看不到最近
   * 的会话，也找不到自己刚建的那个会话。运行时的分组投影（project + 会话树）
   * 就是 Desktop daemon 那份形状，直接透传。
   */
  const projectsList = async (ctx: RouteContext): Promise<Response> => {
    const listProjectGroups = cliService.listProjectGroups;
    if (!listProjectGroups) {
      return errorResponse(
        501,
        NOT_IMPLEMENTED,
        "this runtime cannot list projects with their sessions",
      );
    }
    const limit = readQueryNumber(ctx.url.searchParams.get("limit"));
    const cursor = readString(ctx.url.searchParams.get("cursor"));
    const sessionLimit = readQueryNumber(
      ctx.url.searchParams.get("session_limit") ?? ctx.url.searchParams.get("sessionLimit"),
    );
    const excludePurposePrefix = readString(
      ctx.url.searchParams.get("exclude_purpose_prefix"),
    );
    const includePurposePrefix = readString(
      ctx.url.searchParams.get("include_purpose_prefix"),
    );
    const includeHidden = readQueryBoolean(ctx.url.searchParams.get("include_hidden"));
    const includeArchived = readQueryBoolean(ctx.url.searchParams.get("include_archived"));
    const result = await listProjectGroups.call(cliService, {
      agentName,
      // Desktop 的项目列表口径：会话含隐藏项、排除内部树会话、归档只在请求
      // 显式要求时带上；隐藏的项目本身不返回。
      sessionFilter: {
        archived: includeArchived ? undefined : false,
        includeHidden: true,
        excludeInternalTreeSessions: true,
        ...(excludePurposePrefix === undefined
          ? {}
          : { excludePurposePrefix }),
        ...(includePurposePrefix === undefined
          ? {}
          : { includePurposePrefix }),
      },
      includeHiddenProjects: includeHidden === true,
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(sessionLimit === undefined ? {} : { sessionLimit }),
    });
    const groups = Array.isArray(result?.projects) ? result.projects : [];
    const sessionCount = groups.reduce(
      (total, group) => total + (Array.isArray(group?.sessions) ? group.sessions.length : 0),
      0,
    );
    logger.info(
      `[rc.invoke] GET /projects -> ${groups.length} projects, ${sessionCount} sessions`,
    );
    return desktopViewResponse(result);
  };

  const projectSessions = async (ctx: RouteContext): Promise<Response> => {
    const query = ctx.url.searchParams;
    const projectKey = readString(query.get("project_key") ?? query.get("projectKey"));
    const workspaceDir = readString(query.get("workspace_dir") ?? query.get("workspaceDir"));
    const rawId = query.get("project_id") ?? query.get("projectId");
    const projectId = readQueryNumber(rawId);
    if (rawId !== null && (projectId === undefined || !Number.isSafeInteger(projectId) || projectId <= 0)) return errorResponse(400, "INVALID_ARGUMENT", "invalid project_id");
    const limit = readQueryNumber(query.get("limit"));
    const cursor = readString(query.get("cursor"));
    const requestedAgent = readString(query.get("agent_name") ?? query.get("agentName"));
    const excludePurposePrefix = readString(query.get("exclude_purpose_prefix") ?? query.get("excludePurposePrefix"));
    const includePurposePrefix = readString(query.get("include_purpose_prefix") ?? query.get("includePurposePrefix"));
    if (!cliService.listProjectSessions) return errorResponse(501, NOT_IMPLEMENTED, "project sessions are not available");
    return desktopViewResponse(await cliService.listProjectSessions(
      { ...(projectKey !== undefined ? { projectKey } : {}), ...(projectId !== undefined ? { projectId } : {}), ...(workspaceDir !== undefined ? { workspaceDir } : {}) },
      { ...(requestedAgent !== undefined ? { agentName: requestedAgent } : {}), filter: { archived: false, includeHidden: true, excludeInternalTreeSessions: true, ...(excludePurposePrefix !== undefined ? { excludePurposePrefix } : {}), ...(includePurposePrefix !== undefined ? { includePurposePrefix } : {}) }, ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) },
    ));
  };

  /**
   * `GET /file/git/branches` 与 `GET /file/git/branch-picker` —— 工作区的分支。
   *
   * 手机在会话输入框里要先拿到分支表才让发消息，所以这两条是发送链路上的
   * 一环，不是一个可选的附加功能。运行时自己认得工作区的 git，入口只转发。
   */
  const gitBranches = async (ctx: RouteContext): Promise<Response> => {
    const workspace = readString(ctx.url.searchParams.get("workspace"));
    if (!workspace) {
      return errorResponse(400, "INVALID_ARGUMENT", "workspace is required");
    }
    const includeRemote = readQueryBoolean(ctx.url.searchParams.get("includeRemote"));
    const getBranches = cliService.getWorkspaceGitBranches;
    if (!getBranches) {
      return errorResponse(
        501,
        NOT_IMPLEMENTED,
        "this runtime cannot list workspace git branches",
      );
    }
    const result = await getBranches.call(
      cliService,
      workspace,
      includeRemote === true,
    );
    return jsonResponse(200, result);
  };

  const gitBranchPicker = async (ctx: RouteContext): Promise<Response> => {
    const workspace = readString(ctx.url.searchParams.get("workspace"));
    if (!workspace) {
      return errorResponse(400, "INVALID_ARGUMENT", "workspace is required");
    }
    const getBranchPicker = cliService.getWorkspaceGitBranchPicker;
    if (!getBranchPicker) {
      return errorResponse(
        501,
        NOT_IMPLEMENTED,
        "this runtime cannot list workspace worktrees",
      );
    }
    const result = await getBranchPicker.call(cliService, workspace);
    return jsonResponse(200, result);
  };

  const gitCheckout = async (ctx: RouteContext): Promise<Response> => {
    const workspace = readString(ctx.body.workspace);
    const branch = readString(ctx.body.branch);
    if (!workspace || !branch) return errorResponse(400, "INVALID_ARGUMENT", "workspace and branch are required");
    if (!cliService.checkoutWorkspaceGitBranch) return errorResponse(501, NOT_IMPLEMENTED, "workspace git checkout is not available");
    return jsonResponse(200, await cliService.checkoutWorkspaceGitBranch(workspace, branch));
  };

  const gitDefaultBranch = async (ctx: RouteContext): Promise<Response> => {
    const workspace = readString(ctx.url.searchParams.get("workspace"));
    if (!workspace) {
      return errorResponse(400, "INVALID_ARGUMENT", "workspace is required");
    }
    const getDefaultBranch = cliService.getWorkspaceGitDefaultBranch;
    if (!getDefaultBranch) {
      return errorResponse(
        501,
        NOT_IMPLEMENTED,
        "this runtime cannot resolve the default workspace branch",
      );
    }
    const result = await getDefaultBranch.call(cliService, workspace);
    return jsonResponse(200, result);
  };

  /**
   * `GET /file/git/metadata` 与 `GET /file/git/changes` —— 工作区的 git 现状。
   *
   * 运行时一次就能读出这两样，所以走同一个入口，不额外开能力。
   */
  const gitMetadata = async (ctx: RouteContext): Promise<Response> => {
    const workspace = readString(ctx.url.searchParams.get("workspace"));
    if (!workspace) {
      return errorResponse(400, "INVALID_ARGUMENT", "workspace is required");
    }
    const getEnvironment = cliService.getWorkspaceGitEnvironment;
    if (!getEnvironment) {
      return errorResponse(
        501,
        NOT_IMPLEMENTED,
        "this runtime cannot read the workspace git state",
      );
    }
    const environment = await getEnvironment.call(cliService, workspace);
    return jsonResponse(200, environment.metadata);
  };

  const gitChanges = async (ctx: RouteContext): Promise<Response> => {
    const workspace = readString(ctx.url.searchParams.get("workspace"));
    if (!workspace) {
      return errorResponse(400, "INVALID_ARGUMENT", "workspace is required");
    }
    const getEnvironment = cliService.getWorkspaceGitEnvironment;
    if (!getEnvironment) {
      return errorResponse(
        501,
        NOT_IMPLEMENTED,
        "this runtime cannot read the workspace git changes",
      );
    }
    const environment = await getEnvironment.call(cliService, workspace);
    return jsonResponse(200, environment.changes);
  };

  const gitProbe = async (ctx: RouteContext): Promise<Response> => {
    const workspace = readString(ctx.url.searchParams.get("workspace"));
    if (!workspace) {
      return errorResponse(400, "INVALID_ARGUMENT", "workspace is required");
    }
    const probe = cliService.getWorkspaceGitProbe;
    if (!probe) {
      return errorResponse(
        501,
        NOT_IMPLEMENTED,
        "this runtime cannot probe the workspace git state",
      );
    }
    return jsonResponse(200, await probe.call(cliService, workspace));
  };

  const gitWorktrees = async (ctx: RouteContext): Promise<Response> => {
    const workspace = readString(ctx.url.searchParams.get("workspace"));
    if (!workspace) {
      return errorResponse(400, "INVALID_ARGUMENT", "workspace is required");
    }
    const listWorktrees = cliService.getWorkspaceGitWorktrees;
    if (!listWorktrees) {
      return errorResponse(
        501,
        NOT_IMPLEMENTED,
        "this runtime cannot list the workspace worktrees",
      );
    }
    return jsonResponse(200, await listWorktrees.call(cliService, workspace));
  };

  /** `GET /session/{id}` —— 读会话。 */
  const sessionGet = async (
    _ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => {
    const result = await cliService.getSession({
      id: decodeURIComponent(match[1] ?? ""),
    });
    return desktopViewResponse(result);
  };

  /** `PATCH /session/{id}` —— 改会话标题。 */
  const sessionUpdate = async (
    ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => {
    const title = readString(ctx.body.title);
    const result = await cliService.updateSession({
      id: decodeURIComponent(match[1] ?? ""),
      ...(title !== undefined ? { title } : {}),
    });
    return desktopViewResponse(result);
  };

  /** `DELETE /session/{id}` —— 删会话。 */
  const sessionDelete = async (
    _ctx: RouteContext,
    match: RegExpExecArray,
  ): Promise<Response> => {
    const result = await cliService.deleteSession({
      id: decodeURIComponent(match[1] ?? ""),
    });
    return jsonResponse(200, {
      ...(result.success !== undefined ? { success: result.success } : {}),
    });
  };

  /** `GET /skills` —— 技能清单。 */
  const skillsList = async (ctx: RouteContext): Promise<Response> => {
    const keyword = readString(ctx.url.searchParams.get("keyword"));
    const limit = readQueryNumber(ctx.url.searchParams.get("limit"));
    const cursor = readString(ctx.url.searchParams.get("cursor"));
    const result = await cliService.listSkills({
      ...(keyword !== undefined ? { keyword } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return jsonResponse(200, result);
  };

  /** `GET /config` —— 配置（本运行时能给的只有权限模式）。 */
  const configGet = async (): Promise<Response> => {
    const permissionMode = await cliService.getPermissionMode();
    const browser = options.browserPort;
    const authorization = browser ? await browser.getAuthorization() : undefined;
    return jsonResponse(200, { permissionMode, beta: {
      filePanelBrowser: browser !== undefined,
      browserUseTooling: authorization?.isolatedChromium ?? false,
    } });
  };

  const configPut = async (ctx: RouteContext): Promise<Response> => {
    if (ctx.body.field !== "beta.browserUseTooling" || typeof ctx.body.set !== "boolean") {
      return errorResponse(501, NOT_IMPLEMENTED, "this config update is not supported");
    }
    if (!options.browserPort) return errorResponse(501, NOT_IMPLEMENTED, "browser control is not available");
    await options.browserPort.setAuthorization({ isolatedChromium: ctx.body.set });
    return configGet();
  };

  /** `GET /config/permission-mode-options` —— 权限模式的可选值。 */
  const configPermissionModeOptions = async (): Promise<Response> => {
    const locale = process.env.NEXT_PUBLIC_LOCALE || process.env.MAVIS_ELECTRON_LOCALE || Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG;
    const chinese = locale?.trim().toLowerCase().replace("_", "-").startsWith("zh") === true;
    return jsonResponse(200, {
      options: PERMISSION_MODE_OPTIONS.map(({ value, zh, en }) => {
        const [label_i18n, description_i18n] = chinese ? zh : en;
        return { value, label_i18n, description_i18n };
      }),
    });
  };

  const workspaceFileTree = async (ctx: RouteContext): Promise<Response> => {
    const workspaceDir = readString(ctx.url.searchParams.get("workspace"));
    if (!workspaceDir) return errorResponse(400, "INVALID_ARGUMENT", "workspace is required");
    if (["cursor", "limit", "include_hidden", "include_metadata", "includeHidden", "includeMetadata"].some((key) => ctx.url.searchParams.has(key))) {
      return errorResponse(501, NOT_IMPLEMENTED, "workspace file pagination and metadata are not supported");
    }
    if (!cliService.listWorkspaceFileTree) return errorResponse(501, NOT_IMPLEMENTED, "workspace file listing is not supported");
    const path = readString(ctx.url.searchParams.get("path"));
    const entries = await cliService.listWorkspaceFileTree({ workspaceDir, ...(path !== undefined ? { path } : {}) });
    return ctx.pathname.startsWith(LEGACY_API_PREFIX) ? jsonResponse(200, entries) : desktopViewResponse({ entries });
  };

  const workspaceFileSearch = async (ctx: RouteContext): Promise<Response> => {
    const workspaceDir = readString(ctx.url.searchParams.get("workspace"));
    const query = readString(ctx.url.searchParams.get("query"));
    if (!workspaceDir || query === undefined) return errorResponse(400, "INVALID_ARGUMENT", "workspace and query are required");
    if (ctx.url.searchParams.has("include_directories") || ctx.url.searchParams.has("includeDirectories")) return errorResponse(501, NOT_IMPLEMENTED, "directory search is not supported");
    if (!cliService.searchWorkspaceFiles) return errorResponse(501, NOT_IMPLEMENTED, "workspace file search is not supported");
    const limit = readQueryNumber(ctx.url.searchParams.get("limit")) ?? 100;
    const paths = await cliService.searchWorkspaceFiles({ workspaceDir, query, limit });
    return ctx.pathname.startsWith(LEGACY_API_PREFIX) ? jsonResponse(200, paths) : desktopViewResponse({ paths });
  };

  const routes: RouteEntry[] = [
    { method: "GET", pattern: /^\/agent\/([^/]+)\/session\/tree$/, handle: sessionTree },
    { method: "GET", pattern: /^\/session\/search$/, handle: sessionSearch },
    { method: "GET", pattern: /^\/preferences\/pinned-items-order$/, handle: pinnedItemsOrderGet },
    { method: "PUT", pattern: /^\/preferences\/pinned-items-order$/, handle: pinnedItemsOrderPut },
    { method: "GET", pattern: /^\/session\/([^/]+)\/message$/, handle: sessionMessages },
    { method: "POST", pattern: /^\/session\/([^/]+)\/message$/, handle: sessionMessage },
    { method: "POST", pattern: /^\/session\/([^/]+)\/queue$/, handle: sessionQueue },
    { method: "GET", pattern: /^\/session\/([^/]+)\/queue$/, handle: sessionQueueList },
    { method: "GET", pattern: /^\/session\/([^/]+)\/queue\/([^/]+)$/, handle: sessionQueueGet },
    { method: "PATCH", pattern: /^\/session\/([^/]+)\/queue\/([^/]+)$/, handle: sessionQueueUpdate },
    { method: "POST", pattern: /^\/session\/([^/]+)\/queue\/reorder$/, handle: sessionQueueReorder },
    { method: "DELETE", pattern: /^\/session\/([^/]+)\/queue\/([^/]+)$/, handle: sessionQueueDelete },
    { method: "POST", pattern: /^\/agent\/([^/]+)\/session$/, handle: sessionCreate },
    { method: "GET", pattern: /^\/models\/list$/, handle: modelsList },
    { method: "POST", pattern: /^\/models\/select$/, handle: modelsSelect },
    { method: "POST", pattern: /^\/session\/([^/]+)\/resume$/, handle: sessionResume },
    { method: "POST", pattern: /^\/session\/([^/]+)\/abort$/, handle: sessionAbort },
    { method: "POST", pattern: /^\/pin\/session$/, handle: pinSession },
    { method: "POST", pattern: /^\/permission\/batch-reply$/, handle: permissionBatchReply },
    { method: "GET", pattern: /^\/permission\/requests$/, handle: pendingPermissions },
    { method: "GET", pattern: /^\/agent\/([^/]+)\/questionnaire\/pending$/, handle: questionnairePending },
    { method: "POST", pattern: /^\/agent\/([^/]+)\/questionnaire\/([^/]+)\/reply$/, handle: questionnaireReply },
    { method: "POST", pattern: /^\/agent\/([^/]+)\/questionnaire\/([^/]+)\/dismiss$/, handle: questionnaireDismiss },
    { method: "GET", pattern: /^\/agent\/([^/]+)\/([^/]+)\/questionnaire\/plan-review$/, handle: questionnairePlanReview },
    { method: "GET", pattern: /^\/session\/([^/]+)\/goal$/, handle: sessionGoal },
    { method: "POST", pattern: /^\/session\/([^/]+)\/goal$/, handle: sessionGoalCreate },
    { method: "PATCH", pattern: /^\/session\/([^/]+)\/goal$/, handle: sessionGoalPatch },
    { method: "DELETE", pattern: /^\/session\/([^/]+)\/goal$/, handle: sessionGoalDelete },
    { method: "GET", pattern: /^\/projects$/, handle: projectsList },
    { method: "GET", pattern: /^\/project\/sessions$/, handle: projectSessions },
    // `search` 必须排在 `/{id}` 前面。
    { method: "GET", pattern: /^\/session\/([^/]+)$/, handle: sessionGet },
    { method: "PATCH", pattern: /^\/session\/([^/]+)$/, handle: sessionUpdate },
    { method: "DELETE", pattern: /^\/session\/([^/]+)$/, handle: sessionDelete },
    { method: "GET", pattern: /^\/skills$/, handle: skillsList },
    { method: "GET", pattern: /^\/config$/, handle: configGet },
    { method: "PUT", pattern: /^\/config$/, handle: configPut },
    { method: "GET", pattern: /^\/config\/permission-mode-options$/, handle: configPermissionModeOptions },
    { method: "GET", pattern: /^\/file\/tree$/, handle: workspaceFileTree },
    { method: "GET", pattern: /^\/file\/search$/, handle: workspaceFileSearch },
    { method: "GET", pattern: /^\/file\/git\/branches$/, handle: gitBranches },
    { method: "GET", pattern: /^\/file\/git\/branch-picker$/, handle: gitBranchPicker },
    { method: "POST", pattern: /^\/file\/git\/checkout$/, handle: gitCheckout },
    { method: "GET", pattern: /^\/file\/git\/default-branch$/, handle: gitDefaultBranch },
    { method: "GET", pattern: /^\/file\/git\/metadata$/, handle: gitMetadata },
    { method: "GET", pattern: /^\/file\/git\/changes$/, handle: gitChanges },
    { method: "GET", pattern: /^\/file\/git\/probe$/, handle: gitProbe },
    { method: "GET", pattern: /^\/file\/git\/worktrees$/, handle: gitWorktrees },
  ];

  const invoke = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;
    let response: Response;
    try {
      const path = stripApiPrefix(pathname);
      const ctx: RouteContext = {
        method,
        pathname,
        path: path ?? "",
        url,
        body: await readBody(request),
      };
      const matched = path === undefined ? undefined : matchRoute(routes, method, path);
      response = matched
        ? await matched.entry.handle(ctx, matched.match)
        : unknownRoute(ctx);
    } catch (error) {
      const message = errorMessage(error);
      const details = readRecord(error);
      const status = readNumber(details?.status);
      const key = readString(details?.key) ?? readString(details?.code);
      if (status !== undefined && status >= 400 && status <= 599 && key) {
        response = errorResponse(status, key, message);
      } else {
        logger.error(`[rc.invoke] method=${method} path=${pathname} status=500 error=${message}`);
        response = errorResponse(500, "INTERNAL_ERROR", message);
      }
    }
    logger.info(`[rc.invoke] method=${method} path=${pathname} status=${response.status}`);
    return response;
  };

  return invoke;
}

/** 剥掉 API 前缀；不是本运行时认识的 API 路径时返回 undefined。 */
function stripApiPrefix(pathname: string): string | undefined {
  if (pathname === DESKTOP_API_PREFIX) return "/";
  if (pathname.startsWith(`${DESKTOP_API_PREFIX}/`)) {
    return pathname.slice(DESKTOP_API_PREFIX.length);
  }
  if (pathname === LEGACY_API_PREFIX) return "/";
  if (pathname.startsWith(`${LEGACY_API_PREFIX}/`)) {
    return pathname.slice(LEGACY_API_PREFIX.length);
  }
  return undefined;
}

function matchRoute(
  routes: readonly RouteEntry[],
  method: string,
  path: string,
): { entry: RouteEntry; match: RegExpExecArray } | undefined {
  for (const entry of routes) {
    if (entry.method !== method) continue;
    const match = entry.pattern.exec(path);
    if (match) return { entry, match };
  }
  return undefined;
}

function unknownRoute(ctx: RouteContext): Response {
  return errorResponse(
    404,
    "NOT_FOUND",
    `no local runtime route for ${ctx.method} ${ctx.pathname}`,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Desktop 的 typed session/project 视图在 HTTP 上使用 snake_case 字段。 */
function desktopViewResponse(body: unknown): Response {
  return jsonResponse(200, desktopViewWire(body));
}

function desktopViewWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(desktopViewWire);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      desktopViewWire(item),
    ]),
  );
}

/** 错误体形状：`{key, message}` —— 桥的 `readErrorBody` 读 `key`/`code` 与 `error`/`message`。 */
function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { key: code, message });
}

/** 运行时自己的错误体：`{key, message, detail?}`。 */
function streamErrorResponse(
  status: number,
  body: { readonly key?: string; readonly message?: string; readonly detail?: string },
): Response {
  return jsonResponse(status, {
    ...(body.key ? { key: body.key } : {}),
    ...(body.message ? { message: body.message } : {}),
    ...(body.detail ? { detail: body.detail } : {}),
  });
}

async function readBody(request: Request): Promise<RouteBody> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {};
  }
  if (!text) return {};
  try {
    return readRecord(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A query parameter is a string; `readNumber`/`readBoolean` only read bodies. */
function readQueryNumber(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readQueryBoolean(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return undefined;
}

function toGoalAttachments(value: unknown): { ok: true; items?: NonNullable<WebuiHostRequest<"createGoal">["kickoffAttachments"]> } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (!Array.isArray(value)) return { ok: false };
  const items: NonNullable<WebuiHostRequest<"createGoal">["kickoffAttachments"]>[number][] = [];
  for (const raw of value) {
    const item = readRecord(raw);
    const meta = readRecord(item?.meta);
    const local = readRecord(item?.local);
    const dataUrl = readString(local?.data_url ?? local?.dataUrl);
    const assetId = readString(local?.asset_id ?? local?.assetId);
    const filePath = readString(local?.file_path ?? local?.filePath) ?? "";
    const desktopPath = readString(local?.desktop_path ?? local?.desktopPath);
    const sourcePath = assetId && filePath ? filePath : desktopPath ?? (dataUrl?.toLowerCase().startsWith("data:") ? "" : filePath);
    if (!sourcePath && !dataUrl) return { ok: false };
    items.push({ type: (meta?.attachment_type ?? meta?.attachmentType) === "image" ? "image" : "file", filePath: sourcePath, fileName: readString(meta?.file_name ?? meta?.fileName) ?? "", mimeType: readString(meta?.mime_type ?? meta?.mimeType) ?? "", ...(assetId ? { assetId } : {}), ...(dataUrl ? { dataUrl } : {}) });
  }
  return { ok: true, items };
}

function readRecord(value: unknown): RouteBody | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RouteBody)
    : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => readString(item))
    .filter((item): item is string => item !== undefined);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

/**
 * 权限批量回复的分组：运行时编号 → 请求号列表。
 *
 * 桥发过来的是 Desktop 编号（0/1/2），与运行时一致，直接用；手机侧的原始形状（字符串决策）
 * 则交给桥自己的两个映射函数归一化，这里只负责把 canonical decision 落到同一张编号表上。
 */
function resolvePermissionGroups(
  body: RouteBody,
): Map<RuntimePermissionReply, string[]> | undefined {
  const groups = new Map<RuntimePermissionReply, string[]>();
  const numeric = readNumber(body.decision);
  if (numeric !== undefined && isRuntimePermissionReply(numeric)) {
    const requestIds = readStringArray(body.request_ids ?? body.requestIds);
    if (requestIds.length === 0) return undefined;
    groups.set(numeric, requestIds);
    return groups;
  }
  const requestIds = readStringArray(body.request_ids ?? body.requestIds);
  if (requestIds.length > 0) {
    const canonical = mapPermissionDecision(body.decision, body.remember);
    const reply = canonical === undefined ? undefined : toRuntimePermissionReply(canonical);
    if (reply !== undefined) {
      groups.set(reply, requestIds);
      return groups;
    }
  }
  const normalized = normalizePermissionResponses(body);
  if (!normalized) return undefined;
  for (const [decision, ids] of normalized) {
    const reply = toRuntimePermissionReply(decision);
    if (reply === undefined) continue;
    groups.set(reply, [...(groups.get(reply) ?? []), ...ids]);
  }
  return groups.size > 0 ? groups : undefined;
}

/** canonical decision → 运行时编号。 */
function toRuntimePermissionReply(decision: string): RuntimePermissionReply | undefined {
  switch (decision) {
    case "allowOnce":
      return RUNTIME_PERMISSION_REPLY.allowOnce;
    case "allowAlways":
      return RUNTIME_PERMISSION_REPLY.allowAlways;
    case "deny":
      return RUNTIME_PERMISSION_REPLY.deny;
    default:
      return undefined;
  }
}

function isRuntimePermissionReply(value: number): value is RuntimePermissionReply {
  return value === 0 || value === 1 || value === 2;
}

/**
 * 桥的模型形状 → 运行时的模型选择。
 *
 * 桥发的是 Desktop 的 snake_case（`provider_id` / `model_id` / `context_limit`），运行时要的是
 * camelCase。provider 与 model 缺一不可，否则半截的模型选择没有意义。
 */
function toRuntimeModel(value: unknown) {
  const model = readRecord(value);
  if (!model) return undefined;
  const providerId = readString(model.provider_id ?? model.providerId);
  const modelId = readString(model.model_id ?? model.modelId);
  if (!providerId || !modelId) return undefined;
  const variant = readString(model.variant);
  const reasoning = readBoolean(model.reasoning);
  const contextLimit = readNumber(model.context_limit ?? model.contextLimit);
  const effort = readString(readRecord(model.thinking)?.effort);
  return {
    providerId,
    modelId,
    ...(variant !== undefined ? { variant } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(effort !== undefined ? { thinking: { effort } } : {}),
    ...(contextLimit !== undefined ? { contextLimit } : {}),
  };
}

/**
 * 桥的附件形状 → 运行时的附件形状。
 *
 * 桥的 Desktop 线是 snake_case（`meta.attachment_type` / `local.file_path`），运行时是
 * camelCase；旧版 Mavis 线是平铺的（`filePath` / `fileName` / `mimeType`），一并吃下。
 */
function toRuntimeAttachments(
  value: unknown,
): WebuiRuntimeAttachment[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const attachments: WebuiRuntimeAttachment[] = [];
  for (const item of value) {
    const entry = readRecord(item);
    if (!entry) continue;
    const meta = readRecord(entry.meta);
    const local = readRecord(entry.local);
    const attachmentType = readString(meta?.attachment_type ?? meta?.attachmentType);
    const fileName = readString(meta?.file_name ?? meta?.fileName ?? entry.fileName);
    const mimeType = readString(meta?.mime_type ?? meta?.mimeType ?? entry.mimeType);
    const sizeBytes = readNumber(meta?.size_bytes ?? meta?.sizeBytes);
    const filePath = readString(local?.file_path ?? local?.filePath ?? entry.filePath);
    const assetId = readString(local?.asset_id ?? local?.assetId);
    const dataUrl = readString(local?.data_url ?? local?.dataUrl ?? entry.dataUrl);
    attachments.push({
      ...(attachmentType !== undefined || fileName !== undefined || mimeType !== undefined || sizeBytes !== undefined
        ? {
            meta: {
              ...(attachmentType !== undefined ? { attachmentType } : {}),
              ...(fileName !== undefined ? { fileName } : {}),
              ...(mimeType !== undefined ? { mimeType } : {}),
              ...(sizeBytes !== undefined ? { sizeBytes } : {}),
            },
          }
        : {}),
      ...(filePath !== undefined || assetId !== undefined || dataUrl !== undefined
        ? {
            local: {
              ...(filePath !== undefined ? { filePath } : {}),
              ...(assetId !== undefined ? { assetId } : {}),
              ...(dataUrl !== undefined ? { dataUrl } : {}),
            },
          }
        : {}),
    });
  }
  return attachments.length > 0 ? attachments : undefined;
}

/** One frame of the runtime's session stream. */
interface RuntimeStreamFrame {
  readonly cursor?: string;
  readonly dataJson?: string;
  readonly eventJson?: string;
}

/**
 * The runtime's frames, written back as SSE text.
 *
 * The runtime's `dataJson` *is* the SSE `data:` payload — the runtime's own session delivery
 * writes the agent-core frame verbatim — so the bridge's pump reads it exactly as it reads the
 * Desktop's daemon stream. The cursor rides as the SSE `id:` line, which the pump keeps
 * pump-internal and never puts on the wire.
 */
function sseResponseFromFrames(
  frames: AsyncIterable<RuntimeStreamFrame> | Iterable<RuntimeStreamFrame>,
  onDone: () => void,
): Response {
  const encoder = new TextEncoder();
  const source: AsyncIterable<RuntimeStreamFrame> =
    Symbol.asyncIterator in frames
      ? frames
      : {
          async *[Symbol.asyncIterator]() {
            yield* frames;
          },
        };
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    onDone();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) {
        controller.close();
        return;
      }
      try {
        const step = await iterator.next();
        if (step.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(sseTextForFrame(step.value)));
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel() {
      finish();
      void iterator.return?.(undefined).then(
        () => undefined,
        () => undefined,
      );
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function sseTextForFrame(frame: RuntimeStreamFrame): string {
  const data = frame.dataJson ?? "";
  const lines: string[] = [];
  if (frame.cursor !== undefined) lines.push(`id: ${frame.cursor}`);
  if (frame.eventJson !== undefined) lines.push(`event: ${frame.eventJson}`);
  lines.push(`data: ${data}`);
  return `${lines.join("\n")}\n\n`;
}
