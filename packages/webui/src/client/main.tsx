import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { WebuiClientFoundationApp } from "./components/shell/WebuiClientFoundationApp.js";
export { WebuiSessionList } from "./components/sessions/SessionRail.js";
export { WebuiSessionTranscript } from "./components/transcript/SessionTranscript.js";
export {
  WebuiClientFoundationApp,
} from "./components/shell/WebuiClientFoundationApp.js";
export { subscribeToSessionHash } from "./bindings/navigation.js";
import { createWebuiTransport } from "./infrastructure/transport.js";
import { route } from "./projection/common/router.js";
import { NotFound } from "./components/shell/NotFound.js";
import { ArchonPage } from "./components/shell/ArchonPage.js";
import { WebuiErrorBoundary } from "./components/shell/WebuiErrorBoundary.js";
import { WebuiStartupFallback } from "./components/shell/StartupFallback.js";
import { WebuiBrowserCapabilitiesProvider, useWebuiBrowserCapabilities } from "./bindings/browser-capabilities.js";
import { createWebuiBrowserDom } from "./infrastructure/browser-dom.js";
import {
  createWebuiBrowserStorage,
  getWebuiBrowserStorage,
} from "./infrastructure/storage.js";
import { createWebuiApplication } from "./application/create-application.js";
import { createWebuiComposerStore } from "./application/composer/composer-store.js";
import { createWebuiEventEffectsRegistry } from "./application/turn/event-effects-registry.js";
import { createWebuiPortSlices } from "./application/port-slices.js";
import { createWebuiOpenEventChannel } from "./bindings/event-channel-adapter.js";
import { WebuiApplicationProvider } from "./bindings/application-context.js";
import { WebuiEventEffectsRegistryProvider } from "./bindings/event-effects-context.js";
import { WebuiPortSlicesProvider } from "./bindings/port-slices-context.js";

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

/**
 * The composition root (plan §8 Phase 2, A4-s2).
 *
 * It builds the one application for the page — the store, the event coordinator
 * and the single `watchEvents` channel — cuts the per-business port slices from
 * the transport, and provides them through the owner contexts. The shell below
 * adopts the instance rather than building its own, so a page has one store and
 * one channel instead of two.
 *
 * The transport stays at module scope and arrives as a prop: it is IO for the
 * page, it is constructed once, and its identity has to be stable across renders
 * (W2.5). The application is constructed per mount and disposed on unmount, so a
 * remount cannot leave a second channel open.
 */
function WebuiClientRoot({
  transport,
  dataDir,
}: {
  readonly transport: ReturnType<typeof createWebuiTransport>;
  readonly dataDir?: string;
}): JSX.Element {
  const effectsRegistry = React.useMemo(
    () => createWebuiEventEffectsRegistry(),
    [],
  );
  // The same storage adapter the shell would have built for its own composer
  // store. The application layer may not import infrastructure, so the
  // composition root injects it — without this the adopted composer store has
  // no storage at all and every draft dies with the page (regression from
  // e40a63f: the root stopped handing the shell a store to build, and the
  // application's own default is storage-less by design).
  const { storage } = useWebuiBrowserCapabilities();
  const composerStore = React.useMemo(
    () => createWebuiComposerStore({ storage }),
    [storage],
  );
  const slices = React.useMemo(
    () => createWebuiPortSlices(transport),
    [transport],
  );
  const application = React.useMemo(
    () =>
      createWebuiApplication({
        // The live ingress: the transport's `watchEvents` watcher, adapted to
        // the application channel shape.
        openEventChannel: transport.watchEvents
          ? createWebuiOpenEventChannel(transport.watchEvents)
          : () => ({ subscribe: () => () => undefined }),
        // The registry is the initial registration. The shell below composes its
        // own view reactions on top and registers them through
        // `setEventEffects`, because it renders after this instance exists.
        effects: effectsRegistry.asWebuiEventEffects(),
        composer: composerStore,
        turns: {
          resumeSession: transport.resumeSession ?? (async () => {}),
          ...(transport.loadMessages
            ? { loadMessages: transport.loadMessages }
            : {}),
        },
        turnCapabilities: transport,
        ...(transport.loadMessages
          ? { loadMessages: transport.loadMessages }
          : {}),
      }),
    [composerStore, effectsRegistry, transport],
  );
  React.useEffect(() => () => application.dispose(), [application]);

  return (
    <WebuiEventEffectsRegistryProvider registry={effectsRegistry}>
      <WebuiApplicationProvider application={application}>
        <WebuiPortSlicesProvider slices={slices}>
          <WebuiClientFoundationApp
            label="webui-foundation"
            hostLabel={location.host}
            dataDir={dataDir}
            transport={transport}
          />
        </WebuiPortSlicesProvider>
      </WebuiApplicationProvider>
    </WebuiEventEffectsRegistryProvider>
  );
}

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
const browserCapabilities = {
  dom: createWebuiBrowserDom(globalThis.document, globalThis.window),
  storage: createWebuiBrowserStorage(getWebuiBrowserStorage()),
};
// W2.5: pass the transport ONCE here so the React effect dependency
// identity is stable across renders. Each method is still optional
// on `WebuiTransport`, so the panel branches continue to gate on
// `transport?.X` just like they used to gate on `X`.
//
// The transport is the module-scope instance; the application, its store and
// the port slices are built by the root below, once per mount, and provided to
// the shell (plan §8 Phase 2, A4-s2).
const app = <WebuiClientRoot transport={transport} dataDir={runtimeConfig.dataDir} />;
const currentRoute = route(location.pathname);
root.render(
  // The boundary wraps the app, not the 404: a 404 is a legitimate render and
  // must not offer a "retry" that reloads the same missing path.
  currentRoute === "404" ? <NotFound /> : <WebuiBrowserCapabilitiesProvider value={browserCapabilities}><WebuiErrorBoundary><ArchonPage>{app}</ArchonPage></WebuiErrorBoundary></WebuiBrowserCapabilitiesProvider>,
);
}
