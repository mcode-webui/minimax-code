// Browser-only DOM operations used by the WebUI bindings. The composition root
// supplies the browser objects; components receive only the narrow operations
// they need and never reach for document directly.

export interface WebuiBrowserDom {
  readonly portalTarget: () => HTMLElement | null;
  readonly listenForMouseDown: (listener: (event: MouseEvent) => void) => () => void;
  readonly listenForPointerDown: (listener: (event: PointerEvent) => void, capture?: boolean) => () => void;
  readonly listenForKeyDown: (listener: (event: KeyboardEvent) => void) => () => void;
  readonly listenForStorageChange: (listener: () => void) => () => void;
  readonly listenForContextWindowUsageChange: (listener: () => void) => () => void;
  readonly getElementById: (id: string) => HTMLElement | null;
  readonly getActiveElement: () => HTMLElement | null;
  readonly updateDocumentAppearance: (theme: "dark" | "light", language: string) => void;
  readonly dispatchContextWindowUsageChange: () => void;
  readonly copyTextFallback: (text: string) => void;
}

export function createWebuiBrowserDom(
  documentObject: Document | undefined,
  windowObject: Window | undefined,
): WebuiBrowserDom {
  const listen = <K extends keyof DocumentEventMap>(
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
    capture = false,
  ): (() => void) => {
    if (!documentObject) return () => undefined;
    const handler = listener as EventListener;
    documentObject.addEventListener(type, handler, capture);
    return () => documentObject.removeEventListener(type, handler, capture);
  };

  return {
    portalTarget: () => documentObject?.body ?? null,
    listenForMouseDown: (listener) => listen("mousedown", listener),
    listenForPointerDown: (listener, capture) => listen("pointerdown", listener, capture),
    listenForKeyDown: (listener) => listen("keydown", listener),
    listenForStorageChange: (listener) => {
      if (!windowObject) return () => undefined;
      windowObject.addEventListener("storage", listener);
      return () => windowObject.removeEventListener("storage", listener);
    },
    listenForContextWindowUsageChange: (listener) => {
      if (!windowObject) return () => undefined;
      windowObject.addEventListener("webui-context-window-usage-change", listener);
      return () => windowObject.removeEventListener("webui-context-window-usage-change", listener);
    },
    getElementById: (id) => documentObject?.getElementById(id) ?? null,
    getActiveElement: () => documentObject?.activeElement instanceof HTMLElement
      ? documentObject.activeElement
      : null,
    updateDocumentAppearance: (theme, language) => {
      if (!documentObject) return;
      documentObject.documentElement.classList.toggle("dark", theme === "dark");
      documentObject.documentElement.classList.toggle("light", theme !== "dark");
      documentObject.documentElement.lang = language.startsWith("zh") ? "zh-CN" : "en";
    },
    dispatchContextWindowUsageChange: () => {
      if (windowObject) windowObject.dispatchEvent(new Event("webui-context-window-usage-change"));
    },
    copyTextFallback: (text) => {
      if (!documentObject?.body) return;
      const area = documentObject.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      documentObject.body.appendChild(area);
      area.select();
      documentObject.execCommand("copy");
      area.remove();
    },
  };
}

export const EMPTY_WEBUI_BROWSER_DOM: WebuiBrowserDom = createWebuiBrowserDom(undefined, undefined);
