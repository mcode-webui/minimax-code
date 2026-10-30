// The shared dropdown skeleton.
//
// Every floating popup in the client hangs off one trigger, closes when the
// pointer lands outside it or on Escape, and appears and disappears with the
// same motion. This module owns those three things — the surface, the motion
// and the dismissal — so a surface that needs a dropdown declares where it
// hangs and what it holds, and nothing else.
//
// The caller keeps its own open state: the skeleton never opens or closes on
// its own, it only *renders* the open state — and keeps the popup mounted long
// enough for the exit animation to play, which is why an open popup cannot be
// a plain `{open && …}` in the caller's markup.
//
// The popup is rendered into the portal and placed against the trigger's
// rectangle. That is not decoration: a popup that stays inside its trigger's
// wrapper is clipped by every scrolling ancestor between them (a dropdown in a
// form's scroll body is clipped by that body), and a popup that positions
// itself with `absolute` moves with the page while the trigger does not.
// Measuring the trigger and placing the popup in viewport coordinates is what
// makes one placement rule work everywhere.
//
// Not every popup hangs off a trigger. A list that follows the caret in a
// textarea, a fly-out that follows the row a pointer is over and a menu that
// opens at the pointer all have an anchor that is not a button — so the
// skeleton accepts the anchor as a *rectangle* as well as an element, and
// accepts a popup with no trigger at all. What it keeps owning is the same
// three things either way.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useOverlayLayer } from "./overlay-coordinator.js";
import { useParentLayerId } from "./overlay-listeners.js";

import { useWebuiBrowserCapabilities } from "../bindings/browser-capabilities.js";
import {
  placeWebuiDropdown,
  type WebuiDropdownAlign,
  type WebuiDropdownAnchorRect,
  type WebuiDropdownCollision,
  type WebuiDropdownPlacement,
  type WebuiDropdownPlacementArgs,
  type WebuiDropdownSide,
  type WebuiDropdownWidth,
} from "../projection/common/dropdown-placement.js";

export type {
  WebuiDropdownAlign,
  WebuiDropdownAnchorRect,
  WebuiDropdownCollision,
  WebuiDropdownPlacement,
  WebuiDropdownPlacementArgs,
  WebuiDropdownSide,
  WebuiDropdownWidth,
};

/**
 * How long the exit animation runs.
 *
 * The stylesheet reads the same number through `--webui-dropdown-exit-duration`,
 * which the popup carries as an inline custom property, so the two cannot drift:
 * the popup is unmounted when the animation that fades it out has finished.
 */
export const WEBUI_DROPDOWN_EXIT_MS = 120;

/**
 * `useLayoutEffect` on the client, `useEffect` on the server.
 *
 * The placement is measured from the DOM, so it has to run before the browser
 * paints; on the server there is no layout to measure, and React warns about a
 * layout effect that never runs.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * What the trigger receives.
 *
 * The skeleton wires the trigger to the popup — the expanded state, the control
 * it owns, the keyboard dismissal and the toggle — so every dropdown in the
 * client answers the same way without each surface re-deriving it.
 */
export interface WebuiDropdownTriggerProps {
  /** Toggles the dropdown. */
  readonly onClick: () => void;
  /** Escape closes the dropdown. */
  readonly onKeyDown: (event: KeyboardEvent) => void;
  readonly "aria-expanded": boolean;
  readonly "aria-haspopup": "menu" | "listbox" | "dialog";
  readonly "aria-controls": string;
  readonly id: string;
  /**
   * A callback ref for the trigger element itself: the skeleton focuses it
   * when Escape closes the dropdown, and it is the anchor the popup is
   * measured against when the caller names nothing else.
   */
  readonly ref: (node: HTMLElement | null) => void;
}

