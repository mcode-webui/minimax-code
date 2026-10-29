// The page half of the Mini App bridge, served by the proxy.
//
// A Mini App page reaches its host through `window.mcode.miniapp.*`. On the
// desktop client that namespace comes from an Electron preload; a browser tab
// cannot install one, so the proxy injects a script and this module is it. The
// namespace mirrors the shipped preload's composer method
// (`app/dist/main/modules/browser/miniapp-preload.js`): `message.append(text)`
// resolves on a confirmed append and rejects with the failure code — the same
// codes, because a page written against the desktop client must not see a
// different vocabulary here.
//
// The page half knows no identity. It cannot name a session or a plugin: the
// host supplies both from the view it framed, so the most a page can ask for is
// "append this to whoever is hosting me".
//
// `postMessage` needs a target origin, and the page does not know the client's
// origin — so it posts to `*` and the *host* is what refuses a foreign sender.
// That direction is deliberate: the check belongs where the trusted side is, and
// the payload the page can reach is a bounded string that a person confirms.

import {
  WEBUI_MINIAPP_BRIDGE_APPEND_REPLY,
  WEBUI_MINIAPP_BRIDGE_APPEND_REQUEST,
  WEBUI_MINIAPP_BRIDGE_PATH,
  WEBUI_MINIAPP_COMPOSER_MAX_TEXT_LENGTH,
} from "../../shared/contracts/miniapp.js";
import {
  WEBUI_MINIAPP_BRIDGE_AGENT_EVENT,
  WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST,
  WEBUI_MINIAPP_BRIDGE_AGENT_RESULT,
} from "../../shared/contracts/miniapp-agent.js";
import type { MiniAppPageBridge } from "./proxy.js";

/**
 * The script the proxy serves at `WEBUI_MINIAPP_BRIDGE_PATH`.
 *
 * A string rather than a file: the proxy injects it into a document, and a
 * bundler that resolved it as a module would give it a module's scope instead of
 * the page's. Written out once, so the path the tag names and the body it serves
 * cannot disagree.
 */
