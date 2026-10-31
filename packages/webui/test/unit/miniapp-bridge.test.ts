// The Mini App page bridge's host half, and the composer append behind it.
//
// The property the ticket names is negative and easy to lose: declining leaves the
// existing draft untouched. So each refusal case asserts that `writeDraft` was
// never called, not merely that the returned code was a refusal — a handler that
// wrote first and asked afterwards would pass a code-only assertion.
//
// The sender check is the other half. Any window can post to this one, so the
// tests pin that only the framed document on the framed origin is answered, and
// that a view URL which cannot be parsed answers nothing at all.

import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

import {
  webuiMiniAppBridgeAppend,
  webuiMiniAppBridgeRequest,
  webuiMiniAppBridgeSenderAllowed,
  webuiMiniAppDraftWithAppend,
} from "../../src/client/features/miniapp/application/miniapp-bridge.js";
import {
  WEBUI_MINIAPP_BRIDGE_APPEND_REQUEST,
  WEBUI_MINIAPP_COMPOSER_MAX_TEXT_LENGTH,
} from "../../src/shared/contracts/miniapp.js";
import { miniAppPageBridge } from "../../src/server/miniapp/bridge.js";

const VIEW_URL = "http://127.0.0.1:49152";

function frame(): object {
  return { contentWindow: true };
}

describe("reading a bridge request", () => {
  it("accepts the declared request shape and nothing else", () => {
    expect(
      webuiMiniAppBridgeRequest({ type: WEBUI_MINIAPP_BRIDGE_APPEND_REQUEST, requestId: "r-1", text: "hi" }),
    ).toEqual({ requestId: "r-1", text: "hi" });
    expect(webuiMiniAppBridgeRequest({ type: "something-else", requestId: "r-1", text: "hi" })).toBeUndefined();
    expect(webuiMiniAppBridgeRequest({ type: WEBUI_MINIAPP_BRIDGE_APPEND_REQUEST, text: "hi" })).toBeUndefined();
    expect(webuiMiniAppBridgeRequest({ type: WEBUI_MINIAPP_BRIDGE_APPEND_REQUEST, requestId: "r", text: 7 })).toBeUndefined();
    expect(webuiMiniAppBridgeRequest(null)).toBeUndefined();
    expect(webuiMiniAppBridgeRequest("text")).toBeUndefined();
  });
});

describe("the injected page capability list", () => {
  it("reports implemented methods and leaves unsupported native APIs unavailable", () => {
    const window = { mcode: {}, parent: {}, addEventListener: vi.fn() };
    runInNewContext(miniAppPageBridge().script, { window, Map, Math, Date, Promise, Error });
    const has = (window.mcode as { miniapp: { capabilities: { has(name: string): boolean } } })
      .miniapp.capabilities.has;

    expect(has("message.append")).toBe(true);
    expect(has("agent.sessions")).toBe(true);
    expect(has("agent.session")).toBe(true);
    expect(has("agent.observe")).toBe(false);
    expect(has("speech.transcribe")).toBe(false);
    expect(has("window")).toBe(false);
  });
});

describe("the sender check", () => {
  it("answers only the framed window on the framed origin", () => {
    const target = frame();
    expect(
      webuiMiniAppBridgeSenderAllowed({ origin: VIEW_URL, viewUrl: VIEW_URL, source: target, frame: target }),
    ).toBe(true);
    // A second frame, or the page's own window: not the document this view framed.
    expect(
      webuiMiniAppBridgeSenderAllowed({ origin: VIEW_URL, viewUrl: VIEW_URL, source: frame(), frame: target }),
    ).toBe(false);
    // The right window, a foreign origin.
    expect(
      webuiMiniAppBridgeSenderAllowed({
        origin: "https://example.test",
        viewUrl: VIEW_URL,
        source: target,
        frame: target,
      }),
    ).toBe(false);
    // A different port on loopback is a different origin.
    expect(
      webuiMiniAppBridgeSenderAllowed({
        origin: "http://127.0.0.1:49153",
        viewUrl: VIEW_URL,
        source: target,
        frame: target,
      }),
    ).toBe(false);
  });

  it("answers nothing when the view URL cannot be parsed", () => {
    const target = frame();
    expect(
      webuiMiniAppBridgeSenderAllowed({ origin: VIEW_URL, viewUrl: "not a url", source: target, frame: target }),
    ).toBe(false);
  });
});

describe("a confirmed append", () => {
  const request = { requestId: "r-1", text: "从 Mini App 追加" };

  it("appends to the draft the host read, keeping what the person wrote", async () => {
    const writeDraft = vi.fn();
    const confirm = vi.fn(() => true);
    const result = await webuiMiniAppBridgeAppend({
      request,
      sessionId: "session-1",
      pluginName: "Dashboard",
      confirm,
      readDraft: () => "我自己的草稿",
      writeDraft,
    });
    expect(result).toEqual({ success: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(writeDraft).toHaveBeenCalledWith("我自己的草稿\n从 Mini App 追加");
  });

  it("detects the plugin name in the question it asks, so the confirmation names the page", async () => {
    const confirm = vi.fn((_question: string) => false);
    await webuiMiniAppBridgeAppend({
      request,
      sessionId: "session-1",
      pluginName: "Dashboard",
      confirm,
      readDraft: () => "",
      writeDraft: vi.fn(),
    });
    expect(confirm.mock.calls[0]![0]).toContain("Dashboard");
  });

  it("leaves the draft untouched when the person declines", async () => {
    const writeDraft = vi.fn();
    const result = await webuiMiniAppBridgeAppend({
      request,
      sessionId: "session-1",
      pluginName: "Dashboard",
      confirm: () => false,
      readDraft: () => "已有草稿",
      writeDraft,
    });
    expect(result).toEqual({ success: false, code: "user_cancelled" });
    expect(writeDraft).not.toHaveBeenCalled();
  });

  it("refuses text past the contract's bound without asking the person", async () => {
    const writeDraft = vi.fn();
    const confirm = vi.fn(() => true);
    const result = await webuiMiniAppBridgeAppend({
      request: { requestId: "r-2", text: "x".repeat(WEBUI_MINIAPP_COMPOSER_MAX_TEXT_LENGTH + 1) },
      sessionId: "session-1",
      pluginName: "Dashboard",
      confirm,
      readDraft: () => "",
      writeDraft,
    });
    expect(result).toEqual({ success: false, code: "text_too_large" });
    expect(confirm).not.toHaveBeenCalled();
    expect(writeDraft).not.toHaveBeenCalled();
  });

  it("refuses an append with no composer to target", async () => {
    const writeDraft = vi.fn();
    const result = await webuiMiniAppBridgeAppend({
      request,
      pluginName: "Dashboard",
      confirm: () => true,
      readDraft: () => "",
      writeDraft,
    });
    expect(result).toEqual({ success: false, code: "target_unavailable" });
    expect(writeDraft).not.toHaveBeenCalled();
  });

  it("appends after a draft that already ends in a newline without adding a blank line", () => {
    expect(webuiMiniAppDraftWithAppend("", "x")).toBe("x");
    expect(webuiMiniAppDraftWithAppend("a", "x")).toBe("a\nx");
    expect(webuiMiniAppDraftWithAppend("a\n", "x")).toBe("a\nx");
  });
});