export interface WebuiDropdownProps {
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly onClose: () => void;
  /**
   * The trigger.
   *
   * Omitted for a popup that something else opens — a list that follows the
   * caret in a textarea is opened by a keystroke, and there is no button to
   * hang it on. A popup with no trigger has no `aria-expanded` to report and
   * no focus to return to on Escape; it keeps the surface, the motion and the
   * dismissal.
   */
  readonly trigger?: (props: WebuiDropdownTriggerProps) => ReactNode;
  /** The popup's content. */
  readonly children: ReactNode;
  /**
   * The popup's own classes: the layout of its *content*.
   *
   * The surface — the background, the border, the radius, the shadow and the
   * motion — is the shared one, so a caller states only what is specific to
   * what it holds.
   */
  readonly className?: string;
  /** The wrapper's classes: the trigger's own layout. */
  readonly wrapperClassName?: string;
  /**
   * Hand this popup's dismissal to the overlay coordinator (ADR 0028 § Overlay
   * coordination).
   *
   * A managed popup registers as one layer and attaches no listener of its own,
   * so inside a managed subtree one Escape closes exactly the topmost layer
   * instead of every open surface answering the same key. A legacy instance —
   * `managed` unset — keeps its own Escape and outside-press handling, which is
   * what the surfaces that have not migrated still rely on.
   */
  readonly managed?: boolean;
  /** The layer id a managed popup registers under. */
  readonly managedLayerId?: string;
  /** A test hook on the wrapper. */
  readonly testId?: string;
  /**
   * Data attributes the popup itself carries.
   *
   * A surface's own marker — the attribute its stylesheet and its tests find
   * it by — belongs on the popup, not on the wrapper: the popup is the thing
   * the marker names, and the wrapper is the trigger's box.
   */
  readonly popupDataAttributes?: Readonly<Record<string, string>>;
  /**
   * The popup's own role.
   *
   * `presentation` is for a popup that *holds* other widgets rather than being
   * one — a menu stack whose panels each carry their own role, for instance.
   */
  readonly role?: "menu" | "listbox" | "dialog" | "presentation";
  /**
   * What the trigger opens, when that is not the popup's own role.
   *
   * A trigger that opens a stack of panels announces "menu" even though the
   * stack itself is only a container.
   */
  readonly triggerHasPopup?: "menu" | "listbox" | "dialog";
  readonly ariaLabel?: string;
  readonly labelledBy?: string;
  /** Which side of the trigger the popup hangs from. */
  readonly side?: WebuiDropdownSide;
  /** How the popup is aligned against the trigger. */
  readonly align?: WebuiDropdownAlign;
  /** `match` gives the popup at least the trigger's width; `content` sizes it to its own. */
  readonly width?: WebuiDropdownWidth;
  /** The gap between the trigger and the popup. */
  readonly offset?: number;
  /** Re-measure placement when the caller swaps content with a different size. */
  readonly placementKey?: string | number;
  /**
   * The anchor, as a rectangle.
   *
   * Asked for at measure time rather than given as an element, because the
   * anchor of a popup is often not an element at all: it is a row in a list
   * that the list is free to remount, a point on the canvas, or the place a
   * caret sits in a textarea. A resolver answers the question "where is the
   * anchor NOW", which is the only question a placement can be right about.
   *
   * When it answers `undefined` the popup keeps the placement it has.
   */
  readonly anchorRect?: () => WebuiDropdownAnchorRect | undefined;
  /**
   * The element the popup is measured against, when the anchor is an element
   * that is not the trigger.
   *
   * It outranks the trigger: a surface that has a trigger and still measures
   * against something else — a field inside a box, a row in a list — names
   * that something here.
   */
  readonly anchorElementRef?: RefObject<HTMLElement | null>;
  /**
   * The popup's own placement rule.
   *
   * The built-in rules cover the common shapes. A surface whose geometry is
   * genuinely its own — a menu that opens at the pointer, a panel that hangs
   * above its ring without ever opening downwards, a cascade that reads left
   * to right — states the rule here rather than re-implementing the surface,
   * the motion and the dismissal to get it.
   */
  readonly placement?: WebuiDropdownPlacement;
  /**
   * What happens when the popup does not fit.
   *
   * `none` leaves it where it falls, `clamp` keeps it inside the viewport,
   * and `flip` opens it on the other side when there is no room.
   */
  readonly collision?: WebuiDropdownCollision;
  /**
   * The region a press inside is NOT a dismissal.
   *
   * By default it is the trigger's own wrapper. A popup with no trigger names
   * the region that holds it — a list that follows the caret stays open while
   * the caret moves inside the composer it belongs to.
   */
  readonly dismissRegionRef?: RefObject<HTMLElement | null>;
}

