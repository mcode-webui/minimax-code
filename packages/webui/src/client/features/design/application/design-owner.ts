import type {
  DesignAction,
  DesignDraftEdit,
  DesignDocument,
  DesignOpenIntent,
  DesignState,
  GetDesignStateRequest,
} from "../../../../shared/contracts/design.js";
import type { DesignPort } from "../contracts/design-port.js";
import { createWebuiSnapshotStore } from "../../../application/snapshot-store.js";
import type { WebuiVersionInfo } from "../../../../shared/contracts/version.js";
import {
  designPlaceProducts,
  designMediaGeometry,
  type DesignProductPlacement,
} from "../projection/design-view.js";

export interface DesignSnapshot {
  readonly status: "idle" | "loading" | "ready" | "unavailable" | "error";
  readonly data?: DesignState;
  readonly sessionId?: string;
  readonly documentId?: string;
  readonly busy: boolean;
  readonly activity?: "content" | "view" | "operation";
  readonly error?: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly historyResetReason?: string;
  readonly runtimeVersion?: WebuiVersionInfo;
  readonly versionError?: string;
  readonly intent?: DesignOpenIntent;
}

export interface DesignOwner {
  readonly getSnapshot: () => DesignSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: (request?: GetDesignStateRequest) => Promise<void>;
  readonly act: (action: DesignAction) => Promise<DesignState | undefined>;
  readonly registerPendingEdit: (
    flush: () => Promise<unknown>,
    read?: () => DesignDraftEdit | undefined,
    preserved?: (edit: DesignDraftEdit) => void,
  ) => () => void;
  readonly flushEdits: () => Promise<void>;
  readonly preserveEdits: () => Promise<boolean>;
  readonly placeProducts: (
    input: DesignProductPlacement,
  ) => Promise<DesignState | undefined>;
  readonly fitMedia: (input: {
    readonly nodeId: string;
    readonly sourceUrl: string;
    readonly width: number;
    readonly height: number;
  }) => Promise<DesignState | undefined>;
  readonly setViewport: (
    viewport: DesignDocument["viewport"],
  ) => Promise<DesignState | undefined>;
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
  readonly observe: (request?: GetDesignStateRequest) => () => void;
  readonly invalidate: () => void;
  readonly present: (intent: DesignOpenIntent) => void;
  readonly standaloneUrl: (
    request?: GetDesignStateRequest,
  ) => string | undefined;
  readonly assetUrl: (url: string) => string;
  readonly sessionUrl: (sessionId: string) => string | undefined;
  readonly dispose: () => void;
}

const initial: DesignSnapshot = {
  status: "idle",
  busy: false,
  canUndo: false,
  canRedo: false,
};
const historical = new Set<DesignAction["type"]>([
  "save",
  "add_node",
  "update_node",
  "remove_node",
  "connect",
  "disconnect",
  "apply_template",
]);
// Commands that consume a node's current inputs or the document's current
// content must not run on a debounced editor value that has not reached the
// authority. The flush is awaited and a refused flush cancels the command.
const freshInputs = new Set<DesignAction["type"]>([
  "create",
  "apply_template",
  "remove",
  "run",
  "media_tool",
  "save_template",
  "export_file",
]);
const describe = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);
const object = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

function changedDocument(
  base: DesignDocument,
  action: DesignAction,
): DesignDocument | undefined {
  if (action.type === "save") return action.document;
  if (action.type !== "update_node") return;
  const patch = action.patch,
    metadata = object(patch.metadata);
  return {
    ...base,
    nodes: base.nodes.map((node) =>
      node.id === action.nodeId
        ? ({
            ...node,
            ...patch,
            metadata: {
              ...node.metadata,
              ...metadata,
              ...(metadata.output
                ? {
                    output: {
                      ...node.metadata.output,
                      ...object(metadata.output),
                    },
                  }
                : {}),
            },
          } as typeof node)
        : node,
    ),
  };
}

