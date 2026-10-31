import type { WebuiClientSession } from "../contracts/session-view.js";
import type { WebuiClientSessionPage } from "../contracts/session-view.js";
import type { WebuiClientSessionTreePage } from "../contracts/session-view.js";

/** Merge the committed flat page with child rows in the committed tree. */
export function selectWebuiSessionLookups(
  flat: WebuiClientSessionPage,
  tree: WebuiClientSessionTreePage,
): readonly WebuiClientSession[] {
  if (tree.sessions.length === 0) return flat.sessions;
  const seen = new Set(flat.sessions.map((session) => session.sessionId));
  const result = [...flat.sessions];
  for (const node of tree.sessions) {
    for (const child of node.childSessions) {
      if (seen.has(child.sessionId)) continue;
      seen.add(child.sessionId);
      result.push(child);
    }
  }
  return result;
}

/** Resolve the requester's established name for one target session. */
export function selectWebuiSessionAgentName(
  sessions: readonly WebuiClientSession[],
  sessionId: string | undefined,
): string {
  return sessions.find((session) => session.sessionId === sessionId)?.agentName ?? "main";
}
