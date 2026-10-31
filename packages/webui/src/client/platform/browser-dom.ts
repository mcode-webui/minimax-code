// Browser-only DOM operations used by the WebUI bindings. The composition root
// supplies the browser objects; components receive only the narrow operations
// they need and never reach for document directly.

import type {
  WebuiBrowserCanvas,
  WebuiBrowserImage,
} from "../contracts/browser-drawing.js";

export type { WebuiBrowserCanvas, WebuiBrowserImage };

/**
 * The last element to hold focus outside every modal surface.
 *
 * A dialog opened from a menu item cannot give focus back to that item: the menu
 * unmounts while the dialog is open, so the recorded element is gone by the time
 * the dialog closes and focus would drop onto the document body. Tracking the
 * last element focused outside a modal keeps the return target meaningful there,
 * and the tracker is installed per document the first time a modal activates.
 */
const outsideModalFocusByDocument = new WeakMap<Document, HTMLElement[]>();
const OUTSIDE_MODAL_FOCUS_HISTORY = 8;

function recordOutsideModalFocus(ownerDocument: Document, element: HTMLElement): void {
  const history = outsideModalFocusByDocument.get(ownerDocument);
  if (!history) return;
  const previous = history.indexOf(element);
  if (previous >= 0) history.splice(previous, 1);
  history.push(element);
  if (history.length > OUTSIDE_MODAL_FOCUS_HISTORY) history.shift();
}

function trackOutsideModalFocus(ownerDocument: Document): HTMLElement {
  const history = outsideModalFocusByDocument.get(ownerDocument);
  if (history) return history[history.length - 1] ?? ownerDocument.body;
  const active = ownerDocument.activeElement;
  // The adapter is also constructed against an injected document in the unit
  // suite, where the DOM globals do not exist; the guard keeps the tracker
  // usable there instead of throwing on the constructor reference.
  const initial = typeof HTMLElement !== "undefined" && active instanceof HTMLElement
    ? active
    : ownerDocument.body;
  outsideModalFocusByDocument.set(ownerDocument, [initial]);
  ownerDocument.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("[data-webui-dialog-mask], .webui-settings-mask, [data-overlay-layer]")) return;
    recordOutsideModalFocus(ownerDocument, target);
  }, true);
  return initial;
}

/**
 * The element focus returns to when the control that opened the modal is gone.
 *
 * A menu item unmounts with its menu, so the single most recent target is often
 * disconnected by the time the dialog closes. The history is walked newest
 * first and the first target that is still in the document, still focusable and
 * not inside a modal wins.
 */
function connectedOutsideModalFocus(ownerDocument: Document): HTMLElement | null {
  const history = outsideModalFocusByDocument.get(ownerDocument) ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const element = history[index];
    if (!element?.isConnected) continue;
    if (element.hasAttribute("disabled") || element.getAttribute("aria-hidden") === "true") continue;
    return element;
  }
  return null;
}


