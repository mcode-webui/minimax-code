/**
 * `listAgents` — the agent picker source for the scheduled-task panel.
 *
 * Derived, not owned: the WebUI has no agent catalog of its own, and adding a
 * runtime query for one would be a new dependency on an assembly this package
 * does not own. The `listSessions` response already names the agent behind
 * every session, so the distinct set of `agentName` values is exactly the set
 * an agent can be scheduled against. No new runtime capability is involved.
 */

import { invalidBody } from "./operation-contract.js";
import type { WebuiOperation } from "./operation-contract.js";
import type { WebuiAgentRef, WebuiListAgentsRequest } from "../port.js";
import { LIST_AGENTS_OPERATION_NAME } from "./names.js";

export const listAgentsOperation: WebuiOperation<
  WebuiListAgentsRequest,
  readonly WebuiAgentRef[]
> = {
  name: LIST_AGENTS_OPERATION_NAME,
  validate: (body) => {
    // The client transport sends `{}` for a call it has no parameters for, so
    // an absent body and an empty object both have to be accepted.
    if (body === undefined) return { ok: true, body: {} };
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return invalidBody(`${LIST_AGENTS_OPERATION_NAME} body must be an object`);
    const value = body as Record<string, unknown>;
    if (
      value.limit !== undefined &&
      (!Number.isInteger(value.limit) || (value.limit as number) < 1)
    )
      return invalidBody(`${LIST_AGENTS_OPERATION_NAME} limit must be a positive integer`);
    if (value.cursor !== undefined && typeof value.cursor !== "string")
      return invalidBody(`${LIST_AGENTS_OPERATION_NAME} cursor must be a string`);
    return {
      ok: true,
      body: {
        ...(value.cursor !== undefined ? { cursor: value.cursor as string } : {}),
        ...(value.limit !== undefined ? { limit: value.limit as number } : {}),
      },
    };
  },
};
