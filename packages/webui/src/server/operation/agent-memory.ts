import { WebuiErrorCode } from "../envelope.js";
import { WEBUI_DEFAULT_AGENT_NAME } from "../agent-memory.js";
import type { WebuiOperation } from "./operation-contract.js";
import {
  GET_AGENT_MEMORY_OPERATION_NAME,
  SET_AGENT_MEMORY_OPERATION_NAME,
} from "./names.js";

/**
 * Summary read by default — size, mtime, path — with no body. `includeContent`
 * opts into the full text, because a live main file runs past the 64KB cleanup
 * threshold and shipping it on every panel open would be a large payload for a
 * row that only needs the size.
 */
export const getAgentMemoryOperation: WebuiOperation<
  { readonly includeContent?: boolean },
  unknown
> = {
  name: GET_AGENT_MEMORY_OPERATION_NAME,
  validate: (body) => {
    if (body !== undefined && (body === null || typeof body !== "object" || Array.isArray(body)))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "getAgentMemory body must be an object",
      };
    const includeContent = (body as Record<string, unknown> | undefined)?.includeContent;
    if (includeContent !== undefined && typeof includeContent !== "boolean")
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "includeContent must be a boolean",
      };
    return {
      ok: true,
      body: {
        ...(typeof includeContent === "boolean" ? { includeContent } : {}),
        agentName: WEBUI_DEFAULT_AGENT_NAME,
      },
    };
  },
};

export const setAgentMemoryOperation: WebuiOperation<
  { readonly content: string },
  unknown
> = {
  name: SET_AGENT_MEMORY_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "setAgentMemory body must be an object",
      };
    const content = (body as Record<string, unknown>).content;
    // Empty is legal — it removes the file, matching the runtime's write
    // contract. A missing or non-string content would delete it by accident,
    // so that has to stay unreachable from a malformed frame.
    if (typeof content !== "string")
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "setAgentMemory requires a string content",
      };
    return { ok: true, body: { content, agentName: WEBUI_DEFAULT_AGENT_NAME } };
  },
};
