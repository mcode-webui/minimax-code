// The extension's options page: where the person pastes the installation key.
//
// The installation key is the one secret in this protocol that a local process
// cannot reach, because it only ever exists in this browser's
// `chrome.storage.local` and in the host's OS secure store. The person moves it
// across by hand, once per browser.
//
// Two rules this page holds to:
//
//   * The key is **write-only** after the first save. The page reads the stored
//     key through `webuiBrowserBridgeInstallationKeyStatus`, whose return type
//     carries a fingerprint and no key, so there is no code path here that
//     could render it — the field is cleared on save as well, so it is not
//     sitting in the DOM either.
//   * Nothing is written until the paste validates as exactly 32 bytes. A
//     truncated paste would otherwise be stored and then fail at handshake
//     time as an opaque "installation key does not match".

import { WEBUI_BROWSER_BRIDGE_RECONNECT_MESSAGE } from "./protocol.js";
import {
  clearWebuiBrowserBridgeInstallationKey,
  saveWebuiBrowserBridgeInstallationKey,
  webuiBrowserBridgeInstallationKeyStore,
  webuiBrowserBridgeInstallationKeyStatus,
} from "./pairing.js";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`options page is missing #${id}`);
  return found as T;
}

const input = element<HTMLInputElement>("installation-key");
const save = element<HTMLButtonElement>("save");
const clear = element<HTMLButtonElement>("clear");
const status = element<HTMLParagraphElement>("status");
const stored = element<HTMLParagraphElement>("stored");

function say(message: string): void {
  status.textContent = message;
}

/** Render what is stored — a fingerprint, never the key. */
async function renderStored(): Promise<void> {
  const state = await webuiBrowserBridgeInstallationKeyStatus(
    webuiBrowserBridgeInstallationKeyStore(chrome.storage.local),
  );
  clear.disabled = !state.stored;
  stored.textContent = state.stored
    ? `An installation key is stored (fingerprint ${state.fingerprint}).`
    : "No installation key is stored in this browser yet.";
}

async function onSave(): Promise<void> {
  try {
    await saveWebuiBrowserBridgeInstallationKey(
      webuiBrowserBridgeInstallationKeyStore(chrome.storage.local),
      input.value,
    );
  } catch (error) {
    say(error instanceof Error ? error.message : "the installation key was not saved");
    return;
  }
  // Clear the field immediately: the key is in storage, and leaving it in the
  // DOM is the one place this page could leak it.
  input.value = "";
  await renderStored();

  // Wake the worker so the extension pairs now.
  //
  // A Manifest V3 service worker is lazy: it starts on an event and is torn
  // down when it goes idle. Saving the key does not wake it, so without this
  // the extension would sit there configured but unconnected — and the person
  // would have to reload the extension by hand to find out.
  try {
    const reply = await chrome.runtime.sendMessage({ type: WEBUI_BROWSER_BRIDGE_RECONNECT_MESSAGE });
    if (reply && typeof reply === "object" && (reply as { ok?: unknown }).ok === true) {
      say("Saved. Connecting to the WebUI…");
      return;
    }
    say(
      "Saved. The extension could not be woken to connect — reload the extension and try again.",
    );
  } catch {
    say("Saved. The extension could not be woken to connect — reload the extension and try again.");
  }
}

async function onClear(): Promise<void> {
  await clearWebuiBrowserBridgeInstallationKey(
    webuiBrowserBridgeInstallationKeyStore(chrome.storage.local),
  );
  input.value = "";
  say("Cleared. Paste the key again to pair this browser.");
  await renderStored();
}

save.addEventListener("click", () => {
  void onSave();
});
clear.addEventListener("click", () => {
  void onClear();
});
void renderStored();