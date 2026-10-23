// The Agent's browser tools over the browser bridge, against a real bridge.
//
// The bridge drives the person's own browser through the extension's
// `chrome.debugger`. It is not a DevTools connection: the extension answers
// one `cdp` frame with one `cdp-result` frame, and the bridge carries no
// DevTools events at all.
//
// That is the hard part of driving the Browser Core over the bridge, and it
// is what these cases are about. The core needs a navigation to know that the
// references it holds have gone stale, and it cannot learn one from an event
// — the bridge has no event channel. It learns one from the extension's own
// generation, which rises on each committed top-level navigation and arrives
// in the `targets` frame.
//
// So the cases here are:
//
//   * the core's action path works over the bridge at all — an inspection
//     yields a reference, and a click on that reference reaches the element
//     through the commands the core issues;
//   * a reference recorded before the tab navigated is refused afterwards,
//     because the announcement of the new generation reached the core.
//
// The extension is a test double, not a browser: it answers the commands the
// core sends with the shapes the core reads. What is asserted is the wiring —
// that the core's semantics reach the browser through the bridge, and that the
// navigation fence holds.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  BrowserBridgeServer,
  createInMemorySecureCredentialStore,
} from "../../src/server/browser-bridge/index.js";
import { WebuiWebSocketServer } from "../../src/server/websocket-server.js";
import { WEBUI_BROWSER_BRIDGE_PATH } from "../../src/shared/contracts/browser-bridge.js";
import { createWebuiCredential } from "../../src/server/credentials.js";

const EDGE_EXTENSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
const BROWSER_ID = "edge-instance-1";
const TARGET_ID = "TAB-1";

interface Harness {
  readonly bridge: BrowserBridgeServer;
  readonly httpServer: Server;
  readonly wsServer: WebuiWebSocketServer;
  readonly port: number;
  close(): Promise<void>;
}

const openHarnesses: Harness[] = [];

afterEach(async () => {
  while (openHarnesses.length > 0) {
    await openHarnesses.pop()?.close();
  }
});

