// The Mini App Agent cell of the harness port.
//
// The runtime already owns the whole agent path — arena policy, per-plugin
// concurrency, session ownership, the turn algorithm, the permission router — so
// this adapter forwards and converts, never decides. Two conversions happen here:
//
//   * the caller is passed through unchanged, because the runtime's own
//     application takes exactly `{ pluginId, runId, hostSessionId }`. `runId` is
//     the launch's process generation, which is the key the Mini App's registered
//     arena is held under; minting a per-page generation here would refuse every
//     call with an availability failure that looks like a bridge bug.
//   * a runtime refusal is re-thrown as the runtime's own error, untouched. The
//     layer that speaks to a page is the one that maps it to a renderer-safe code
//     (`shared/miniapp-surface`'s `toMiniAppAgentFailureCode`), and a second
//     mapping here would be a second authority on what a page is told.
//
// A host composed without the Mini App Agent application answers with the same
// `capability_unavailable` refusal the catalogue does: one capability, one
// message, whichever member is asked first.
import type {
  MiniAppAgentAgents,
  MiniAppAgentModels,
  MiniAppAgentRunEvent,
  MiniAppAgentRunResult,
} from "@mavis/shared/miniapp-surface";

import {
  MINIAPP_CAPABILITY_ABSENT,
  type WebuiHarnessPort,
  type WebuiMiniAppAgentCaller,
} from "../port.js";
import type { WebuiRuntimeCliService, WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService } from "./requirements.js";
import { WebuiCapabilityUnavailableError } from "../../shared/envelope.js";

/** The nine facade members, as one capability. */
type AgentMembers = Required<
  Pick<
    WebuiRuntimeCliService,
    | "runMiniAppAgentTurn"
    | "answerMiniAppAgentQuestion"
    | "replyMiniAppAgentPermission"
    | "openMiniAppAgentSession"
    | "panelOpenedMiniAppAgentSession"
    | "panelClosedMiniAppAgentSession"
    | "listMiniAppAgentModels"
    | "listMiniAppAgentAgents"
    | "listMiniAppAgentSessions"
    | "readMiniAppAgentSession"
    | "createMiniAppAgentSession"
  >
>;

const AGENT_MEMBER_NAMES = [
  "runMiniAppAgentTurn",
  "answerMiniAppAgentQuestion",
  "replyMiniAppAgentPermission",
  "openMiniAppAgentSession",
  "panelOpenedMiniAppAgentSession",
  "panelClosedMiniAppAgentSession",
  "listMiniAppAgentModels",
  "listMiniAppAgentAgents",
  "listMiniAppAgentSessions",
  "readMiniAppAgentSession",
  "createMiniAppAgentSession",
] as const;

/**
 * The nine members, bound to the service they came from.
 *
 * The runtime's facade methods read `this.options`, so the receiver has to be the
 * service they were destructured from — not this wrapper. A host that has some of
 * them and not others is a broken host rather than a partial capability: the
 * runtime composes all nine from one application cell.
 */
function requireMiniAppAgent(host: WebuiRuntimeHostHandle): AgentMembers {
  const cliService = requireCliService(host);
  const record = cliService as unknown as Record<string, unknown>;
  for (const name of AGENT_MEMBER_NAMES) {
    if (typeof record[name] !== "function")
      throw new WebuiCapabilityUnavailableError(MINIAPP_CAPABILITY_ABSENT);
  }
  const bound = {} as Record<string, (...args: unknown[]) => unknown>;
  for (const name of AGENT_MEMBER_NAMES) {
    const member = record[name] as (...args: unknown[]) => unknown;
    bound[name] = (...args) => member.apply(cliService, args);
  }
  return bound as unknown as AgentMembers;
}

export function createMiniAppAgentAdapter(host: WebuiRuntimeHostHandle): Pick<
  WebuiHarnessPort,
  | "runMiniAppAgentTurn"
  | "answerMiniAppAgentQuestion"
  | "replyMiniAppAgentPermission"
  | "openMiniAppAgentSession"
  | "panelOpenedMiniAppAgentSession"
  | "panelClosedMiniAppAgentSession"
  | "listMiniAppAgentModels"
  | "listMiniAppAgentAgents"
  | "listMiniAppAgentSessions"
  | "readMiniAppAgentSession"
  | "createMiniAppAgentSession"
