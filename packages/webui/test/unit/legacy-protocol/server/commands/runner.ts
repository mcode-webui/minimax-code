import { WEBUI_COMMAND_DESCRIPTORS, type WebuiCommandName } from "./descriptors.js";
import type { WebuiHarnessPort, WebuiModelEntry } from "../port.js";

export interface WebuiRunCommandRequest {
  readonly command: WebuiCommandName;
  readonly input?: string;
  readonly sessionId?: string;
  readonly agentName?: string;
  readonly workspaceDir?: string;
}

export type WebuiRunCommandResult =
  | { readonly handled: true; readonly output: string; readonly data?: unknown }
  | { readonly handled: true; readonly output?: undefined; readonly data: unknown };

export async function runWebuiCommand(
  port: Pick<
    WebuiHarnessPort,
    | "createSession"
    | "getSession"
    | "getAccountStatus"
    | "getSessionUsage"
    | "listModels"
    | "selectModel"
    | "requestCompaction"
  >,
  request: WebuiRunCommandRequest,
): Promise<WebuiRunCommandResult> {
  if (request.command === "help") {
    return {
      handled: true,
      data: Object.values(WEBUI_COMMAND_DESCRIPTORS),
      output: Object.values(WEBUI_COMMAND_DESCRIPTORS)
        .map(({ name, description }) => `/${name} — ${description}`)
        .join("\n"),
    };
  }
  if (request.command === "new") {
    if (!request.workspaceDir) throw new Error("workspaceDir is required for /new");
    const session = await port.createSession({
      name: request.agentName ?? "main",
      workspaceDir: request.workspaceDir,
    });
    return { handled: true, data: session, output: "New session created." };
  }
  if (!request.sessionId) throw new Error(`sessionId is required for /${request.command}`);
  if (request.command === "compact") {
    const result = await port.requestCompaction({
      name: request.agentName ?? "main",
      id: request.sessionId,
      reason: "ui_request",
      ...(request.input?.trim() ? { customInstructions: request.input.trim() } : {}),
    });
    if (result.success) return { handled: true, data: result, output: formatCompaction(result) };
    if (result.code === "NOTHING_TO_COMPACT" || result.code === "unchanged") {
      return { handled: true, output: "No compaction is needed for this conversation yet." };
    }
    throw runtimeRejected(result.code, result.error);
  }
  if (request.command === "status") {
    const [account, session] = await Promise.all([
      port.getAccountStatus({ sessionId: request.sessionId }),
      port.getSession({ id: request.sessionId }),
    ]);
    return {
      handled: true,
      data: { account, session },
      output: formatStatus(account, session.session ?? {}),
    };
  }
  if (request.command === "usage") {
    const usage = await port.getSessionUsage({ id: request.sessionId });
    return { handled: true, data: usage, output: formatUsage(usage) };
  }
  const models = await port.listModels({ sessionId: request.sessionId });
  if (!request.input?.trim()) {
    return { handled: true, data: models, output: formatModels(models) };
  }
  const selection = resolveModelSelection(models, request.input);
  const selected = await port.selectModel({ ...selection, sessionId: request.sessionId });
  if (!selected.success) throw new Error(`Runtime rejected model selection ${request.input}.`);
  return { handled: true, data: selected, output: `Model selected: ${formatModel(selection)}` };
}

function formatStatus(account: Record<string, unknown>, session: Record<string, unknown>): string {
  const model = session.model ?? account.model ?? "not selected";
  const workspace = session.workspaceDir ?? "unknown";
  return [`Model: ${String(model)}`, `Workspace: ${String(workspace)}`].join("\n");
}

function formatUsage(usage: Record<string, unknown>): string {
  return Object.entries(usage)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

function formatModels(models: readonly WebuiModelEntry[]): string {
  return models
    .map((model) => `${formatModel(model)}${model.selected ? " (selected)" : ""}`)
    .join("\n");
}

function formatModel(model: { readonly providerId: string; readonly modelId: string; readonly variant?: string }): string {
  return `${model.providerId}/${model.modelId}${model.variant ? `#${model.variant}` : ""}`;
}

function resolveModelSelection(models: readonly WebuiModelEntry[], input: string): WebuiModelEntry {
  const normalized = input.trim().toLowerCase();
  const [rawProviderId, modelAndVariant] = normalized.split("/");
  const providerId = rawProviderId ?? normalized;
  const [modelId, variant] = (modelAndVariant ?? providerId).split("#");
  const selected = models.find(
    (model) =>
      (model.providerId.toLowerCase() === (modelAndVariant ? providerId : "") &&
        model.modelId.toLowerCase() === modelId &&
        (variant === undefined || model.variant?.toLowerCase() === variant)) ||
      model.modelId.toLowerCase() === normalized,
  );
  return selected ?? {
    providerId,
    modelId: modelId ?? normalized,
    ...(variant ? { variant } : {}),
  };
}

function formatCompaction(result: Record<string, unknown>): string {
  return [
    "Compaction completed.",
    ...(result.messagesBefore !== undefined && result.messagesAfter !== undefined
      ? [`Messages: ${String(result.messagesBefore)} → ${String(result.messagesAfter)}`]
      : []),
    ...(result.tokensBefore !== undefined && result.tokensAfter !== undefined
      ? [`Tokens: ${String(result.tokensBefore)} → ${String(result.tokensAfter)}`]
      : []),
  ].join("\n");
}

function runtimeRejected(code: unknown, error: unknown): Error {
  const rejected = new Error(String(error ?? "Runtime rejected the compaction request."));
  Object.assign(rejected, { code });
  return rejected;
}