async function startHarness(): Promise<Harness> {
  const bridge = new BrowserBridgeServer({
    host: "127.0.0.1",
    dev: true,
    credentialStore: createInMemorySecureCredentialStore(),
    env: { MAVIS_BROWSER_EDGE_EXTENSION_IDS: EDGE_EXTENSION_ID },
  });
  await bridge.start();
  // The bridge does not switch a surface on by itself: the browser switches
  // own the pairings, and the service is where the two meet. A test switches
  // on exactly the surfaces its environment configures, which is what the
  // persisted switches do in a running host.
  await bridge.enableSurface("edge");
  const httpServer = createServer();
  const wsServer = new WebuiWebSocketServer({
    maxMessageBytes: 256 * 1024,
    heartbeatIntervalMs: 15_000,
    host: "127.0.0.1",
    boundTcpPort: () => (httpServer.address() as AddressInfo | null)?.port,
    credential: createWebuiCredential(),
    dev: true,
    operations: new Map(),
    isAccepting: () => true,
    browserBridge: bridge,
  });
  httpServer.on("upgrade", wsServer.handleUpgrade);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const harness: Harness = {
    bridge,
    httpServer,
    wsServer,
    port: (httpServer.address() as AddressInfo).port,
    close: async () => {
      await bridge.close();
      wsServer.closeConnections();
      // A test that failed mid-handshake can leave a half-open socket; the
      // listener would otherwise wait for it for the platform TCP timeout.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
  openHarnesses.push(harness);
  return harness;
}

/** One frame the bridge sent. */
interface BridgeFrame {
  readonly kind: string;
  readonly commandId?: string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

interface BridgeClient {
  readonly socket: WebSocket;
  readonly frames: BridgeFrame[];
  readonly opened: Promise<void>;
  waitFor<T extends object>(kind: string, timeoutMs?: number): Promise<T & BridgeFrame>;
  waitForNext<T extends object>(
    kind: string,
    sinceIndex: number,
    timeoutMs?: number,
  ): Promise<T & BridgeFrame>;
}

function connectClient(url: string, headers: Record<string, string>): BridgeClient {
  const frames: BridgeFrame[] = [];
  const socket = new WebSocket(url, { headers });
  socket.on("message", (data) => {
    try {
      frames.push(JSON.parse(String(data)) as BridgeFrame);
    } catch {
      // Not a bridge frame; the session reports that itself.
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) => {
      reject(new Error(`upgrade refused with ${response.statusCode}`));
    });
    socket.once("error", reject);
  });
  const waitFor = async <T extends object>(
    kind: string,
    timeoutMs = 4_000,
  ): Promise<T & BridgeFrame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames.find((frame) => frame.kind === kind);
      if (found) return found as T & BridgeFrame;
      if (Date.now() > deadline) throw new Error(`timed out waiting for a "${kind}" frame`);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  };
  const waitForNext = async <T extends object>(
    kind: string,
    sinceIndex: number,
    timeoutMs = 4_000,
  ): Promise<T & BridgeFrame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames.slice(sinceIndex).find((frame) => frame.kind === kind);
      if (found) return found as T & BridgeFrame;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for a second "${kind}" frame`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  };
  return { socket, frames, opened, waitFor, waitForNext };
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
};

async function pairEdge(harness: Harness): Promise<BridgeClient> {
  const client = connectClient(`ws://127.0.0.1:${harness.port}${WEBUI_BROWSER_BRIDGE_PATH}`, {
    origin: `chrome-extension://${EDGE_EXTENSION_ID}/`,
  });
  await client.opened;
  client.socket.send(
    JSON.stringify({
      kind: "hello",
      browser: "edge",
      browserId: BROWSER_ID,
      extensionVersion: "1.0.0",
    }),
  );
  const pairing = harness.bridge.pairings.get("edge");
  if (!pairing) throw new Error("no edge pairing");
  const challenge = await client.waitFor<{ nonce: string; keyId: string }>("challenge");
  const signature = await pairing.signProof(challenge.nonce);
  client.socket.send(
    JSON.stringify({ kind: "proof", keyId: challenge.keyId, nonce: challenge.nonce, signature }),
  );
  await client.waitFor("ready");
  await settle();
  return client;
}

function announceTarget(client: BridgeClient, generation: number, url = "https://example.com/"): void {
  client.socket.send(
    JSON.stringify({
      kind: "targets",
      targets: [
        {
          browserId: BROWSER_ID,
          targetId: TARGET_ID,
          title: "Example",
          url,
          generation,
        },
      ],
    }),
  );
}

/**
 * Answers the DevTools commands the core sends, with the shapes it reads.
 *
 * The answer is a stand-in for the browser: it does not run a page, it says
 * what a page with one button and one field would say. What the cases assert
 * is the wiring — that the core's action path reaches the browser through the
 * bridge, and that the commands it issues are the ones the extension is
 * willing to run.
 */
