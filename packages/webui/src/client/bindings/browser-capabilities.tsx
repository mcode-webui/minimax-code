import { createContext, useContext, type ReactNode } from "react";
import { EMPTY_WEBUI_BROWSER_DOM, type WebuiBrowserDom } from "../infrastructure/browser-dom.js";
import { createWebuiBrowserStorage, type WebuiBrowserStorage } from "../infrastructure/storage.js";

export interface WebuiBrowserCapabilities {
  readonly dom: WebuiBrowserDom;
  readonly storage: WebuiBrowserStorage;
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