/** One browser document's observation and serialized write authority for Design. */
export function createDesignOwner({
  port,
  readVersion,
  subscribeVersion,
}: {
  readonly port: DesignPort;
  /**
   * The handshake version the settings workflow already published.
   *
   * The version is one fact with several readers: the settings workflow reads
   * it from the bridge and publishes it in its snapshot, and the design
   * surface shows it. A second read would be a second round trip, and two
   * readers of one fact can disagree about it.
   */
  readonly readVersion?: () => WebuiVersionInfo | undefined;
  /** Called when that published version changes, so the surface follows it. */
  readonly subscribeVersion?: (listener: () => void) => () => void;
}): DesignOwner {
  const store = createWebuiSnapshotStore<DesignSnapshot>(initial);
  const history = new Map<
    string,
    {
      undo: DesignDocument[];
      redo: DesignDocument[];
      revision?: string;
      generation: number;
      resetReason?: string;
    }
  >();
  const observed = new Map<string, DesignDocument[]>();
  const editors = new Set<() => Promise<unknown>>();
  const draftEditors = new Map<
    () => Promise<unknown>,
    {
      readonly read: () => DesignDraftEdit | undefined;
      readonly preserved?: (edit: DesignDraftEdit) => void;
    }
  >();
  let flushing: Promise<void> | undefined;
  let preserving: Promise<boolean> | undefined;
  const preserveEdits = (): Promise<boolean> => {
    if (preserving) return preserving;
    const task = (async () => {
      const current = store.getSnapshot(),
        mine = epoch;
      const captured = [...draftEditors.values()].flatMap((editor) => {
        const edit = editor.read();
        return edit ? [{ edit, preserved: editor.preserved }] : [];
      });
      if (!captured.length) return true;
      if (!current.documentId || !port.applyDesignAction) return false;
      const edits = new Map<string, DesignDraftEdit>();
      for (const { edit } of captured) {
        const previous = edits.get(edit.nodeId);
        if (!previous) {
          edits.set(edit.nodeId, edit);
          continue;
        }
        edits.set(edit.nodeId, {
          nodeId: edit.nodeId,
          baseNode: {
            ...previous.baseNode,
            ...(edit.patch.title !== undefined
              ? { title: edit.baseNode.title }
              : {}),
            metadata: {
              ...previous.baseNode.metadata,
              ...Object.fromEntries(
                Object.keys(edit.patch.metadata ?? {}).map((key) => [
                  key,
                  edit.baseNode.metadata[key],
                ]),
              ),
            },
          },
          patch: {
            ...previous.patch,
            ...edit.patch,
            metadata: { ...previous.patch.metadata, ...edit.patch.metadata },
          },
        });
      }
      try {
        const saved = await port.applyDesignAction({
          documentId: current.documentId,
          sessionId: current.sessionId,
          action: {
            type: "save_draft_edits",
            edits: [...edits.values()],
            ...(current.data?.draft
              ? { draftRevision: current.data.draft.revision }
              : {}),
          },
        });
        if (!saved.draft) throw new Error("运行时未确认草稿保存");
        if (mine === epoch && !store.isDisposed())
          store.set((state) => ({
            ...state,
            data: state.data
              ? { ...state.data, draft: saved.draft }
              : state.data,
          }));
        for (const item of captured) item.preserved?.(item.edit);
        return true;
      } catch (reason) {
        if (mine === epoch && !store.isDisposed())
          store.set((state) => ({
            ...state,
            error: `草稿尚未确认保存：${describe(reason)}`,
          }));
        return false;
      }
    })();
    preserving = task;
    const settled = () => {
      if (preserving === task) preserving = undefined;
    };
    void task.then(settled, settled);
    return task;
  };
  let lastFlushLive = true;
  let lastFlushDirty = false;
  const flushEdits = (requireLive = false): Promise<void> => {
    if (flushing) {
      if (!requireLive) return flushing;
      // A run must not inherit the result of an older normal flush. Once it
      // settles, the editor's own live-confirmation flag decides.
      return flushing.then(() => {
        if (!lastFlushLive || lastFlushDirty)
          throw new Error(
            "编辑尚未写入当前画布；请确认当前画布保存后再运行。",
          );
      });
    }
    const task = Promise.all([...editors].map((flush) => flush())).then(
      async (results) => {
        const dirty = [...draftEditors.values()].some((editor) => editor.read());
        const live = results.every((result) => result !== false);
        lastFlushLive = live;
        lastFlushDirty = dirty;
        if (requireLive && (!live || dirty)) {
          // Preserve the user's text for recovery, but do not let a run or a
          // document-consuming command read the old authority value.
          if (dirty && !(await preserveEdits()))
            throw new Error("编辑尚未保存，请保留此页面并重试。");
          throw new Error(
            live
              ? "编辑尚未写入当前画布，已保留草稿；请确认当前画布保存后再运行。"
              : "编辑尚未写入当前画布；请确认当前画布保存后再运行。",
          );
        }
        if (dirty && !(await preserveEdits()))
          throw new Error("编辑尚未保存，请保留此页面并重试。");
      },
    );
    flushing = task;
    const settled = () => {
      if (flushing === task) flushing = undefined;
    };
    void task.then(settled, settled);
    return task;
  };
  let epoch = 0;
  let queued: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const pendingActivities = { content: 0, view: 0, operation: 0 };
  const activity = (): DesignSnapshot["activity"] =>
    pendingActivities.content
      ? "content"
      : pendingActivities.view
        ? "view"
        : pendingActivities.operation
          ? "operation"
          : undefined;
  let interested = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading: Promise<void> | undefined;
  let intentId: string | undefined;
  if (readVersion) {
    const publish = (runtimeVersion: WebuiVersionInfo | undefined): void => {
      if (!runtimeVersion || store.isDisposed()) return;
      store.set((current) => ({ ...current, runtimeVersion }));
    };
    publish(readVersion());
    subscribeVersion?.(() => publish(readVersion()));
  } else if (port.version)
    void port
      .version()
      .then((runtimeVersion) => {
        if (!store.isDisposed())
          store.set((current) => ({ ...current, runtimeVersion }));
      })
      .catch((reason: unknown) => {
        if (!store.isDisposed())
          store.set((current) => ({
            ...current,
            versionError: describe(reason),
          }));
      });
  const entries = (id: string) => {
    let entry = history.get(id);
    if (!entry) {
      entry = { undo: [], redo: [], generation: 0 };
      history.set(id, entry);
    }
    return entry;
  };
  const trackRevision = (
    document: DesignDocument,
    source: "observation" | "mutation",
  ) => {
    const entry = entries(document.id);
    if (
      source === "observation" &&
      entry.revision !== undefined &&
      entry.revision !== document.updatedAt
    ) {
      // A runtime result or another view may change any field. Restoring a
      // whole old document across that boundary would discard accepted work.
      entry.undo = [];
      entry.redo = [];
      entry.generation += 1;
      entry.resetReason = "画布的运行结果或其他内容已更新，撤销历史已重置。";
    }
    entry.revision = document.updatedAt;
    return entry;
  };
  const adopt = (
    data: DesignState,
    source: "observation" | "mutation",
  ): void => {
    if (store.isDisposed()) return;
    const id = data.document?.id;
    if (data.document) {
      const versions = observed.get(data.document.id) ?? [];
      if (
        !versions.some(
          (version) => version.updatedAt === data.document!.updatedAt,
        )
      )
        observed.set(data.document.id, [...versions.slice(-49), data.document]);
    }
    const entry = data.document
      ? trackRevision(data.document, source)
      : undefined;
    store.set((current) => ({
      ...current,
      data,
      documentId: id,
      status: "ready",
      error: undefined,
      canUndo: Boolean(entry?.undo.length),
      canRedo: Boolean(entry?.redo.length),
      historyResetReason: entry?.resetReason,
    }));
  };
  const load = async (request?: GetDesignStateRequest): Promise<void> => {
    if (store.isDisposed()) return;
    const current = store.getSnapshot();
    const scope = request ?? {
      sessionId: current.sessionId,
      documentId: current.documentId,
    };
    const changed =
      scope.documentId !== current.documentId ||
      scope.sessionId !== current.sessionId;
    if (changed && editors.size) {
      try {
        await flushEdits();
      } catch (reason) {
        store.set((state) => ({ ...state, error: describe(reason) }));
        return;
      }
    }
    if (loading && !changed) return loading;
    const mine = ++epoch;
    if (!port.getDesignState) {
      store.set((state) => ({
        ...state,
        status: "unavailable",
        error: "当前运行时未提供 Design 能力。",
      }));
      return;
    }
    store.set((state) => ({
      ...state,
      ...scope,
      ...(changed ? { data: undefined } : {}),
      status: state.data && !changed ? state.status : "loading",
    }));
    const task = (async () => {
      try {
        const data = await port.getDesignState!(scope);
        if (mine !== epoch || store.isDisposed()) return;
        adopt(data, "observation");
      } catch (reason) {
        if (mine !== epoch || store.isDisposed()) return;
        store.set((state) => ({
          ...state,
          status: "error",
          error: describe(reason),
        }));
      }
    })();
    loading = task;
    await task;
    if (loading === task) loading = undefined;
  };
  const execute = (
    action: DesignAction,
    record: boolean,
    restoreHistory = false,
    prepare?: (document: DesignDocument) => DesignAction | undefined,
  ): Promise<DesignState | undefined> => {
    const target = store.getSnapshot();
    const targetId = target.documentId;
    const targetSession = target.sessionId;
    let operationEpoch: number | undefined;
    let unsaved:
      | {
          readonly document: DesignDocument;
          readonly baseDocument: DesignDocument;
          readonly draftRevision?: string;
        }
      | undefined;
    const category =
      (record || restoreHistory) && historical.has(action.type)
        ? "content"
        : action.type === "save"
          ? "view"
          : "operation";
    pendingActivities[category] += 1;
    pending += 1;
    store.set((current) => ({
      ...current,
      busy: true,
      activity: activity(),
      error: undefined,
    }));
    const task = queued
      .then(async () => {
        if (store.isDisposed()) return undefined;
        if (!port.applyDesignAction)
          throw new Error("当前运行时未提供 Design 写入能力。");
        const before = store.getSnapshot();
        if (
          before.documentId !== targetId ||
          before.sessionId !== targetSession
        )
          throw new Error("画布已切换，未提交旧页面的操作。");
        const mine = ++epoch;
        operationEpoch = mine;
        const document = before.data?.document;
        if (prepare && document) {
          const prepared = prepare(document);
          if (!prepared) return before.data;
          action = prepared;
        }
        const saving = action.type === "save" ? action.document : undefined;
        const base = saving
          ? observed
              .get(saving.id)
              ?.find((version) => version.updatedAt === saving.updatedAt)
          : document;
        const changed =
          base && record && !restoreHistory
            ? changedDocument(base, action)
            : undefined;
        if (base && changed)
          unsaved = {
            document: changed,
            baseDocument: base,
            draftRevision: before.data?.draft?.revision,
          };
        const historyGeneration = document
          ? entries(document.id).generation
          : undefined;
        // A full-document edit must still be based on the revision its content
        // came from. Undo/redo deliberately restores old content at the current CAS.
        const revision =
          action.type === "save" && !restoreHistory
            ? action.document.updatedAt
            : document?.updatedAt;
        const data = await port.applyDesignAction({
          documentId: targetId,
          sessionId: targetSession,
          action,
          ...(revision !== undefined ? { expectedRevision: revision } : {}),
        });
        if (store.isDisposed()) return data;
        // Fresh response assembly can observe a runtime commit after this action's
        // locked write. That newer document is not this local edit's history head.
        const mixedRevision =
          data.committedRevision !== undefined &&
          data.document?.updatedAt !== data.committedRevision;
        if (mixedRevision && data.document)
          trackRevision(data.document, "observation");
        if (
          !mixedRevision &&
          record &&
          document &&
          historical.has(action.type) &&
          data.document?.id === document.id &&
          entries(document.id).generation === historyGeneration
        ) {
          const entry = entries(document.id);
          entry.undo.push(document);
          if (entry.undo.length > 50) entry.undo.shift();
          entry.redo = [];
          entry.revision = data.document.updatedAt;
          entry.resetReason = undefined;
        }
        if (mine === epoch)
          adopt(
            data,
            mixedRevision || (record && !historical.has(action.type))
              ? "observation"
              : "mutation",
          );
        return data;
      })
      .catch(async (reason: unknown) => {
        if (store.isDisposed()) return undefined;
        if (operationEpoch !== undefined && operationEpoch !== epoch)
          return undefined;
        if (
          store.getSnapshot().documentId !== targetId ||
          store.getSnapshot().sessionId !== targetSession
        )
          return undefined;
        let error = describe(reason);
        if (unsaved && port.applyDesignAction) {
          try {
            const saved = await port.applyDesignAction({
              documentId: targetId,
              sessionId: targetSession,
              action: { type: "save_draft", ...unsaved },
            });
            if (
              operationEpoch === epoch &&
              store.getSnapshot().documentId === targetId &&
              store.getSnapshot().sessionId === targetSession &&
              saved.draft
            )
              store.set((current) => ({
                ...current,
                data: current.data
                  ? { ...current.data, draft: saved.draft }
                  : current.data,
              }));
          } catch (draftError) {
            error += `；未能保存草稿：${describe(draftError)}`;
          }
        }
        if (operationEpoch !== undefined && operationEpoch !== epoch)
          return undefined;
        // A refused write is never retried: another tab may have changed its intent.
        if (/revision|conflict|版本|冲突/iu.test(error)) await load();
        if (
          store.getSnapshot().documentId === targetId &&
          store.getSnapshot().sessionId === targetSession
        )
          store.set((current) => ({ ...current, error }));
        return undefined;
      })
      .finally(() => {
        pending -= 1;
        pendingActivities[category] -= 1;
        if (!store.isDisposed())
          store.set((current) => ({
            ...current,
            busy: pending > 0,
            activity: activity(),
          }));
      });
    queued = task;
    return task;
  };
  const travel = async (direction: "undo" | "redo"): Promise<void> => {
    const scope = store.getSnapshot();
    const document = scope.data?.document;
    if (!document || pending) return;
    const entry = entries(document.id);
    const generation = entry.generation;
    const previous = entry[direction].at(-1);
    if (!previous) return;
    const result = await execute(
      { type: "save", document: previous },
      false,
      true,
    );
    if (!result?.document || entry.generation !== generation) return;
    entry[direction].pop();
    entry[direction === "undo" ? "redo" : "undo"].push(document);
    entry.revision = result.document.updatedAt;
    // execute alone decides whether its response is still visible. A navigation
    // A -> B -> A can have loaded a newer A while this undo was in flight.
    if (store.getSnapshot().documentId === document.id)
      store.set((current) => ({
        ...current,
        canUndo: Boolean(entry.undo.length),
        canRedo: Boolean(entry.redo.length),
      }));
  };
  const schedule = (): void => {
    if (timer || !interested || store.isDisposed()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!interested || store.isDisposed()) return;
      void (pending ? Promise.resolve() : load()).finally(schedule);
    }, 1_500);
  };
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    load,
    act: async (action) => {
      const requiresLiveAuthority = [
        "run",
        "media_tool",
        "save_template",
        "export_file",
      ].includes(action.type);
      if (freshInputs.has(action.type) && editors.size) {
        try {
          await flushEdits(requiresLiveAuthority);
        } catch (reason) {
          store.set((state) => ({ ...state, error: describe(reason) }));
          return undefined;
        }
      }
      return execute(action, action.type !== "set_media_poster");
    },
    registerPendingEdit: (flush, read, preserved) => {
      editors.add(flush);
      if (read) draftEditors.set(flush, { read, preserved });
      return () => {
        editors.delete(flush);
        draftEditors.delete(flush);
      };
    },
    flushEdits,
    preserveEdits,
    placeProducts: (input) => {
      const document = store.getSnapshot().data?.document;
      return document
        ? execute({ type: "save", document }, true, false, (latest) => ({
            type: "save",
            document: designPlaceProducts(latest, input),
          }))
        : Promise.resolve(undefined);
    },
    fitMedia: (input) =>
      execute(
        { type: "update_node", nodeId: input.nodeId, patch: {} },
        true,
        false,
        (latest) => {
          const node = latest.nodes.find((node) => node.id === input.nodeId);
          if (
            !node ||
            node.metadata.output.media[0]?.url !== input.sourceUrl ||
            input.width <= 0 ||
            input.height <= 0
          )
            return;
          const size = designMediaGeometry(node, input);
          if (
            Math.abs(node.width - size.width) <= 1 &&
            Math.abs(node.height - size.height) <= 1
          )
            return;
          return { type: "update_node", nodeId: node.id, patch: size };
        },
      ),
    setViewport: (viewport) => {
      const document = store.getSnapshot().data?.document;
      return document
        ? execute({ type: "save", document: { ...document, viewport } }, false)
        : Promise.resolve(undefined);
    },
    undo: () => travel("undo"),
    redo: () => travel("redo"),
    observe: (request) => {
      interested += 1;
      void load(request);
      schedule();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        interested -= 1;
        if (!interested && timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    invalidate: () => {
      if (interested && !pending) void load();
    },
    present: (intent) => {
      if (intentId === intent.id || store.isDisposed()) return;
      intentId = intent.id;
      store.set((current) => ({ ...current, intent }));
    },
    standaloneUrl: (request = {}) => port.designStandaloneUrl?.(request),
    assetUrl: (url) => port.designAssetUrl?.(url) ?? url,
    sessionUrl: (sessionId) => port.designSessionUrl?.(sessionId),
    dispose: () => {
      epoch += 1;
      if (timer) clearTimeout(timer);
      timer = undefined;
      store.dispose();
    },
  };
}
