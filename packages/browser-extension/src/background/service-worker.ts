// The MV3 service worker: the extension's only long-lived entry point.
//
// An MV3 worker is terminated after a few seconds of inactivity and restarted
// when something needs it, so nothing here keeps state in a module variable. The
// pairing credential is read from `chrome.storage.local` and the target
// generations from `chrome.storage.session` on every start, which is what lets a
// restarted worker answer a fresh challenge and carry on without the host
// noticing anything beyond a new WebSocket. The module holds only a promise for
// the in-flight start, so the worker's repeated top-level evaluation cannot
// register a second set of tab listeners or a second client.

import {
  WebuiBrowserBridgeClient,
} from "../bridge-client.js";
import { createWebuiBrowserBridgeImageStream } from "../images.js";
import {
  WEBUI_BROWSER_BRIDGE_DEBUGGER_VERSION,
  createWebuiBrowserBridgeInputDispatcher,
} from "../input.js";
import { createWebuiBrowserBridgeCdpDispatcher } from "../cdp.js";
import {
  answerWebuiBrowserBridgeChallengeWithStoredSecrets,
  applyWebuiBrowserBridgePairingCredential,
  loadWebuiBrowserBridgeInstallationKey,
  loadWebuiBrowserBridgePairingCredential,
  webuiBrowserBridgeInstallationKeyStore,
  webuiBrowserBridgePairingStore,
  type WebuiBrowserBridgeBrowserName,
  type WebuiBrowserBridgeInstallationKey,
  type WebuiBrowserBridgePairingCredential,
} from "../pairing.js";
import { WEBUI_BROWSER_BRIDGE_RECONNECT_MESSAGE } from "../protocol.js";
import type {
  WebuiBrowserBridgeClientFrame,
  WebuiBrowserBridgeError,
  WebuiBrowserBridgeHostFrame,
} from "../protocol.js";
import {
  createWebuiBrowserBridgeTargetRegistry,
  webuiBrowserBridgeTargetGenerationStore,
} from "../targets.js";

/** The `chrome.storage.local` key the bridge origin lives under. */
const ORIGIN_STORAGE_KEY = "webui.browserBridge.origin";

/** The `chrome.storage.local` key this browser's stable identity lives under. */
const BROWSER_ID_STORAGE_KEY = "webui.browserBridge.browserId";

/** Where the last failure is parked for a diagnostics surface to read. */
const LAST_ERROR_STORAGE_KEY = "webui.browserBridge.lastError";

/**
 * How often the panel's image stream captures.
 *
 * The frame rate is deliberately modest: the tab has to be in front for
 * `captureVisibleTab` to return anything, so a faster loop mostly spends the
 * person's CPU on frames nobody can receive.
 */
const IMAGE_FRAME_INTERVAL_MS = 500;

const pairingStore = webuiBrowserBridgePairingStore(chrome.storage.local);
const installationKeyStore = webuiBrowserBridgeInstallationKeyStore(chrome.storage.local);
const generations = webuiBrowserBridgeTargetGenerationStore(chrome.storage.session);

let starting: Promise<void> | undefined;
/** The live client, so a reconnect can stop it rather than leave it running. */
let currentBridge: WebuiBrowserBridgeClient | undefined;

function start(): Promise<void> {
  starting ??= startBridge();
  return starting;
}

/**
 * Reconnects the bridge.
 *
 * A Manifest V3 service worker is **lazy**: it starts on an event and is torn
 * down when it goes idle. After the person pastes the installation key
 * nothing wakes it, so the extension would sit there configured but
 * unconnected until some unrelated browser event happened to start it again.
 * The options page asks for a reconnect instead, and this is what answers.
 */
async function reconnect(): Promise<void> {
  currentBridge?.stop();
  currentBridge = undefined;
  starting = undefined;
  await start();
}

/** The options page's request to reconnect. */
const RECONNECT_MESSAGE = WEBUI_BROWSER_BRIDGE_RECONNECT_MESSAGE;

