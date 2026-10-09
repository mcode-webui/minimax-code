// The personalization operations, driven the way the browser drives them:
// a real `WebuiService` over a real WebSocket.
//
// This file exists because of the gap it covers. `service.ts` builds its
// operation registry from a hand-written projection object literal that
// re-states every port member by hand. A member that is added to
// `WebuiHarnessPort` and to `createOperationHandlers` but forgotten in that
// literal is not a compile error and not a test failure anywhere else: the
// handler layer reads `undefined` and throws "runtime host does not expose ...
// reads", which reads like a host problem instead of a missing forwarding
// line. Both AGENTS.md and the agent-memory panel shipped that way — every
// gate green, every unit test passing, the feature dead on arrival.
//
// The existing `webui-host-shape-invariant.test.ts` cannot catch it either: it
// calls `createOperationRegistry(port)` directly, which is the same
// projection-skipping shortcut. Only booting the service exercises the layer
// that actually breaks, so that is what this file does.

import { once } from "node:events";
import type { RawData } from "ws";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { WebuiErrorCode, WEBUI_PROTOCOL_VERSION } from "../../src/shared/envelope.js";
import { WebuiService } from "../../src/server/service.js";
import type { WebuiHarnessPort } from "../../src/server/port.js";
import type { WebuiAgentMemoryView, WebuiGlobalInstructionsView, WebuiMemorySettingsView, WebuiUserProfileView } from "../../src/client/contracts/settings-port.js";

const INSTRUCTIONS: WebuiGlobalInstructionsView = {
  content: "# Agents 全局设定\n",
  exists: true,
  path: "/data/AGENTS.md",
  maxBytes: 32768,
};
const MEMORY: WebuiAgentMemoryView = {
  agentName: "mavis",
  path: "/data/agents/mavis/memory/MEMORY.md",
  exists: true,
  sizeBytes: 111860,
};
const PROFILE: WebuiUserProfileView = {
  nickname: "izzy",
  occupation: "staff engineer",
  moreAbout: "prefers terse answers",
  exists: true,
  malformed: false,
  path: "/data/memory/user.md",
  sizeBytes: 1529,
  maxChars: 10 * 1024,
};
const SWITCHES: WebuiMemorySettingsView = { enabled: true, proactive: false };

/** A port that implements the four operations with unmistakable sentinels. */
function portWithPersonalization(over: Partial<WebuiHarnessPort> = {}): WebuiHarnessPort {
  return {
    version: () => ({ version: "probe", protocolVersion: WEBUI_PROTOCOL_VERSION }),
    listSessions: () => ({ sessions: [] }),
    getSessionTree: () => ({ nodes: [] }),
    archiveSession: () => undefined,
    getSession: () => ({ session: { sessionId: "mvs_1", title: "T" } }),
    getMessages: () => ({ messages: [] }),
    createSession: () => ({ sessionId: "mvs_new" }),
    updateSession: () => ({ session: { sessionId: "mvs_new" } }),
    deleteSession: () => ({ success: true }),
    sendMessage: () => ({ accepted: true }),
    getActiveTurn: () => ({ items: [] }),
    close: async () => {},
    getGlobalInstructions: async () => INSTRUCTIONS,
    setGlobalInstructions: async () => INSTRUCTIONS,
    getAgentMemory: async () => MEMORY,
    setAgentMemory: async () => MEMORY,
    getUserProfile: async () => PROFILE,
    setUserProfile: async () => PROFILE,
    getMemorySettings: async () => SWITCHES,
    setMemorySettings: async () => SWITCHES,
    ...over,
  } as unknown as WebuiHarnessPort;
}

const services: WebuiService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function serve(port: WebuiHarnessPort): Promise<string> {
  const service = new WebuiService({ port });
  services.push(service);
  const info = await service.start();
  return `${info.boundUrl}/?token=${encodeURIComponent(info.credential.token)}`;
}

function requestOnce(ws: WebSocket, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: RawData) => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      try {
        resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      ws.off("message", onMessage);
      reject(error);
    };
    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.send(JSON.stringify(request));
  });
}

async function call(url: string, operation: string, body?: unknown): Promise<Record<string, unknown>> {
  const ws = new WebSocket(url);
  ws.on("error", () => undefined);
  await once(ws, "open");
  try {
    return await requestOnce(ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: `probe-${operation}`,
      operation,
      body,
    });
  } finally {
    ws.close();
  }
}

describe("personalization operations reach the harness port through the service", () => {
  // Each of these fails if its forwarding line is dropped from the projection
  // in `service.ts`, because the frame then comes back as a harness_error whose
  // message is the "runtime host does not expose" guard.
  it.each([
    ["getGlobalInstructions", undefined, INSTRUCTIONS],
    ["setGlobalInstructions", { content: "# x\n" }, INSTRUCTIONS],
    ["getAgentMemory", undefined, MEMORY],
    ["setAgentMemory", { content: "# x\n" }, MEMORY],
    ["getUserProfile", undefined, PROFILE],
    ["setUserProfile", { nickname: "izzy", occupation: "", moreAbout: "" }, PROFILE],
    ["getMemorySettings", undefined, SWITCHES],
    ["setMemorySettings", { proactive: true }, SWITCHES],
  ])("%s returns the port's own body", async (operation, body, expected) => {
    const url = await serve(portWithPersonalization());
    const frame = await call(url, operation, body);

    expect(frame).toMatchObject({ kind: "response", requestId: `probe-${operation}` });
    expect(frame.body).toEqual(expected);
  });

  it("does not report a port method it never received as a working read", async () => {
    // The absent half matters: an omitted port member has to surface as an
    // error frame, never as a plausible-looking empty body that the panel would
    // render as "no memory file yet".
    const url = await serve(portWithPersonalization({ getAgentMemory: undefined }));
    const frame = await call(url, "getAgentMemory", undefined);

    expect(frame).toMatchObject({
      kind: "error",
      code: WebuiErrorCode.harnessError,
      requestId: "probe-getAgentMemory",
    });
    expect(String(frame.message)).toContain("does not expose agent memory");
  });

  it.each([
    ["getUserProfile", "user profile reads"],
    ["setMemorySettings", "memory settings updates"],
  ])("reports %s as a gap rather than as a value", async (operation, expectedMessage) => {
    // The switches are the case where "absent" and "off" are easy to confuse.
    // A missing port member has to come back as an error frame, because a body
    // of `{ enabled: false }` would render as a working panel that claims the
    // user turned memory off.
    const url = await serve(portWithPersonalization({ [operation]: undefined }));
    const frame = await call(url, operation, operation === "setMemorySettings" ? { enabled: false } : undefined);

    expect(frame).toMatchObject({
      kind: "error",
      code: WebuiErrorCode.harnessError,
      requestId: `probe-${operation}`,
    });
    expect(String(frame.message)).toContain(expectedMessage);
  });

  it("passes the switch patch through to the port unchanged", async () => {
    // The value has to arrive as the user set it. An optimistic UI that
    // renders the toggle before the write is fine; a port that receives
    // something other than the two booleans is not.
    const seen: unknown[] = [];
    const url = await serve(
      portWithPersonalization({
        setMemorySettings: async (request) => {
          seen.push(request);
          return { enabled: request?.enabled ?? true, proactive: request?.proactive ?? false };
        },
      }),
    );

    const frame = await call(url, "setMemorySettings", { enabled: false });

    expect(seen).toEqual([{ enabled: false }]);
    expect(frame.body).toEqual({ enabled: false, proactive: false });
  });
});
