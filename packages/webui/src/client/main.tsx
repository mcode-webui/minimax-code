import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { WebuiClientFoundationApp } from "./components/WebuiClientFoundationApp.js";
export { WebuiSessionList } from "./components/SessionRail.js";
export { WebuiSessionTranscript } from "./components/SessionTranscript.js";
export {
  WebuiClientFoundationApp,
  subscribeToSessionHash,
} from "./components/WebuiClientFoundationApp.js";
import { createWebuiTransport } from "./transport.js";
import { route } from "./router.js";
import { NotFound } from "./components/NotFound.js";
import { ArchonPage } from "./components/ArchonPage.js";
import { WebuiErrorBoundary } from "./components/WebuiErrorBoundary.js";

declare const document: {
  getElementById(elementId: string): HTMLElement | null;
};
declare const location: { readonly host: string; readonly pathname: string; readonly hash: string; href: string };

const rootElement = document.getElementById("webui-root");
if (!rootElement) throw new Error("WebUI mount node #webui-root is missing");
interface WebuiRuntimeConfig {
  websocketUrl: string;
  token: string;
  dataDir?: string;
}
const config = (
  globalThis as unknown as { __WEBUI_CONFIG__?: WebuiRuntimeConfig }
).__WEBUI_CONFIG__;
if (!config) throw new Error("WebUI runtime configuration is missing");
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