async function startBridge(): Promise<void> {
  const browser = detectBrowser();
  const origin = await resolveOrigin();
  if (!origin) {
    // The extension cannot learn the host's address by itself — a person has to
    // enter it — so an absent value is reported rather than replaced by a
    // default port that would quietly connect to something else.
    await report({
      code: "browser_provider_unavailable",
      message: "no WebUI bridge origin is configured for this extension",
      retryable: false,
    });
    return;
  }
  const browserId = await resolveBrowserId();
  // Read any pre-existing credential so a reconnect of an already-paired
  // browser doesn't wait for a `pair` round-trip it has nothing to learn
  // from. The host still sends a fresh pair on each `hello`, but the
  // extension only overwrites storage when that pair arrives — see
  // `applyPairCredential` below.
  let credential: WebuiBrowserBridgePairingCredential | undefined =
    await loadWebuiBrowserBridgePairingCredential(pairingStore);
  // The installation key the person pasted into the options page. Absent on a
  // browser that has never been provisioned, which is a state the handshake
  // reports rather than works around.
  let installationKeyForAnswer: WebuiBrowserBridgeInstallationKey | undefined =
    await loadWebuiBrowserBridgeInstallationKey(installationKeyStore);
  const targets = createWebuiBrowserBridgeTargetRegistry({
    browserId,
    tabs: chrome.tabs,
    generations,
  });
  const input = createWebuiBrowserBridgeInputDispatcher({ targets, debugger: chrome.debugger });
  // The DevTools path shares the input dispatcher's debugger, so the extension
  // has one attach/send path rather than two that could disagree about what is
  // attached to which tab.
  const cdp = createWebuiBrowserBridgeCdpDispatcher({
    debugger: chrome.debugger,
    version: WEBUI_BROWSER_BRIDGE_DEBUGGER_VERSION,
  });
  const images = createWebuiBrowserBridgeImageStream({
    browserId,
    capture: chrome.tabs,
    resolveGeneration: async (targetId) => (await targets.lookup(targetId))?.generation,
  });

  // A restarted worker only knows about the committed navigations the registry
  // persisted, which is why the generations live in storage rather than in a map.
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    void targets.noteCommitted(details.tabId).then(publishTargets, report);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void targets.noteRemoved(tabId).then(publishTargets, report);
  });

  let streaming = false;

  async function publishTargets(): Promise<void> {
    // Publishing waits for a session rather than dropping the list: the target
    // set is what the host needs in order to show the panel at all.
    const list = await targets.list();
    await bridge.publish({ kind: "targets", targets: list });
  }

  async function streamImages(): Promise<void> {
    if (streaming) return;
    streaming = true;
    try {
      while (bridge.connected) {
        try {
          const frame = await images.captureVisibleFrame();
          // The visible tab is the person's tab, which need not be the one the
          // Agent is driving. The frame names its own target so the host can
          // decide what to show, rather than being handed a silent substitution.
          await bridge.publish({ kind: "frame", frame });
        } catch (cause) {
          await report({
            code: "browser_provider_unavailable",
            message: cause instanceof Error ? cause.message : String(cause),
            retryable: true,
          });
        }
        await sleep(IMAGE_FRAME_INTERVAL_MS);
      }
    } finally {
      streaming = false;
    }
  }

  function handleHostFrame(frame: WebuiBrowserBridgeHostFrame): void {
    switch (frame.kind) {
      case "input": {
        // One operation. The delivery runs exactly once and the client reports its
        // outcome under the operation deadline; a reconnect in between
        // re-establishes the session but never re-delivers the command.
        void bridge
          .runOperation(async () => resultFrame(frame.commandId, await input.dispatch(frame.command)))
          .catch(report);
        return;
      }
      case "cdp": {
        // A raw DevTools command, sent only when the host's Full CDP switch is
        // on. The extension still decides whether it will run it: a method
        // outside its supported subset is refused with a reason, and the
        // refusal is reported as *unsupported* so the host can tell it apart
        // from a command that merely failed.
        void bridge
          .runOperation(async () => {
            const target = await targets.lookup(frame.targetId);
            if (!target) {
              return {
                kind: "cdp-result",
                commandId: frame.commandId,
                accepted: false,
                error: `target ${frame.targetId} is not open`,
              } as const;
            }
            if (target.generation !== frame.generation) {
              return {
                kind: "cdp-result",
                commandId: frame.commandId,
                accepted: false,
                error: `target ${frame.targetId} was replaced before the command arrived`,
              } as const;
            }
            const outcome = await cdp.dispatch(
              { tabId: target.tabId },
              frame.method,
              frame.params,
            );
            return outcome.accepted
              ? ({
                  kind: "cdp-result",
                  commandId: frame.commandId,
                  accepted: true,
                  result: outcome.result,
                } as const)
              : ({
                  kind: "cdp-result",
                  commandId: frame.commandId,
                  accepted: false,
                  error: outcome.error,
                  ...(outcome.unsupported ? { unsupported: true } : {}),
                } as const);
          })
          .catch(report);
        return;
      }
      case "closed": {
        void report({ code: "browser_pairing_rejected", message: frame.reason, retryable: false });
        bridge.stop();
        return;
      }
      default: {
        // `challenge` and `ready` are the client's handshake, and `ping` is
        // answered there too.
      }
    }
  }

  const bridge = new WebuiBrowserBridgeClient({
    browser,
    browserId,
    extensionVersion: chrome.runtime.getManifest().version,
    origin,
    /**
     * The credential is held in a worker-local slot and replaced by every
     * `pair` frame. The host is authoritative: each connection it sends the
     * encrypted credential afresh, and the extension stores it. A surface
     * that was off and on again therefore lands at this side without any
     * operator action.
     */
    applyPairCredential: async (cipher, ownPrivateKey) => {
      // The ECDH private key is per-connection and lives only for this call;
      // after the secret has been written to storage nothing else needs it.
      credential = await applyWebuiBrowserBridgePairingCredential(
        pairingStore,
        cipher,
        ownPrivateKey,
      );
    },
    answerChallenge: async (challenge) => {
      // Storage is the source of truth on every challenge, and the local slot
      // is only a fast path: a worker restart reloads from storage and a
      // `pair` overwrites both.
      const current = credential ?? (await loadWebuiBrowserBridgePairingCredential(pairingStore));
      const installationKey =
        installationKeyForAnswer ?? (await loadWebuiBrowserBridgeInstallationKey(installationKeyStore));
      // The installation key is preferred: it is the anchor the host recognises
      // on every connection and the one that survives a credential rotation, so
      // preferring it is what lets a host that re-provisioned re-pair this
      // browser without the person touching anything.
      return answerWebuiBrowserBridgeChallengeWithStoredSecrets(
        challenge,
        installationKey,
        current,
      );
    },
    onStatus: (status) => {
      if (status !== "connected") return;
      void publishTargets().catch(report);
      void streamImages();
    },
    onHostFrame: handleHostFrame,
    onError: report,
  });

  bridge.start();
  currentBridge = bridge;
  void publishTargets().catch(report);
}

