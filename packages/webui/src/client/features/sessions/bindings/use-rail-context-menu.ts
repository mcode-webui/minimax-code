import { useCallback, useState, type MouseEvent } from "react";

import type { WebuiContextMenuItem } from "../../../ui/ContextMenu.js";

type RailContextMenuState = {
  readonly x: number;
  readonly y: number;
  readonly items: readonly WebuiContextMenuItem[];
};

/** Owns the rail menu's disposable pointer anchor and open/close attachment. */
export function useRailContextMenu() {
  const [menu, setMenu] = useState<RailContextMenuState>();

  const open = useCallback(
    (
      event: MouseEvent<HTMLElement>,
      items: readonly WebuiContextMenuItem[],
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      const fromContextMenu = event.type === "contextmenu";
      setMenu({
        x: fromContextMenu ? event.clientX : bounds.right - 220,
        y: fromContextMenu ? event.clientY : bounds.bottom,
        items,
      });
    },
    [],
  );

  const close = useCallback(() => setMenu(undefined), []);

  return { menu, open, close };
}
