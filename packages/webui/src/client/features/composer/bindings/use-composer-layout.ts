import { useLayoutEffect, type RefObject } from "react";

export function useComposerLayout(
  enabled: boolean,
  regionRef: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const region = regionRef.current;
    const layout = region?.closest<HTMLElement>('[data-webui-session-layout="true"]');
    if (!region || !layout) return undefined;
    const update = (): void => {
      layout.style.setProperty("--webui-composer-bottom-padding", `${Math.ceil(region.getBoundingClientRect().height) + 16}px`);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(region);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      layout.style.removeProperty("--webui-composer-bottom-padding");
    };
  }, [enabled, regionRef]);
}
