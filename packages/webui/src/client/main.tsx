import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { WebuiClientFoundationApp } from "./shell/WebuiClientFoundationApp.js";
// The composition root may read the platform layer; the shell and the rail may
// not, so the label is resolved here and injected.
import { teamModeCopy } from "./platform/team-mode.js";
export { WebuiSessionTranscript } from "./features/transcript/ui/SessionTranscript.js";
export {
  WebuiClientFoundationApp,
} from "./shell/WebuiClientFoundationApp.js";
export { subscribeToSessionHash } from "./bindings/navigation.js";
import { createWebuiTransport } from "./platform/transport.js";
import { importWebuiSessionFile } from "./platform/session-import.js";
import { startWebuiSessionTransferDownload } from "./platform/session-transfer-download.js";
import { route, miniAppDeepLink, type WebuiMiniAppDeepLink } from "./projection/common/router.js";
import { NotFound } from "./shell/NotFound.js";
import { ArchonPage } from "./shell/ArchonPage.js";
import { WebuiErrorBoundary } from "./shell/WebuiErrorBoundary.js";
import { WebuiStartupFallback } from "./shell/StartupFallback.js";
import { WebuiBrowserCapabilitiesProvider } from "./bindings/browser-capabilities.js";
import { createWebuiBrowserDom } from "./platform/browser-dom.js";
import { MiniAppStandalone } from "./features/miniapp/ui/MiniAppStandalone.public.js";
import { WebuiMiniAppWorkflowsProvider } from "./features/miniapp/bindings/use-miniapp-workflows.js";
import {
  createWebuiBrowserStorage,
  getWebuiBrowserStorage,
} from "./platform/storage.js";
import { createWebuiApplication } from "./application/create-application.js";
import { readWebuiAppMode } from "./platform/app-mode.js";
import {
  diagnoseWebuiStartup,
  type WebuiStartupDiagnosis,
} from "./platform/startup-diagnosis.js";
import { readWebuiBrowserAutoOpen } from "./platform/browser-auto-open.js";
import { createWebuiComposerStore } from "./features/composer/application/composer-store.js";
import { createWebuiPortSlices } from "./application/port-slices.js";
import { createWebuiOpenEventChannel } from "./bindings/event-channel-adapter.js";
import { WebuiApplicationProvider } from "./bindings/application-context.js";
import { WebuiPortSlicesProvider } from "./bindings/port-slices-context.js";
// The overlay coordinator is provided once per client document, here at the
// composition root, so every surface in either shell registers with the same
// one (ADR 0028 § Overlay coordination).
import { OverlayCoordinatorProvider } from "./ui/overlay-coordinator.js";
import { OverlayListenerHost } from "./ui/overlay-listeners.js";
// The toast queue is provided once per client document, here at the composition
// root, and its host is mounted beside the app: a notice is drawn against the
// viewport, so it takes no room from the page it is about.
import { WebuiToastHost, WebuiToastProvider } from "./ui/toast.js";
import { WEBUI_PROTOCOL_VERSION, WebuiWireError, WebuiErrorCode } from "../shared/envelope.js";

declare const document: {
  getElementById(elementId: string): HTMLElement | null;
  createElement(tagName: string): HTMLElement;
  readonly body: HTMLElement;
};
declare const location: { readonly host: string; readonly pathname: string; readonly search: string; readonly hash: string; href: string; reload(): void };

const WEBUI_STALL_DIAGNOSTIC_PREFIX = "[WEBUI-STALL-DIAG]";

