// WebuiContextMenu — the floating right-click menu, plus the item shape that
// drives it.
//
// The menu opens at the pointer, so it has no trigger to hang from: the anchor
// is a POINT rather than a box. The shared skeleton asks for the anchor at
// measure time, which is what makes a point an anchor — the menu is placed
// against where the pointer was, not against where it was when the menu was
// created.
//
// The placement rule is still the menu's own: it opens at the pointer, flips
// above the pointer when there is no room below, and is kept inside the
// viewport either way. That rule is a pure function in
// `projection/common/context-menu.ts`, and the skeleton calls it.

import { useCallback, useState, type ReactElement } from "react";
import { WebuiIconContextChevron } from "../shell/icons.js";
import { placeWebuiContextMenu } from "../projection/common/context-menu.js";
import { WebuiDropdown, type WebuiDropdownPlacementArgs } from "./Dropdown.js";

export type WebuiContextMenuItem =
  | { readonly kind: "divider"; readonly key: string }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly label: string;
      readonly icon?: ReactElement;
      readonly danger?: boolean;
      readonly disabled?: boolean;
      readonly onSelect?: () => void | Promise<void>;
      readonly submenu?: readonly WebuiContextMenuItem[];
    };

export function WebuiContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  readonly x: number;
  readonly y: number;
  readonly items: readonly WebuiContextMenuItem[];
  readonly onClose: () => void;
}): ReactElement {
  const [openSubmenu, setOpenSubmenu] = useState<string>();
  /**
   * The anchor: the point the menu opens at.
   *
   * Asked for at measure time, so a menu that re-renders at a new point is
   * placed at the new point rather than at the one it remembers.
   */
  const anchorRect = useCallback(
    () => ({ left: x, top: y, width: 0, height: 0 }),
    [x, y],
  );
  /**
   * The placement rule.
   *
   * It opens at the pointer, flips above it when there is no room below, and
   * is kept inside the viewport either way — the rule is the menu's own and
   * lives in `projection/common/context-menu.ts`, where it can be tested
   * against numbers.
   */
  const placement = useCallback(
    ({ anchor, surface, viewport }: WebuiDropdownPlacementArgs) => {
      const next = placeWebuiContextMenu({
        x: anchor.left,
        y: anchor.top,
        width: surface.width,
        height: surface.height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
      return { left: next.left, top: next.top };
    },
    [],
  );
  const renderItems = (menuItems: readonly WebuiContextMenuItem[]) =>
    menuItems.map((item) => {
      if (item.kind === "divider") {
        return <div key={item.key} className="webui-context-menu-divider" role="separator" />;
      }
      const hasSubmenu = Boolean(item.submenu?.length);
      return (
        <div
          key={item.key}
          className="webui-context-menu-item-wrap"
          onMouseEnter={() => hasSubmenu && setOpenSubmenu(item.key)}
          onMouseLeave={() => hasSubmenu && setOpenSubmenu(undefined)}
        >
          <button
            type="button"
            className={`webui-context-menu-item${item.danger ? " is-danger" : ""}`}
            disabled={item.disabled}
            aria-disabled={item.disabled ? "true" : undefined}
            onClick={() => {
              if (hasSubmenu) {
                setOpenSubmenu((current) => (current === item.key ? undefined : item.key));
                return;
              }
              onClose();
              void item.onSelect?.();
            }}
          >
            <span className="webui-context-menu-item-icon">{item.icon ?? null}</span>
            <span className="webui-context-menu-item-label">{item.label}</span>
            {hasSubmenu ? <WebuiIconContextChevron className="webui-context-menu-chevron" /> : null}
          </button>
          {hasSubmenu && openSubmenu === item.key ? (
            <div className="webui-context-menu-submenu webui-dropdown-surface" role="menu">
              {renderItems(item.submenu ?? [])}
            </div>
          ) : null}
        </div>
      );
    });
  return (
    <WebuiDropdown
          managed
          managedLayerId="context-menu"
      open
      onOpen={() => undefined}
      onClose={onClose}
      role="menu"
      className="webui-context-menu"
      popupDataAttributes={{ "data-webui-context-menu": "true" }}
      anchorRect={anchorRect}
      placement={placement}
    >
      {renderItems(items)}
    </WebuiDropdown>
  );
}
