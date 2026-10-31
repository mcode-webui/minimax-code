// The Mini App proxies the WebUI service owns.
//
// One listener per plugin, and this is where they live. Two properties make it a
// registry rather than a local map in the operation handler:
//
//   * **A listener outlives a request.** `openMiniApp` binds one, `stopMiniApp`
//     closes it, and a service that shuts down while a Mini App is still running
//     has to close it too — otherwise the process exits holding loopback ports
//     that a restart then fails to rebind (the plugin's derived port is stable on
//     purpose, ADR 0020, so a leaked listener is a *permanent* failure to start).
//   * **The port is derived, so a second listener is never acceptable.** Binding
//     it twice either fails or silently serves the page from a second origin,
//     which discards the page's own storage. The registry closes the previous
//     listener before binding the next, and never holds two for one plugin.

import { startMiniAppProxy, type MiniAppProxy, type StartMiniAppProxyInput } from "./proxy.js";

export interface MiniAppProxyRegistry {
  /** The listeners that are up, in binding order. */
  readonly running: () => readonly MiniAppProxy[];
  /** Binds a plugin's listener, replacing the one it already had. */
  readonly start: (input: StartMiniAppProxyInput) => Promise<MiniAppProxy>;
  /** Closes one plugin's listener, if it has one. */
  readonly close: (pluginId: string) => Promise<void>;
  /** Closes every listener. The service calls this on the way down. */
  readonly closeAll: () => Promise<void>;
}

export function createMiniAppProxyRegistry(
  deps: { readonly start?: typeof startMiniAppProxy } = {},
): MiniAppProxyRegistry {
  const startProxy = deps.start ?? startMiniAppProxy;
  const proxies = new Map<string, MiniAppProxy>();

  return {
    running: () => [...proxies.values()],
    async start(input) {
      const pluginId = input.target.pluginId;
      const existing = proxies.get(pluginId);
      if (existing) {
        proxies.delete(pluginId);
        await existing.close();
      }
      const proxy = await startProxy(input);
      proxies.set(pluginId, proxy);
      return proxy;
    },
    async close(pluginId) {
      const proxy = proxies.get(pluginId);
      if (!proxy) return;
      proxies.delete(pluginId);
      await proxy.close();
    },
    async closeAll() {
      const listeners = [...proxies.values()];
      proxies.clear();
      // One failing listener must not keep the others bound, so each is closed
      // on its own and a failure is swallowed here: the service is going away,
      // and a teardown that threw would leave the rest of the shutdown unrun.
      await Promise.all(listeners.map((proxy) => proxy.close().catch(() => undefined)));
    },
  };
}