/**
 * The dropdown.
 *
 * Dismissal is uniform across the client: a pointer press outside the trigger
 * or the popup closes it, and so does Escape. The press is read at
 * `pointerdown` rather than at `click`, so the popup is gone before the click
 * reaches whatever the user aimed at — a click that lands on another control
 * must not also hit a popup that was on its way out.
 */
export function WebuiDropdown({
  open,
  onOpen,
  onClose,
  trigger,
  children,
  className,
  wrapperClassName,
  testId,
  popupDataAttributes,
  role = "menu",
  triggerHasPopup,
  ariaLabel,
  labelledBy,
  side = "bottom",
  align = "start",
  width = "content",
  offset = 4,
  placementKey,
  anchorRect,
  anchorElementRef,
  placement,
  collision = "none",
  dismissRegionRef,
  managed = false,
  managedLayerId,
}: WebuiDropdownProps): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const popupId = useId();
  const triggerId = useId();
  // The popup outlives `open` by the length of the exit animation, so it can
  // fade out instead of vanishing.
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const [applied, setApplied] = useState<CSSProperties>({});
  /**
   * The side the popup ended up on.
   *
   * It is the side the placement ANSWERED, not the side that was asked for:
   * a popup that flipped because it did not fit opened on the other edge, and
   * the motion has to follow where it actually opened. The stylesheet reads it
   * from `data-webui-dropdown-side` to slide the popup the way it came.
   */
  const [openedSide, setOpenedSide] = useState<WebuiDropdownSide>(side);

  /**
   * The caller's callbacks, read through a ref.
   *
   * A caller that passes an inline arrow would otherwise hand the skeleton a
   * new function on every render, and the skeleton would re-place the popup
   * and re-register its document listeners every render — a measurement loop
   * that never settles. The values are read when they are needed, so what the
   * caller passes late is still the value that is used.
   */
  const anchorRectRef = useRef(anchorRect);
  anchorRectRef.current = anchorRect;
  const anchorElementRefRef = useRef(anchorElementRef);
  anchorElementRefRef.current = anchorElementRef;
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissRegionRefRef = useRef(dismissRegionRef);
  dismissRegionRefRef.current = dismissRegionRef;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setLeaving(false);
    }, WEBUI_DROPDOWN_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  // A managed popup is one layer in the coordinator's order. It is registered
  // even while closed so the layer it belongs to stays known, but an inactive
  // layer casts no vote.
  const managedId = useId();
  const layerId = managedLayerId ?? `webui-dropdown-${managedId}`;
  const parentLayerId = useParentLayerId();
  useOverlayLayer({
    id: layerId,
    parentId: parentLayerId,
    order: 10,
    active: managed && open,
    dismissal: "dismissible",
    onRoute: (route) => {
      if (route !== "request-close") return;
      onCloseRef.current();
      // Escape returns the focus to the control that opened the popup.
      triggerRef.current?.focus?.();
    },
  });

  useEffect(() => {
    // A managed popup answers through the coordinator, which owns the single
    // document listener; attaching its own here would make two listeners answer
    // the same Escape.
    if (!open || managed) return;
    const stopPointerDown = dom.listenForPointerDown((event) => {
      const target = event.target as Node | null;
      if (!target) return;
      // The trigger and the popup are the two halves of the dropdown; a press
      // on either is inside, and anything else is a dismissal. A surface with
      // no trigger names the region that holds it instead.
      if (dismissRegionRefRef.current?.current?.contains(target)) return;
      if (wrapperRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      onCloseRef.current();
    });
    const stopKeyDown = dom.listenForKeyDown((event) => {
      if (event.key !== "Escape") return;
      onCloseRef.current();
      // Escape returns the focus to the control that opened the dropdown.
      triggerRef.current?.focus?.();
    });
    return () => {
      stopPointerDown();
      stopKeyDown();
    };
  }, [dom, open, managed]);

  /**
   * The anchor, asked for now.
   *
   * A resolver first — it is the only way to name an anchor that is not an
   * element — then the element the caller pointed at, then the trigger.
   */
  const resolveAnchor = useCallback((): WebuiDropdownAnchorRect | undefined => {
    const resolved = anchorRectRef.current?.();
    if (resolved) return resolved;
    const element = anchorElementRefRef.current?.current ?? triggerRef.current;
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  /**
   * Place the popup against the anchor.
   *
   * The popup's own size is read back from the DOM, so an aligned popup lines
   * up with the anchor's edge rather than with its origin. The result is only
   * written when it differs, so measuring does not loop.
   *
   * The size is read from the LAYOUT box (`offsetWidth`/`offsetHeight`), not
   * from the painted rectangle. `getBoundingClientRect()` reports the box as
   * it is DRAWN, so a popup that is mid-animation — or that a caller gave a
   * transform of its own — measures two percent smaller than it is, and the
   * placement is then computed against a size the popup does not have. The
   * error does not correct itself: a transform does not resize anything, so
   * the size observer never fires and the placement keeps the wrong number.
   */
  const place = useCallback(() => {
    const anchor = resolveAnchor();
    if (!anchor) return;
    const popup = popupRef.current;
    const surface = {
      width: popup?.offsetWidth ?? 0,
      height: popup?.offsetHeight ?? 0,
    };
    const viewport = dom.viewportSize();
    const next = placementRef.current
      ? placementRef.current({ anchor, surface, viewport })
      : placeWebuiDropdown({
          anchor,
          surface,
          viewport,
          side,
          align,
          width,
          offset,
          collision,
        });
    setOpenedSide(next.side ?? side);
    setApplied((current) => {
      const nextStyle: CSSProperties = {
        top: `${next.top}px`,
        left: `${next.left}px`,
        ...(next.minWidth === undefined ? {} : { minWidth: next.minWidth }),
        ...(next.width === undefined ? {} : { width: next.width }),
      };
      const same =
        current.top === nextStyle.top &&
        current.left === nextStyle.left &&
        current.minWidth === nextStyle.minWidth &&
        current.width === nextStyle.width;
      return same ? current : nextStyle;
    });
  }, [align, collision, dom, offset, resolveAnchor, side, width]);

  useIsomorphicLayoutEffect(() => {
    if (!mounted) return;
    place();
    const stopResize = dom.listenForResize(place);
    const stopScroll = dom.listenForScroll(place);
    // The popup's own size can change after it opened — a panel that unfolds
    // six rows — and the placement has to follow it, because the popup's edges
    // are what the placement is computed from.
    const popup = popupRef.current;
    const stopObserve = popup ? dom.observeSize(popup, place) : undefined;
    return () => {
      stopResize();
      stopScroll();
      stopObserve?.();
    };
  }, [dom, mounted, place, placementKey]);

  const handleTriggerClick = useCallback(() => {
    if (open) onClose();
    else onOpen();
  }, [onClose, onOpen, open]);

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !open) return;
      event.stopPropagation();
      onClose();
    },
    [onClose, open],
  );

  const triggerProps: WebuiDropdownTriggerProps = {
    onClick: handleTriggerClick,
    onKeyDown: handleTriggerKeyDown,
    "aria-expanded": open,
    "aria-haspopup":
      triggerHasPopup ?? (role === "dialog" ? "dialog" : role === "presentation" ? "menu" : role),
    "aria-controls": popupId,
    id: triggerId,
    ref: (node) => {
      triggerRef.current = node;
    },
  };

  const popup = mounted ? (
    <div
      id={popupId}
      ref={popupRef}
      {...(managed ? { "data-overlay-layer": layerId } : {})}
      role={role}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      className={`webui-dropdown-popup${leaving ? " is-leaving" : ""}${className ? ` ${className}` : ""}`}
      data-webui-dropdown-side={openedSide}
      {...(popupDataAttributes ?? {})}
      style={{
        ...applied,
        "--webui-dropdown-exit-duration": `${WEBUI_DROPDOWN_EXIT_MS}ms`,
      } as CSSProperties}
    >
      {children}
    </div>
  ) : null;

  const portalTarget = dom.portalTarget();

  return (
    <div
      className={`webui-dropdown${trigger ? "" : " webui-dropdown--detached"}${wrapperClassName ? ` ${wrapperClassName}` : ""}`}
      ref={wrapperRef}
      data-webui-dropdown={open ? "open" : "closed"}
      {...(testId === undefined ? {} : { "data-testid": testId })}
    >
      {trigger ? trigger(triggerProps) : null}
      {popup ? (portalTarget ? createPortal(popup, portalTarget) : popup) : null}
    </div>
  );
}