function answerCoreCommands(client: BridgeClient, seen: number, seenMethods: Set<string> = new Set()): void {
  let cursor = seen;
  const respond = (frame: BridgeFrame, result: unknown): void => {
    client.socket.send(
      JSON.stringify({
        kind: "cdp-result",
        commandId: frame.commandId,
        accepted: true,
        result,
      }),
    );
  };
  const answer = async (): Promise<void> => {
    // The cursor moves past every frame that was answered, so the loop waits
    // for the *next* command rather than finding the same one again.
    const frame = await client.waitForNext<BridgeFrame>("cdp", cursor);
    cursor = client.frames.indexOf(frame) + 1;
    seenMethods.add(String(frame.method));
    switch (frame.method) {
      case "DOM.enable":
      case "Page.enable":
      case "Runtime.enable":
      case "Accessibility.enable":
      case "DOMSnapshot.enable":
      case "Network.enable":
        respond(frame, {});
        return;
      case "Page.getLayoutMetrics":
        respond(frame, { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } });
        return;
      case "Page.getFrameTree":
        respond(frame, {
          frameTree: {
            frame: { id: "frame-1", url: "https://example.com/", securityOrigin: "https://example.com" },
            childFrames: [],
          },
        });
        return;
      case "DOM.getDocument":
        respond(frame, {
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: 9,
            nodeName: "#document",
            childNodeCount: 1,
            children: [],
          },
        });
        return;
      case "DOM.querySelectorAll":
        respond(frame, { nodeIds: [2] });
        return;
      case "DOM.describeNode":
        respond(frame, {
          node: {
            nodeId: 2,
            backendNodeId: 22,
            nodeType: 1,
            nodeName: "BUTTON",
            attributes: ["id", "go"],
            localName: "button",
            nodeValue: "",
          },
        });
        return;
      case "DOM.getBoxModel":
        respond(frame, {
          model: { content: [0, 0, 0, 0, 100, 0, 100, 40, 0, 40], width: 100, height: 40 },
        });
        return;
      case "DOM.resolveNode":
        respond(frame, { object: { objectId: "object-1" } });
        return;
      case "Runtime.callFunctionOn":
        respond(frame, { result: { type: "object", value: {} } });
        return;
      case "Runtime.evaluate": {
        // The core reads the page in three ways, and each gets the answer it
        // asked for: the page's own summary before it moves, the document's
        // readiness, and the elements a page is made of.
        const expression = String(
          (frame.params as { expression?: string } | undefined)?.expression ?? "",
        );
        if (expression.includes("readyState")) {
          respond(frame, {
            result: { type: "object", value: { url: "https://example.com/", readyState: "complete", timeOrigin: 1 } },
          });
          return;
        }
        if (expression.includes("processedElements") || expression.includes("getUniqueSelector")) {
          // The element scan runs inside the page and answers with the
          // elements it found, each with a selector the core can resolve.
          respond(frame, {
            result: {
              type: "object",
              value: [
                {
                  index: 0,
                  selector: "#go",
                  tag: "button",
                  type: "clickable",
                  text: "go",
                  normalizedPosition: { x: 0.1, y: 0.1 },
                  boundingBox: { x: 100, y: 100, width: 100, height: 40 },
                  isInViewport: true,
                  isInteractable: true,
                  attributes: { id: "go" },
                },
              ],
            },
          });
          return;
        }
        respond(frame, {
          result: {
            type: "object",
            value: {
              url: "https://example.com/",
              title: "Example",
              viewport: { width: 1280, height: 800 },
              scrollPosition: { x: 0, y: 0 },
              pageHeight: 800,
              pageWidth: 1280,
            },
          },
        });
        return;
      }
      case "Runtime.releaseObject":
        respond(frame, {});
        return;
      case "Input.dispatchMouseEvent":
        respond(frame, {});
        return;
      case "DOMSnapshot.captureSnapshot":
        respond(frame, { documents: [], strings: [], nodes: [] });
        return;
      case "Accessibility.getFullAXTree":
        respond(frame, { nodes: [] });
        return;
      case "Page.getNavigationHistory":
        respond(frame, {
          currentIndex: 0,
          entries: [{ id: 1, url: "https://example.com/" }],
        });
        return;
      case "Page.stopLoading":
        respond(frame, {});
        return;
      default:
        // A command the double does not model is answered as unsupported, the
        // way the extension answers a method outside its subset.
        client.socket.send(
          JSON.stringify({
            kind: "cdp-result",
            commandId: frame.commandId,
            accepted: false,
            error: `the extension does not support the DevTools command "${frame.method}"`,
            unsupported: true,
          }),
        );
    }
  };
  void (async () => {
    for (;;) {
      try {
        await answer();
      } catch {
        return;
      }
    }
  })();
}

