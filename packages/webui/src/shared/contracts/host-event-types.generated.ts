// Generated from local-runtime-v2 event producers; do not edit by hand.
// Regenerate: pnpm --filter @mavis/webui gen:host-events

export const HOST_PUBLISHED_EVENT_TYPES = [
  "agent.created",
  "agent.updated",
  "content.retry.exceeded",
  "message.rewind",
  "session.abort",
  "session.compaction.completed",
  "session.compaction.failed",
  "session.compaction.started",
  "session.created",
  "session.deleted",
  "session.discovered",
  "session.error",
  "session.finish",
  "session.interaction_mode.changed",
  "session.llm_retry",
  "session.model_updated",
  "session.pinned_updated",
  "session.queue.updated",
  "session.start",
  "session.title_updated",
  "session.visibility_updated",
] as const;

export type HostPublishedEventType = (typeof HOST_PUBLISHED_EVENT_TYPES)[number];
