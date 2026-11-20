import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useWebuiApplicationOptional } from "../../../bindings/application-context.js";
import type { GetDesignStateRequest } from "../../../../shared/contracts/design.js";
import type { DesignSnapshot } from "../application/design-owner.js";
import type { WebuiBrowserDom } from "../../../platform/browser-dom.js";
import {
  clampCropRect,
  planGridSplit,
} from "../../../../shared/design/tools.mjs";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";

const unavailable: DesignSnapshot = {
  status: "unavailable",
  busy: false,
  canUndo: false,
  canRedo: false,
};
const noop = () => () => undefined;
export function useDesignPageLifecycle(input: {
  readonly pending: boolean;
  readonly flush: () => Promise<unknown>;
  readonly preserve: () => Promise<unknown>;
}): void {
  const { dom } = useWebuiBrowserCapabilities();
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!latest.current.pending) return;
      void latest.current.preserve();
      event.preventDefault();
      event.returnValue = "";
    };
    const pageHide = () => {
      if (latest.current.pending) void latest.current.preserve();
    };
    const visibility = () => {
      if (dom.isPageHidden() && latest.current.pending) {
        void latest.current.preserve();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pageHide);
    const stopVisibility = dom.listenForVisibilityChange(visibility);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pageHide);
      stopVisibility();
    };
  }, [dom]);
}
export function useDesign(request: GetDesignStateRequest) {
  const owner = useWebuiApplicationOptional()?.design;
  const snapshot = useSyncExternalStore(
    owner?.subscribe ?? noop,
    owner?.getSnapshot ?? (() => unavailable),
    owner?.getSnapshot ?? (() => unavailable),
  );
  useEffect(
    () => owner?.observe(request),
    [owner, request.documentId, request.sessionId],
  );
  return { owner, snapshot };
}

/** Browser effects stay at the binding boundary. */
export function openDesignTab(url: string): void {
  const tab = window.open(url, "_blank", "noopener");
  // With noopener Chromium intentionally answers null even after opening.
  tab?.focus();
}

/** Design uses the existing WebUI appearance preference, including system mode. */
export function useDesignAppearance() {
  const { dom, storage } = useWebuiBrowserCapabilities();
  const read = (): "system" | "light" | "dark" => {
    const value = storage.getItem("webui-theme");
    return value === "light" || value === "dark" ? value : "system";
  };
  const [preference, setPreference] = useState(read);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const next = read();
      setPreference(next);
      dom.updateDocumentAppearance(
        next === "system" ? (media.matches ? "dark" : "light") : next,
        storage.getItem("mavis-locale") ?? "zh-CN",
      );
    };
    apply();
    const unlisten = dom.listenForStorageChange(apply);
    const unlistenTheme = dom.subscribeDocumentTheme(() => {
      const next = read(),
        expected =
          next === "system" ? (media.matches ? "dark" : "light") : next;
      setPreference(next);
      if (dom.readDocumentTheme() !== expected) apply();
    });
    media.addEventListener("change", apply);
    return () => {
      unlisten();
      unlistenTheme();
      media.removeEventListener("change", apply);
    };
  }, [dom, storage]);
  return {
    preference,
    cycle: () => {
      const next = (
        { system: "light", light: "dark", dark: "system" } as const
      )[preference];
      storage.setItem("webui-theme", next);
      setPreference(next);
      dom.updateDocumentAppearance(
        next === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : next,
        storage.getItem("mavis-locale") ?? "zh-CN",
      );
    },
  };
}

export async function copyDesignText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText)
    throw new Error("当前浏览器不支持复制文本。");
  await navigator.clipboard.writeText(text);
}

export async function copyDesignImage(
  dom: Pick<WebuiBrowserDom, "loadImage" | "createCanvas">,
  url: string,
): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined")
    throw new Error("当前浏览器不支持复制图片。");
  const image = await dom.loadImage(url);
  const canvas = dom.createCanvas(image.width, image.height);
  if (!canvas) throw new Error("当前浏览器无法处理图片。");
  canvas.context.drawImage(image.image, 0, 0);
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": await canvas.toBlob() }),
  ]);
}

export async function downloadDesignMedia(
  dom: Pick<WebuiBrowserDom, "downloadBlob">,
  url: string,
  name: string,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载素材失败：HTTP ${response.status}`);
  dom.downloadBlob(await response.blob(), name);
}

export function updateDesignTabDocument(documentId: string): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get("document") === documentId) return;
  url.searchParams.set("document", documentId);
  window.history.replaceState(window.history.state, "", url);
}

export async function designFileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** The original image tools stay local and require no ffmpeg installation. */
export async function runDesignImageTool(
  dom: Pick<WebuiBrowserDom, "loadImage" | "createCanvas">,
  url: string,
  tool: "crop" | "gridSplit",
  params: Readonly<Record<string, unknown>>,
): Promise<readonly { readonly name: string; readonly base64: string }[]> {
  const source = await dom.loadImage(url);
  const raw =
    params.rect && typeof params.rect === "object"
      ? (params.rect as Record<string, unknown>)
      : {};
  const crop = clampCropRect({
    x: raw.x ?? 0,
    y: raw.y ?? 0,
    w: raw.width ?? raw.w ?? 1,
    h: raw.height ?? raw.h ?? 1,
  });
  const rectangles =
    tool === "gridSplit"
      ? planGridSplit({
          width: source.width,
          height: source.height,
          rows: Number(params.rows ?? 3),
          cols: Number(params.cols ?? 3),
        }).cells
      : [
          {
            sx: Math.round(crop.x * source.width),
            sy: Math.round(crop.y * source.height),
            sw: Math.max(1, Math.round(crop.w * source.width)),
            sh: Math.max(1, Math.round(crop.h * source.height)),
            index: 0,
          },
        ];
  const result: { name: string; base64: string }[] = [];
  for (const rectangle of rectangles) {
    const canvas = dom.createCanvas(rectangle.sw, rectangle.sh);
    if (!canvas) throw new Error("当前浏览器无法创建图片处理画布。");
    canvas.context.drawImage(
      source.image,
      rectangle.sx,
      rectangle.sy,
      rectangle.sw,
      rectangle.sh,
      0,
      0,
      rectangle.sw,
      rectangle.sh,
    );
    result.push({
      name: `${tool}-${rectangle.index + 1}.png`,
      base64: await designFileBase64(await canvas.toBlob()),
    });
  }
  return result;
}

export function readDesignPrompt(element: HTMLElement): string {
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (node instanceof HTMLElement) {
      const token = node.dataset.designMention;
      if (token) return token;
      if (node.tagName === "BR") return "\n";
      const content = [...node.childNodes].map(walk).join("");
      return node.tagName === "DIV" ? `\n${content}` : content;
    }
    return [...node.childNodes].map(walk).join("");
  };
  return [...element.childNodes]
    .map(walk)
    .join("")
    .replace(/\u00a0/gu, " ");
}