function resultFrame(
  commandId: string,
  result:
    | { readonly accepted: true }
    | { readonly accepted: false; readonly error: WebuiBrowserBridgeError },
): WebuiBrowserBridgeClientFrame {
  return result.accepted
    ? { kind: "input-result", commandId, accepted: true }
    : { kind: "input-result", commandId, accepted: false, error: result.error.message };
}

/**
 * Failures are parked in session storage for a diagnostics surface to read.
 *
 * There is no console logging anywhere in this extension: an extension that logs
 * what it is carrying leaks pairing material and page content into whatever
 * collects extension logs, and neither belongs there.
 */
async function report(error: WebuiBrowserBridgeError): Promise<void> {
  await chrome.storage.session.set({ [LAST_ERROR_STORAGE_KEY]: { ...error, at: Date.now() } });
}

async function resolveBrowserId(): Promise<string> {
  const stored = (await chrome.storage.local.get(BROWSER_ID_STORAGE_KEY))[BROWSER_ID_STORAGE_KEY];
  if (typeof stored === "string" && stored.length > 0) return stored;
  const created = `browser-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [BROWSER_ID_STORAGE_KEY]: created });
  return created;
}

async function resolveOrigin(): Promise<string | undefined> {
  const stored = (await chrome.storage.local.get(ORIGIN_STORAGE_KEY))[ORIGIN_STORAGE_KEY];
  return typeof stored === "string" && stored.length > 0 ? stored : undefined;
}

/**
 * Which browser this is.
 *
 * Both Edge and Chrome advertise themselves in the user agent, and the host
 * authorizes each surface separately, so the two are never treated as one.
 */
function detectBrowser(): WebuiBrowserBridgeBrowserName {
  return navigator.userAgent.includes("Edg/") ? "edge" : "chrome";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

chrome.runtime.onStartup.addListener(() => {
  void start();
});

/**
 * The options page asks for a reconnect once the person has pasted the key.
 *
 * The reply tells the page whether the reconnect happened, so the page can say
 * something true rather than "saved" and leave the person wondering.
 */
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { type?: unknown }).type !== RECONNECT_MESSAGE
    ) {
      return undefined;
    }
    void reconnect().then(
      () => sendResponse({ ok: true }),
      (error: unknown) =>
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
    );
    // The reply is asynchronous, so the channel has to stay open.
    return true;
  },
);

void start().catch(report);