function installWebuiStallDiagnostics(): void {
  const startedAt = performance.now();
  const bootKey = "webui:stall-diagnostic-boot";
  const now = Date.now();
  let bootCount = 1;
  try {
    const previous = JSON.parse(sessionStorage.getItem(bootKey) ?? "null") as
      | { readonly startedAt?: number; readonly count?: number }
      | null;
    if (previous?.startedAt && now - previous.startedAt < 60_000) {
      bootCount = (previous.count ?? 0) + 1;
    }
    sessionStorage.setItem(
      bootKey,
      JSON.stringify({ startedAt: bootCount === 1 ? now : previous?.startedAt, count: bootCount }),
    );
  } catch {
    // Diagnostics must not make startup depend on browser storage availability.
  }

  console.info(`${WEBUI_STALL_DIAGNOSTIC_PREFIX} boot`, {
    bootCountIn60s: bootCount,
    hasSessionRoute: new URLSearchParams(location.hash.replace(/^#/u, "")).has("session"),
    online: navigator.onLine,
  });
  if (bootCount >= 3) {
    console.warn(`${WEBUI_STALL_DIAGNOSTIC_PREFIX} repeated-document-start`, {
      bootCountIn60s: bootCount,
    });
  }

  window.addEventListener("error", (event) => {
    console.error(`${WEBUI_STALL_DIAGNOSTIC_PREFIX} window-error`, {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error(`${WEBUI_STALL_DIAGNOSTIC_PREFIX} unhandled-rejection`, event.reason);
  });

  if (
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("longtask")
  ) {
    let lastLongTaskLogAt = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 250 || entry.startTime - lastLongTaskLogAt < 5_000) continue;
        lastLongTaskLogAt = entry.startTime;
        console.warn(`${WEBUI_STALL_DIAGNOSTIC_PREFIX} long-task`, {
          durationMs: Math.round(entry.duration),
          pageAgeMs: Math.max(0, Math.round(entry.startTime - startedAt)),
        });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  }

  let previousTick = startedAt;
  let lastEventLoopStallLogAt = startedAt;
  window.setInterval(() => {
    const tick = performance.now();
    const delayMs = tick - previousTick - 1_000;
    previousTick = tick;
    if (delayMs >= 1_500 && tick - lastEventLoopStallLogAt >= 5_000) {
      lastEventLoopStallLogAt = tick;
      console.warn(`${WEBUI_STALL_DIAGNOSTIC_PREFIX} event-loop-stall`, {
        delayMs: Math.round(delayMs),
        pageAgeMs: Math.round(tick - startedAt),
      });
    }
  }, 1_000);
}

installWebuiStallDiagnostics();

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
 * The composition root.
 *
 * It builds the one application for the page — the store, the event coordinator
 * and the single `watchEvents` channel — cuts the per-business port slices from
 * the transport, and provides them through the owner contexts. The shell below
 * adopts the instance rather than building its own, so a page has one store and
 * one channel instead of two.
 *
 * The transport stays at module scope and arrives as a prop: it is IO for the
 * page, it is constructed once, and its identity has to be stable across renders.
 * The application is constructed per mount and disposed on unmount, so a
 * remount cannot leave a second channel open.
 */
function WebuiClientRoot({
  transport,
  dataDir,
  storage,
  initialSessionId,
  standalone,
}: {
  readonly transport: ReturnType<typeof createWebuiTransport>;
  readonly dataDir?: string;
  readonly storage: ReturnType<typeof createWebuiBrowserStorage>;
  /** The session the initial route names, parsed from the hash by the entry. */
  readonly initialSessionId?: string;
  /**
   * The standalone Mini App this document is, when the route says so.
   *
   * Present only for `/miniapp?plugin=` with an optional `session`. The shell mounts one
   * published surface instead of the workspace: ADR 0020's standalone
   * presentation is the same client with a different composition, not a second
   * application.
   */
  readonly standalone?: WebuiMiniAppDeepLink;
}): JSX.Element {
  const slices = React.useMemo(
    () => createWebuiPortSlices(transport),
    [transport],
  );
  const composer = React.useMemo(
    () => createWebuiComposerStore({ storage }),
    [storage],
  );
  const application = React.useMemo(
    () =>
      createWebuiApplication({
        // The live ingress: the transport's `watchEvents` watcher, adapted to
        // the application channel shape. It is opened by `start` below, not
        // here: construction stays dormant so an SSR-shaped or test render can
        // build the same assembly without touching the network.
        openEventChannel: transport.watchEvents
          ? createWebuiOpenEventChannel(transport.watchEvents)
          : () => ({ subscribe: () => () => undefined }),
        // The goal capability: the application owns the goal owner, so an event
        // route commits for any session, mounted or not.
        goalPort: slices.goal,
        interactionsPort: slices.interactions,
        // The persisted "no project" choice the new-task workspace reads and
        // writes. The use case owns the decision and the host owns the storage.
        workspacePreference: {
          readNoProjectFlag: storage.readNoProjectFlag,
          writeNoProjectFlag: storage.writeNoProjectFlag,
        },
        // The application mode chosen in 设置 › 通用 › 模式. Read at session
        // creation, where the runtime resolves it; the host owns the storage and
        // the application may not read it itself.
        appModePreference: { read: readWebuiAppMode },
        browserAutoOpen: { read: readWebuiBrowserAutoOpen },
        // The port slices this root cut above. The assembly builds every
        // business owner from them, so the shell composes screens instead of
        // constructing owners.
        slices,
        // The session-file import the session workflows submit through: the
        // application layer may not reach into `platform/` itself.
        sessionImport: importWebuiSessionFile,
        // The session-file export the session workflows submit through: the
        // navigation is platform IO, and the rail may not reach into
        // `platform/` itself.
        sessionExport: startWebuiSessionTransferDownload,
        turns: {
          resumeSession: transport.resumeSession ?? (async () => {}),
          ...(transport.loadMessages
            ? { loadMessages: transport.loadMessages }
            : {}),
        },
        turnCapabilities: transport,
        // The review families' capabilities. The application owns both owners,
        // so a surface reads a turn's diff through the application rather
        // than holding the transport.
        turnReview: {
          ...(transport.getTurnDiff ? { getTurnDiff: transport.getTurnDiff } : {}),
          ...(transport.revertTurnDiff ? { revertTurnDiff: transport.revertTurnDiff } : {}),
          ...(transport.reapplyTurnDiff ? { reapplyTurnDiff: transport.reapplyTurnDiff } : {}),
        },
        ...(transport.loadMessages
          ? { loadMessages: transport.loadMessages }
          : {}),
        composer,
      }),
    [composer, transport, storage],
  );
  // One lifecycle per mount: start once, dispose only when this instance is
  // replaced or the root unmounts. The initial route is read through a ref
  // because it is the *initial* route — a later hash change selects through the
  // shell, it does not restart the application.
  const initialSessionIdRef = React.useRef(initialSessionId);
  React.useEffect(() => {
    application.start({ initialSessionId: initialSessionIdRef.current });
    return () => application.dispose();
  }, [application]);

  return (
    <OverlayCoordinatorProvider>
      {/* The one document listener for every managed layer (#289). It renders
        * nothing; the coordinator decides and the layers answer. */}
      <OverlayListenerHost />
      <WebuiApplicationProvider application={application}>
        <WebuiPortSlicesProvider slices={slices}>
          {standalone ? (
            // ADR 0020's standalone presentation: one published surface, the same
            // owner and the same port slices, and none of the workspace.
            <WebuiMiniAppWorkflowsProvider workflows={application.miniAppWorkflows}>
              <MiniAppStandalone
                pluginId={standalone.pluginId}
                sessionId={standalone.sessionId}
              />
            </WebuiMiniAppWorkflowsProvider>
          ) : (
          <WebuiClientFoundationApp
          teamModeLabel={teamModeCopy().label}
            label="webui-foundation"
            dataDir={dataDir}
          />
          )}
        </WebuiPortSlicesProvider>
      </WebuiApplicationProvider>
    </OverlayCoordinatorProvider>
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
  // The runtime's data directory is a fact about this host: the composition
  // root is the one place that may read the injected config, and the surfaces
  // that need it read it from the capabilities.
  ...(runtimeConfig.dataDir ? { dataDir: runtimeConfig.dataDir } : {}),
};
// The route decides which composition this document is. A standalone Mini App is
// the same client with a different shell, so it reads its plugin and session from
// the query and selects nothing: the page shows one Mini App and no conversation.
const currentRoute = route(location.pathname);
const standalone = currentRoute === "miniapp" ? miniAppDeepLink(location.search) : undefined;
// Pass the transport ONCE here so the React effect dependency
// identity is stable across renders. Each method is still optional
// on `WebuiTransport`, so the panel branches continue to gate on
// `transport?.X` just like they used to gate on `X`.
//
// The transport is the module-scope instance; the application, its store and
// the port slices are built by the root below, once per mount, and provided to
// the shell.
const app = <WebuiClientRoot
  transport={transport}
  dataDir={runtimeConfig.dataDir}
  storage={browserCapabilities.storage}
  {...(standalone ? { standalone } : { initialSessionId: sessionId })}
/>;
/**
 * A route that resolved to nothing.
 *
 * Two cases: a path this client does not serve, and the standalone route without
 * the required plugin. Both are legitimate renders, and neither
 * is an application failure to retry.
 */
const unresolved = currentRoute === "404" || (currentRoute === "miniapp" && !standalone);
const renderApplication = (): void => root.render(
  unresolved ? <NotFound /> : (
    <WebuiBrowserCapabilitiesProvider value={browserCapabilities}>
      <WebuiToastProvider>
        <WebuiErrorBoundary>
          <ArchonPage>{app}</ArchonPage>
        </WebuiErrorBoundary>
        {/* The host is a sibling of the app, not a child of it: it portals into
          the document body and is drawn against the viewport. */}
        <WebuiToastHost />
      </WebuiToastProvider>
    </WebuiBrowserCapabilitiesProvider>
  ),
);
if (unresolved) renderApplication();
else void transport.version().then((version) => {
  if (version.protocolVersion !== WEBUI_PROTOCOL_VERSION) {
    throw new WebuiWireError(WebuiErrorCode.protocolMismatch,
      `WebUI protocol ${version.protocolVersion} is incompatible with client protocol ${WEBUI_PROTOCOL_VERSION}`);
  }
  renderApplication();
}).catch((reason: unknown) => {
  void reportStartupFailure(runtimeConfig, reason, root);
});
}

/**
 * Say what the failed startup actually was.
 *
 * The page's only channel is the WebSocket, so a refusal leaves the browser
 * with one sentence that fits every cause. One HTTP request separates the
 * three that matter, and the surface then names the one that applies — a
 * person on another machine cannot see the service's log, and "页面与服务未能
 * 建立兼容连接" sends them nowhere.
 */
async function reportStartupFailure(
  config: WebuiRuntimeConfig,
  reason: unknown,
  root: Root,
): Promise<void> {
  const diagnosis = await diagnoseWebuiStartup({
    websocketUrl: config.websocketUrl,
    token: config.token,
  });
  const technical = reason instanceof Error ? reason.message : String(reason);
  console.warn(`${WEBUI_STALL_DIAGNOSTIC_PREFIX} startup-failure`, {
    diagnosis,
    reason: technical,
  });
  root.render(
    <WebuiStartupFallback
      reason={`${technical} (${diagnosis})`}
      detail={startupFailureDetail(diagnosis)}
      onReload={() => location.reload()}
    />,
  );
}

/**
 * The sentence that says what to do about the diagnosis.
 */
function startupFailureDetail(diagnosis: WebuiStartupDiagnosis): string {
  switch (diagnosis) {
    case "credential_rejected":
      return "服务可达，但这个地址里的访问凭证（token）已失效，通常是服务重启过。请从服务启动日志里复制带 token 的新地址重新打开。";
    case "service_reachable":
      return "服务可达，但 WebSocket 握手被拒绝。请检查中间代理或防火墙是否放通 WebSocket 升级请求，以及页面来源（Origin）是否与服务地址一致。";
    default:
      return "连不上服务。请确认地址、端口与网络是否可达；内网访问时确认防火墙放通了该端口。";
  }
}