export interface WebuiBrowserDom {
  readonly portalTarget: () => HTMLElement | null;
  readonly listenForMouseDown: (listener: (event: MouseEvent) => void) => () => void;
  readonly listenForPointerDown: (listener: (event: PointerEvent) => void, capture?: boolean) => () => void;
  readonly listenForKeyDown: (listener: (event: KeyboardEvent) => void) => () => void;
  /**
   * The viewport was resized.
   *
   * A floating popup placed against a trigger has to follow it when the
   * viewport changes, so the listener is part of the platform rather than
   * something a component reaches for `window` directly.
   */
  readonly listenForResize: (listener: () => void) => () => void;
  /**
   * Something scrolled.
   *
   * The listener is registered in the capture phase, so it also hears the
   * scroll of any scrolling container — a popup anchored inside a scrollable
   * region moves with it.
   */
  readonly listenForScroll: (listener: () => void) => () => void;
  readonly listenForStorageChange: (listener: () => void) => () => void;
  /**
   * The viewport's size.
   *
   * A floating popup is placed inside the viewport, so the size of that
   * viewport is part of the placement arithmetic. It belongs to the platform
   * for the same reason the resize listener does: a component that reaches
   * for `window.innerWidth` directly is a component that cannot be placed
   * against anything but a browser.
   */
  readonly viewportSize: () => { readonly width: number; readonly height: number };
  /**
   * Watch an element's size.
   *
   * A floating popup is placed against a measured size, and a popup whose
   * content changes size after it opened needs to be placed again — a panel
   * that grows by six rows when its disclosure opens moves its own edges.
   * Re-rendering does not report that, because the popup's content re-renders
   * without the popup's owner re-rendering.
   *
   * A platform that has no `ResizeObserver` answers with a no-op: the popup
   * keeps the placement it was given.
   */
  readonly observeSize: (element: Element, listener: () => void) => () => void;
  /**
   * Whether this page is currently hidden from the reader.
   *
   * A composition root that has no document answers `false` — a reader that does
   * not exist yet is not a reader who has gone away.
   */
  readonly isPageHidden: () => boolean;
  /** Fires when the page becomes visible or hidden. */
  readonly listenForVisibilityChange: (listener: () => void) => () => void;
  readonly listenForContextWindowUsageChange: (listener: () => void) => () => void;
  readonly getElementById: (id: string) => HTMLElement | null;
  readonly getActiveElement: () => HTMLElement | null;
  /** Makes a modal surface exclusive to keyboard and assistive technology. */
  readonly activateModalSurface: (surface: HTMLElement, mask: HTMLElement, allowedPortalLayerIds: () => ReadonlySet<string>) => () => void;
  readonly updateDocumentAppearance: (theme: "dark" | "light", language: string) => void;
  /**
   * The theme the document is currently showing.
   *
   * The appearance effect above puts the truth on the document element (the
   * `dark` class), so a component that has to draw in the app's theme — the
   * transcript's Mermaid renderer, whose SVG carries its own palette — reads
   * it from here instead of touching `document`, which the dependency rules
   * confine to the platform layer.
   */
  readonly readDocumentTheme: () => "dark" | "light";
  /**
   * The theme the document is showing changed.
   *
   * Every theme transition the app makes ends as the appearance effect above
   * flipping the `dark` class on the document element — a click in the
   * settings modal, a `system` preference following the OS — so the
   * subscription observes that class rather than any one writer: whoever
   * flips it, the listener hears. A component whose drawing bakes the theme
   * in (the transcript's Mermaid renderer) repaints on this signal instead of
   * showing a stale palette until the next navigation. A platform with no
   * document, or no `MutationObserver`, answers with a no-op: the listener
   * keeps the theme it last read.
   */
  readonly subscribeDocumentTheme: (listener: (theme: "dark" | "light") => void) => () => void;
  readonly dispatchContextWindowUsageChange: () => void;
  readonly copyTextFallback: (text: string) => void;
  /**
   * Reads a theme token's resolved colour.
   *
   * The account page's share image is painted with the same tokens the page
   * uses, so the image follows the active theme instead of hard-coding a
   * palette.
   */
  readonly readCssVariable: (name: string, fallback: string) => string;
  /**
   * Resolves once the document's fonts have loaded.
   *
   * A terminal measures its grid after the fonts land: a measurement taken
   * against fallback glyphs is a measurement of the wrong grid, and the shell
   * that follows it resizes to a size the terminal never had. The wait
   * belongs to the platform for the same reason the resize listener does — a
   * component that reaches for `document` directly is a component that cannot
   * be placed against anything but a browser.
   *
   * A platform with no document resolves at once: there are no fonts to wait
   * for, so the caller measures the grid it has.
   */
  readonly whenFontsReady: () => Promise<void>;
  /**
   * Creates a drawing surface.
   *
   * The share image is rendered on a canvas rather than in the DOM, so the
   * download is a plain PNG. A composition root that has no document answers
   * `null`.
   */
  readonly createCanvas: (width: number, height: number) => WebuiBrowserCanvas | null;
  /**
   * Loads an image the canvas can draw.
   *
   * The image is fetched first and decoded from the bytes, so a drawn image
   * does not taint the canvas and the export stays readable.
   */
  readonly loadImage: (src: string) => Promise<WebuiBrowserImage>;
  /** Saves a blob under a file name. */
  readonly downloadBlob: (blob: Blob, fileName: string) => void;
}