const SCRIPT = `(function () {
  "use strict";
  var REQUEST = ${JSON.stringify(WEBUI_MINIAPP_BRIDGE_APPEND_REQUEST)};
  var REPLY = ${JSON.stringify(WEBUI_MINIAPP_BRIDGE_APPEND_REPLY)};
  var MAX_TEXT = ${WEBUI_MINIAPP_COMPOSER_MAX_TEXT_LENGTH};
  var sequence = 0;
  var pending = new Map();
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.type !== REPLY) return;
    if (typeof data.requestId !== "string") return;
    var settle = pending.get(data.requestId);
    if (!settle) return;
    pending.delete(data.requestId);
    settle(data.result);
  });
  function append(text) {
    return new Promise(function (resolve, reject) {
      if (typeof text !== "string") {
        reject(new Error("invalid_request"));
        return;
      }
      if (text.length > MAX_TEXT) {
        reject(new Error("text_too_large"));
        return;
      }
      sequence += 1;
      var requestId = "miniapp-" + Date.now().toString(36) + "-" + sequence;
      pending.set(requestId, function (result) {
        if (result && result.success === true) {
          resolve();
          return;
        }
        reject(new Error(result && result.code ? result.code : "result_unknown"));
      });
      window.parent.postMessage({ type: REQUEST, requestId: requestId, text: text }, "*");
    });
  }
  var mcode = (window.mcode = window.mcode || {});
  mcode.miniapp = mcode.miniapp || {};
  var capabilities = [
    "message.append",
    "agent.run",
    "agent.open",
    "agent.models",
    "agent.agents",
    "agent.create",
    "agent.sessions",
    "agent.session"
  ];
  mcode.miniapp.capabilities = mcode.miniapp.capabilities || {};
  mcode.miniapp.capabilities.has = function (name) {
    return typeof name === "string" && capabilities.indexOf(name) !== -1;
  };
  mcode.miniapp.message = mcode.miniapp.message || {};
  mcode.miniapp.message.append = append;
  // ---------------------------------------------------------------------
  // The agent block: window.mcode.miniapp.agent.
  //
  // Same namespace as the shipped preload, so a page written against the
  // desktop client finds every method here. What changes is the transport: a
  // browser page cannot call a preload, so each call is one postMessage and the
  // client that framed the page answers it. Identity never travels from here —
  // the page names content and a correlation id, nothing else.
  //
  // cancel names a live request instead of dropping a promise: an abort signal
  // cannot cross postMessage, so the page asks the host to stop that request and
  // the answer is the request's own settlement.
  // ---------------------------------------------------------------------
  var AGENT_REQUEST = ${JSON.stringify(WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST)};
  var AGENT_RESULT = ${JSON.stringify(WEBUI_MINIAPP_BRIDGE_AGENT_RESULT)};
  var AGENT_EVENT = ${JSON.stringify(WEBUI_MINIAPP_BRIDGE_AGENT_EVENT)};
  var agentPrefix = Math.random().toString(36).slice(2, 10);
  var agentSequence = 0;
  var agentPending = new Map();
  function agentSettle(requestId, result) {
    var entry = agentPending.get(requestId);
    if (!entry) return;
    agentPending.delete(requestId);
    if (result && result.ok === true) {
      entry.resolve(result.value);
      return;
    }
    var code = result && typeof result.code === "string" ? result.code : "result_unknown";
    var error = new Error(code);
    if (result && typeof result.reason === "string") error.reason = result.reason;
    entry.reject(error);
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.type === AGENT_RESULT) {
      if (typeof data.requestId === "string") agentSettle(data.requestId, data.result);
      return;
    }
    if (data.type === AGENT_EVENT) {
      if (typeof data.requestId !== "string") return;
      var entry = agentPending.get(data.requestId);
      if (!entry || typeof entry.onEvent !== "function") return;
      try {
        entry.onEvent(data.event);
      } catch (ignored) {
        // A page callback that throws must not end the turn or the stream.
      }
    }
  });
  function agentRequest(method, payload, options) {
    return new Promise(function (resolve, reject) {
      var onEvent = options && typeof options.onEvent === "function" ? options.onEvent : undefined;
      var requestId =
        payload && typeof payload.requestId === "string" && payload.requestId
          ? payload.requestId
          : agentPrefix + "-" + (++agentSequence);
      if (agentPending.has(requestId)) {
        reject(new Error("busy"));
        return;
      }
      agentPending.set(requestId, { resolve: resolve, reject: reject, onEvent: onEvent });
      // Every field travels: a reply's own requestId is the permission ask it
      // answers, and stripping it would leave the host with nothing to decide.
      var body = {};
      if (payload && typeof payload === "object") {
        for (var key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) body[key] = payload[key];
        }
      }
      try {
        window.parent.postMessage(
          {
            type: AGENT_REQUEST,
            requestId: requestId,
            method: method,
            payload: body,
            observe: onEvent !== undefined
          },
          "*"
        );
      } catch (error) {
        agentPending.delete(requestId);
        reject(new Error("result_unknown"));
      }
    });
  }
  mcode.miniapp.agent = {
    run: function (input, options) {
      return agentRequest("run", input, options);
    },
    answer: function (input, options) {
      return agentRequest("answer", input, options);
    },
    reply: function (input) {
      return agentRequest("reply", input);
    },
    open: function (sessionId) {
      return agentRequest("open", { sessionId: sessionId });
    },
    models: function () {
      return agentRequest("models", {});
    },
    agents: function () {
      return agentRequest("agents", {});
    },
    sessions: function () {
      return agentRequest("sessions", {});
    },
    session: function (sessionId) {
      return agentRequest("session", sessionId === undefined ? {} : { sessionId: sessionId });
    },
    create: function (input) {
      return agentRequest("create", input);
    },
    cancel: function (requestId) {
      if (typeof requestId !== "string" || !agentPending.has(requestId)) return;
      try {
        window.parent.postMessage(
          { type: AGENT_REQUEST, requestId: requestId, method: "cancel", payload: {}, observe: false },
          "*"
        );
      } catch (ignored) {
        // The document is going away; there is nothing left to cancel.
      }
    }
  };
})();
`;

/** The bridge the proxy injects into every document it serves. */
export function miniAppPageBridge(): MiniAppPageBridge {
  return { path: WEBUI_MINIAPP_BRIDGE_PATH, script: SCRIPT };
}
