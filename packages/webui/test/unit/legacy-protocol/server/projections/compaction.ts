export type WebuiCompactionState = "never" | "running" | "completed" | "failed";

export function isCompactionEvent(type: string): boolean {
  return (
    type === "session.compaction.started" ||
    type === "session.compaction.completed" ||
    type === "session.compaction.failed"
  );
}

export function projectCompactionEvent(event: { readonly type: string; readonly timestamp: number }):
  | { readonly state: Exclude<WebuiCompactionState, "never">; readonly lastAt: number }
  | undefined {
  if (event.type === "session.compaction.started") return { state: "running", lastAt: event.timestamp };
  if (event.type === "session.compaction.completed") return { state: "completed", lastAt: event.timestamp };
  if (event.type === "session.compaction.failed") return { state: "failed", lastAt: event.timestamp };
  return undefined;
}