export function createWebuiBrowserDom(
  documentObject: Document | undefined,
  windowObject: (Window & typeof globalThis) | undefined,
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

  // Installed at composition time, not on the first modal: the element a dialog
  // should hand focus back to is focused before the dialog exists.
  if (documentObject) trackOutsideModalFocus(documentObject);

  return {
    portalTarget: () => documentObject?.body ?? null,
    listenForMouseDown: (listener) => listen("mousedown", listener),
    listenForPointerDown: (listener, capture) => listen("pointerdown", listener, capture),
    listenForKeyDown: (listener) => listen("keydown", listener),
    listenForResize: (listener) => {
      if (!windowObject) return () => undefined;
      windowObject.addEventListener("resize", listener);
      return () => windowObject.removeEventListener("resize", listener);
    },
    listenForScroll: (listener) => {
      if (!windowObject) return () => undefined;
      // Capture phase: a scroll inside any container reaches the window too,
      // and a popup anchored in that container has to follow it.
      windowObject.addEventListener("scroll", listener, true);
      return () => windowObject.removeEventListener("scroll", listener, true);
    },
    listenForStorageChange: (listener) => {
      if (!windowObject) return () => undefined;
      windowObject.addEventListener("storage", listener);
      return () => windowObject.removeEventListener("storage", listener);
    },
    viewportSize: () => ({
      width: windowObject?.innerWidth ?? 0,
      height: windowObject?.innerHeight ?? 0,
    }),
    observeSize: (element, listener) => {
      if (typeof ResizeObserver === "undefined") return () => undefined;
      const observer = new ResizeObserver(() => listener());
      observer.observe(element);
      return () => observer.disconnect();
    },
    isPageHidden: () => documentObject?.visibilityState === "hidden",
    listenForVisibilityChange: (listener) => listen("visibilitychange", () => listener()),
    listenForContextWindowUsageChange: (listener) => {
      if (!windowObject) return () => undefined;
      windowObject.addEventListener("webui-context-window-usage-change", listener);
      return () => windowObject.removeEventListener("webui-context-window-usage-change", listener);
    },
    getElementById: (id) => documentObject?.getElementById(id) ?? null,
    getActiveElement: () => {
      if (!documentObject) return null;
      const activeElement = documentObject.activeElement;
      return activeElement && typeof (activeElement as HTMLElement).focus === "function"
        ? activeElement as HTMLElement
        : null;
    },
    activateModalSurface: (surface, mask, allowedPortalLayerIds) => {
      const ownerDocument = surface.ownerDocument;
      const restoreTo = ownerDocument.activeElement instanceof HTMLElement
        ? ownerDocument.activeElement
        : null;
      const changed = [...(mask.parentElement?.children ?? [])]
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== mask)
        .map((element) => ({ element, inert: element.inert }));
      for (const { element } of changed) element.inert = true;
      const focusable = () => [...surface.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
      const containFocus = (event: FocusEvent) => {
        if (event.target instanceof Node && !surface.contains(event.target)) {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-overlay-layer]") : null;
          const targetIds = target?.dataset.overlayLayer?.split(/\s+/u) ?? [];
          if (targetIds.some((id) => allowedPortalLayerIds().has(id))) return;
          (focusable()[0] ?? surface).focus();
        }
      };
      const containTab = (event: KeyboardEvent) => {
        if (event.key !== "Tab") return;
        const allowedIds = allowedPortalLayerIds();
        const elements = [
          ...focusable(),
          ...[...(mask.ownerDocument.body?.querySelectorAll<HTMLElement>(
            'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ) ?? [])].filter((element) => {
            if (surface.contains(element)) return false;
            const layer = element.closest<HTMLElement>("[data-overlay-layer]");
            return layer?.dataset.overlayLayer?.split(/\s+/u).some((id) => allowedIds.has(id)) ?? false;
          }),
        ];
        const first = elements[0];
        const last = elements.at(-1);
        if (!first || !last) {
          event.preventDefault();
          surface.focus();
        } else if (event.shiftKey && ownerDocument.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && ownerDocument.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };
      ownerDocument.addEventListener("focusin", containFocus, true);
      ownerDocument.addEventListener("keydown", containTab, true);
      return () => {
        ownerDocument.removeEventListener("focusin", containFocus, true);
        ownerDocument.removeEventListener("keydown", containTab, true);
        for (const { element, inert } of changed) element.inert = inert;
        // The control that opened the dialog may be gone by now — a menu item
        // unmounts with its menu — so fall back to the newest element focused
        // outside a modal that is still in the document rather than leaving
        // focus on the document body.
        const target = restoreTo?.isConnected ? restoreTo : connectedOutsideModalFocus(ownerDocument);
        target?.focus();
      };
    },
    updateDocumentAppearance: (theme, language) => {
      if (!documentObject) return;
      documentObject.documentElement.classList.toggle("dark", theme === "dark");
      documentObject.documentElement.classList.toggle("light", theme !== "dark");
      documentObject.documentElement.lang = language.startsWith("zh") ? "zh-CN" : "en";
    },
    readDocumentTheme: () =>
      documentObject?.documentElement.classList.contains("dark") ? "dark" : "light",
    subscribeDocumentTheme: (listener) => {
      if (!documentObject || typeof MutationObserver === "undefined") return () => undefined;
      const read = () =>
        documentObject.documentElement.classList.contains("dark") ? "dark" : "light";
      const observer = new MutationObserver(() => listener(read()));
      observer.observe(documentObject.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      return () => observer.disconnect();
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
    readCssVariable: (name, fallback) => {
      if (!documentObject?.defaultView) return fallback;
      const value = documentObject.defaultView
        .getComputedStyle(documentObject.documentElement)
        .getPropertyValue(name)
        .trim();
      return value || fallback;
    },
    whenFontsReady: () => {
      const fonts = documentObject?.fonts;
      if (!fonts) return Promise.resolve();
      return fonts.ready.then(() => undefined);
    },
    createCanvas: (width, height) => {
      if (!documentObject) return null;
      const canvas = documentObject.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      return {
        width,
        height,
        context,
        toBlob: () =>
          new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (blob) => {
                if (blob) resolve(blob);
                else reject(new Error("Unable to create the usage report image"));
              },
              "image/png",
            );
          }),
      };
    },
    loadImage: async (src) => {
      if (!windowObject) throw new Error("Unable to load the usage report image");
      const response = await windowObject.fetch(src, { credentials: "omit" });
      if (!response.ok) {
        throw new Error(`Unable to load the usage report image: ${response.status}`);
      }
      const blob = await response.blob();
      if (typeof windowObject.createImageBitmap === "function") {
        const bitmap = await windowObject.createImageBitmap(blob);
        return { image: bitmap, width: bitmap.width, height: bitmap.height };
      }
      const url = windowObject.URL.createObjectURL(blob);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new windowObject.Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error(`Unable to load the usage report image: ${src}`));
          element.src = url;
        });
        return {
          image,
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
        };
      } finally {
        windowObject.URL.revokeObjectURL(url);
      }
    },
    downloadBlob: (blob, fileName) => {
      if (!documentObject?.body || !windowObject) return;
      const url = windowObject.URL.createObjectURL(blob);
      const anchor = documentObject.createElement("a");
      try {
        anchor.href = url;
        anchor.download = fileName;
        anchor.style.display = "none";
        documentObject.body.appendChild(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        windowObject.URL.revokeObjectURL(url);
      }
    },
  };
}

export const EMPTY_WEBUI_BROWSER_DOM: WebuiBrowserDom = createWebuiBrowserDom(undefined, undefined);
