import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { WebuiClientFoundationApp } from "./components/WebuiClientFoundationApp.js";
export { WebuiSessionList } from "./components/SessionRail.js";
export { WebuiSessionTranscript } from "./components/SessionTranscript.js";
export {
  WebuiClientFoundationApp,
  subscribeToSessionHash,
} from "./components/WebuiClientFoundationApp.js";
import { createWebuiTransport } from "./infrastructure/transport.js";
import { route } from "./router.js";
import { NotFound } from "./components/NotFound.js";
import { ArchonPage } from "./components/ArchonPage.js";
import { WebuiErrorBoundary } from "./components/WebuiErrorBoundary.js";
import { WebuiStartupFallback } from "./components/StartupFallback.js";

declare const document: {
  getElementById(elementId: string): HTMLElement | null;
  createElement(tagName: string): HTMLElement;
  readonly body: HTMLElement;
};
declare const location: { readonly host: string; readonly pathname: string; readonly hash: string; href: string; reload(): void };

const rootElement = document.getElementById("webui-root");
interface WebuiRuntimeConfig {
  websocketUrl: string;
  token: string;
  dataDir?: string;
}
const config = (
  globalThis as unknown as { __WEBUI_CONFIG__?: WebuiRuntimeConfig }
).__WEBUI_CONFIG__;

if (!rootElement || !config) {
  // Boot failures before this point used to be bare `throw`s, and the error
  // boundary cannot catch them: it lives inside the render that never
  // started, so a missing mount node or a missing runtime config left a
  // white page. Render the startup surface instead — into #webui-root when
  // the node exists (missing config), or a fresh node on body when even the
  // mount point is gone (torn-down or tampered document).
  const host =
    rootElement ?? document.body.appendChild(document.createElement("div"));
  createRoot(host).render(
    <WebuiStartupFallback
      reason={
        !rootElement
          ? "WebUI mount node #webui-root is missing"
          : "WebUI runtime configuration is missing (__WEBUI_CONFIG__)"
      }
      detail={
        !rootElement
          ? "页面结构加载不完整，可能是资源加载被中断或页面版本不匹配。"
          : "页面没有拿到启动所需的连接配置，通常是服务端启动异常。"
      }
      onReload={() => location.reload()}
    />,
  );
} else {
const runtimeConfig = config;
const transport = createWebuiTransport(runtimeConfig);
const sessionId = new URLSearchParams(location.hash.replace(/^#/u, "")).get("session") ?? undefined;
const root: Root = createRoot(rootElement);
// W2.5: pass the transport ONCE here so the React effect dependency
// identity is stable across renders. Each method is still optional
// on `WebuiTransport`, so the panel branches continue to gate on
// `transport?.X` just like they used to gate on `X`.
const app = <WebuiClientFoundationApp
    label="webui-foundation"
    hostLabel={location.host}
    dataDir={runtimeConfig.dataDir}
    transport={transport}
  />;
const currentRoute = route(location.pathname);
root.render(
  // The boundary wraps the app, not the 404: a 404 is a legitimate render and
  // must not offer a "retry" that reloads the same missing path.
  currentRoute === "404" ? <NotFound /> : <WebuiErrorBoundary><ArchonPage>{app}</ArchonPage></WebuiErrorBoundary>,
);
}
