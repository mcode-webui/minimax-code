import { PinServiceError, type PinItem, type PinRef, type PinService } from "../../service/pin/index.js";
import { AppError } from "../errors.js";
import { publishBestEffort, type GlobalEventPublisher } from "../events.js";
import { toProjectDetail, toSessionInfoView } from "./wire.js";

export interface PinnedItemRef {
  readonly itemType: 1 | 2 | 3;
  readonly id: string;
}

/** Client-facing projection of the runtime-owned pin service. */
export class PinApplication {
  constructor(private readonly options: {
    readonly service: Pick<PinService, "getOrder" | "putOrder" | "pinSession">;
    readonly publishGlobalEvent: GlobalEventPublisher;
  }) {}

  async getOrder() {
    return { items: (await this.invoke(() => this.options.service.getOrder())).map(toPinnedItem) };
  }

  async putOrder(items: readonly PinnedItemRef[]) {
    return { items: (await this.invoke(() => this.options.service.putOrder(items.map(fromPinnedItem)))).map(toPinnedItem) };
  }

  async pinSession(input: { readonly sessionId: string; readonly pinned: boolean; readonly insertIndex?: number }) {
    const result = await this.invoke(() => this.options.service.pinSession(input.sessionId, input.pinned, input.insertIndex));
    publishBestEffort(this.options.publishGlobalEvent, {
      type: "session.pinned_updated",
      payload: { sessionId: input.sessionId, pinned: input.pinned, ...(result.item?.session?.agentName ? { agentName: result.item.session.agentName } : {}) },
    });
    return { success: true, ...(result.item ? { item: toPinnedItem(result.item) } : {}), items: result.items.map(toPinnedItem) };
  }

  private async invoke<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (!(error instanceof PinServiceError)) throw error;
      if (error.reason === "session-not-found") throw new AppError(404, "SESSION_NOT_FOUND", error.message);
      if (error.reason === "agent-not-found") throw new AppError(404, "AGENT_NOT_FOUND", error.message);
      throw new AppError(400, "INVALID_PINNED_ITEMS", error.message);
    }
  }
}

function fromPinnedItem(ref: PinnedItemRef): PinRef {
  if (ref.itemType === 1) return { type: "session", id: ref.id };
  if (ref.itemType === 2) return { type: "agent", id: ref.id };
  if (ref.itemType === 3) return { type: "project", id: ref.id };
  throw new PinServiceError("invalid-ref", `Unsupported pinned item type: ${String(ref.itemType)}`);
}

function toPinnedItem(item: PinItem) {
  const itemType = item.ref.type === "session" ? 1 : item.ref.type === "agent" ? 2 : 3;
  return {
    itemType,
    id: item.ref.id,
    ...(item.session ? { session: toSessionInfoView(item.session) } : {}),
    ...(item.project ? { desktopProject: toProjectDetail(item.project) } : {}),
    ...(item.agent ? { agent: {
      name: item.agent.agentName,
      ...(item.agent.displayName ? { displayName: item.agent.displayName } : {}),
      ...(item.agent.rootSessionId ? { rootSessionId: item.agent.rootSessionId } : {}),
      ...(item.agent.defaultWorkspaceDir ? { defaultWorkspaceDir: item.agent.defaultWorkspaceDir } : {}),
    } } : {}),
  };
}
