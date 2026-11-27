import { createContext, useContext, type ReactNode } from "react";
import { EMPTY_WEBUI_BROWSER_DOM, type WebuiBrowserDom } from "../platform/browser-dom.js";
import type { NativeWorkspaceDirectoryResult } from "../platform/native-directory-picker.js";
import { createWebuiBrowserStorage, type WebuiBrowserStorage } from "../platform/storage.js";

export interface WebuiBrowserCapabilities {
  readonly dom: WebuiBrowserDom;
  readonly storage: WebuiBrowserStorage;
  readonly nativeDirectoryPicker?: {
    readonly choose: (signal: AbortSignal) => Promise<NativeWorkspaceDirectoryResult>;
  };
  /**
   * The runtime's data directory, when the host served the page with one.
   *
   * It is a fact about the host the page is talking to, not a browser
   * capability, but it reaches the surfaces the same way: the composition
   * root reads it from the injected runtime config and hands it over, so a
   * presentation never reads a global to learn where the runtime keeps its
   * data. A surface that needs it -- the diff boundary, which has to name a
   * session's own artifacts directory -- reads it from here.
   */
  readonly dataDir?: string;
}

const emptyCapabilities: WebuiBrowserCapabilities = {
  dom: EMPTY_WEBUI_BROWSER_DOM,
  storage: createWebuiBrowserStorage(undefined),
};

const BrowserCapabilitiesContext = createContext(emptyCapabilities);

export function WebuiBrowserCapabilitiesProvider({
  value,
  children,
}: {
  readonly value: WebuiBrowserCapabilities;
  readonly children: ReactNode;
}) {
  return <BrowserCapabilitiesContext.Provider value={value}>{children}</BrowserCapabilitiesContext.Provider>;
}

export function useWebuiBrowserCapabilities(): WebuiBrowserCapabilities {
  return useContext(BrowserCapabilitiesContext);
}