> {
  return {
    async runMiniAppAgentTurn(input: {
      readonly caller: WebuiMiniAppAgentCaller;
      readonly text: string;
      readonly sessionId?: string;
      readonly agent?: string;
      readonly model?: NonNullable<Parameters<AgentMembers["runMiniAppAgentTurn"]>[0]["model"]>;
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
    }): Promise<MiniAppAgentRunResult> {
      return requireMiniAppAgent(host).runMiniAppAgentTurn({
        caller: input.caller,
        text: input.text,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      });
    },

    async answerMiniAppAgentQuestion(input: {
      readonly caller: WebuiMiniAppAgentCaller;
      readonly sessionId: string;
      readonly requestId: string;
      readonly answers: NonNullable<
        Parameters<AgentMembers["answerMiniAppAgentQuestion"]>[0]["answers"]
      >;
      readonly model?: NonNullable<Parameters<AgentMembers["answerMiniAppAgentQuestion"]>[0]["model"]>;
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: MiniAppAgentRunEvent) => void;
    }): Promise<MiniAppAgentRunResult> {
      return requireMiniAppAgent(host).answerMiniAppAgentQuestion({
        caller: input.caller,
        sessionId: input.sessionId,
        requestId: input.requestId,
        answers: input.answers,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      });
    },

    async replyMiniAppAgentPermission(input: {
      readonly caller: WebuiMiniAppAgentCaller;
      readonly sessionId: string;
      readonly requestId: string;
      readonly decision: NonNullable<
        Parameters<AgentMembers["replyMiniAppAgentPermission"]>[0]["decision"]
      >;
    }): Promise<void> {
      await requireMiniAppAgent(host).replyMiniAppAgentPermission(input);
    },

    async openMiniAppAgentSession(input: {
      readonly caller: WebuiMiniAppAgentCaller;
      readonly sessionId: string;
    }): Promise<{ readonly sessionId: string; readonly hostSessionId: string }> {
      return requireMiniAppAgent(host).openMiniAppAgentSession(input);
    },

    async panelOpenedMiniAppAgentSession(input: {
      readonly sessionId: string;
      readonly hostSessionId: string;
    }): Promise<void> {
      await requireMiniAppAgent(host).panelOpenedMiniAppAgentSession(input);
    },

    async panelClosedMiniAppAgentSession(input: {
      readonly sessionId: string;
      readonly hostSessionId: string;
    }): Promise<void> {
      await requireMiniAppAgent(host).panelClosedMiniAppAgentSession(input);
    },

    async listMiniAppAgentModels(input: {
      readonly caller: WebuiMiniAppAgentCaller;
    }): Promise<MiniAppAgentModels> {
      return requireMiniAppAgent(host).listMiniAppAgentModels(input);
    },

    async listMiniAppAgentAgents(input: {
      readonly caller: WebuiMiniAppAgentCaller;
    }): Promise<MiniAppAgentAgents> {
      return requireMiniAppAgent(host).listMiniAppAgentAgents(input);
    },

    async listMiniAppAgentSessions(input: { readonly caller: WebuiMiniAppAgentCaller }) {
      return requireMiniAppAgent(host).listMiniAppAgentSessions(input);
    },

    async readMiniAppAgentSession(input: {
      readonly caller: WebuiMiniAppAgentCaller;
      readonly sessionId?: string;
    }) {
      return requireMiniAppAgent(host).readMiniAppAgentSession(input);
    },

    async createMiniAppAgentSession(input: {
      readonly caller: WebuiMiniAppAgentCaller;
      readonly agent?: string;
    }): Promise<{ readonly sessionId: string }> {
      return requireMiniAppAgent(host).createMiniAppAgentSession({
        caller: input.caller,
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
      });
    },
  };
}