describe("WebUI browser bridge — the Agent's browser tools over Browser Core", () => {
  /**
   * The budget one case is given.
   *
   * An action over the bridge is a round trip per DevTools command, and an
   * inspection issues a good many of them — the domains have to be enabled,
   * the document read, the accessibility tree fetched. The budget is room for
   * a runner several times slower than the machine the numbers were measured
   * on. What is correct and what is not is decided by the assertions.
   */
  const CASE_BUDGET_MS = 30_000;

  it("drives the core's action path over the bridge", { timeout: CASE_BUDGET_MS }, async () => {
    const harness = await startHarness();
    const client = await pairEdge(harness);
    const provider = harness.bridge.createProvider("edge");
    expect(provider).toBeDefined();
    announceTarget(client, 4);
    await settle();

    const seen = client.frames.length;
    const seenMethods = new Set<string>();
    answerCoreCommands(client, seen, seenMethods);

    // The inspection is the action that needs the whole semantic layer: the
    // element map, the retained snapshot and the generation. Before the core
    // was adopted, this action was refused on this surface.
    const answer = (await provider!.sendCommand(
      { targetId: TARGET_ID, generation: 4 },
      "inspect",
      {},
    )) as { elements?: readonly { ref?: string }[] };

    // The core answers with the elements it found. The reference it issues is
    // the opaque form the core uses, which is what makes a stale reference
    // detectable.
    expect(Array.isArray(answer.elements)).toBe(true);
    // The inspection reached the browser through the commands the core needs
    // to build an element map. That it did is the whole point: the extension
    // runs the core's action path rather than refusing the action.
    expect(seenMethods.has("DOM.getDocument")).toBe(true);
    expect(seenMethods.has("Accessibility.getFullAXTree")).toBe(true);
    client.socket.terminate();
  });

  it("refuses a reference recorded before the tab navigated", { timeout: CASE_BUDGET_MS }, async () => {
    const harness = await startHarness();
    const client = await pairEdge(harness);
    const provider = harness.bridge.createProvider("edge");
    expect(provider).toBeDefined();
    announceTarget(client, 4);
    await settle();

    const seen = client.frames.length;
    const seenMethods = new Set<string>();
    answerCoreCommands(client, seen, seenMethods);

    // A reference is taken while the page is still the one it was taken from.
    const answer = (await provider!.sendCommand(
      { targetId: TARGET_ID, generation: 4 },
      "inspect",
      {},
    )) as { elements?: readonly { ref?: string }[] };
    const ref = answer.elements?.[0]?.ref;
    expect(typeof ref).toBe("string");

    // The tab navigates. The extension raises the generation and announces it,
    // and that announcement is the only navigation signal the bridge has.
    announceTarget(client, 5, "https://example.com/next");
    await settle();

    // The core's session for this tab was told about the navigation, so the
    // references it holds are stale — and a click on one is refused rather
    // than aimed at whatever now sits where the element used to be.
    const outcome = await provider!.sendCommand(
      { targetId: TARGET_ID, generation: 5 },
      "click",
      { ref },
    ).catch((error: unknown) => error);
    expect(String((outcome as Error)?.message ?? outcome)).toMatch(
      /STALE_ELEMENT_REF|STALE_SNAPSHOT/u,
    );
    client.socket.terminate();
  });

  it("keeps a reference usable while the tab has not navigated", { timeout: CASE_BUDGET_MS }, async () => {
    const harness = await startHarness();
    const client = await pairEdge(harness);
    const provider = harness.bridge.createProvider("edge");
    expect(provider).toBeDefined();
    announceTarget(client, 4);
    await settle();

    const seen = client.frames.length;
    const seenMethods = new Set<string>();
    answerCoreCommands(client, seen, seenMethods);

    // The same shape of call as the case above, on a tab that has not moved.
    // The fence has to refuse the stale reference and accept this one — so
    // the refusal above is the navigation's doing and not the click's.
    const answer = (await provider!.sendCommand(
      { targetId: TARGET_ID, generation: 4 },
      "inspect",
      {},
    )) as { elements?: readonly { ref?: string }[] };
    const ref = answer.elements?.[0]?.ref;
    expect(typeof ref).toBe("string");

    const clicked = await provider!.sendCommand(
      { targetId: TARGET_ID, generation: 4 },
      "click",
      { ref },
    );
    expect(clicked).toBeDefined();
    // The click reached the browser as a pointer event at the element's box.
    expect(seenMethods.has("Input.dispatchMouseEvent")).toBe(true);
    client.socket.terminate();
  });
});
