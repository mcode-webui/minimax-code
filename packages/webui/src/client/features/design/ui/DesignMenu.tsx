import { useEffect, useId, useRef, type ReactElement } from "react";
import {
  WebuiDropdown,
  type WebuiDropdownAnchorRect,
} from "../../../ui/Dropdown.js";
import { WebuiButton } from "../../../ui/button.js";
import type { DesignKind } from "../../../../shared/contracts/design.js";

export type DesignMenuEntry =
  | "-"
  | {
      readonly label: string;
      readonly action: string;
      readonly kind?: DesignKind | null;
      readonly disabled?: boolean;
      readonly danger?: boolean;
      readonly hint?: string;
    };

/** The original context and palette actions keep their anchored menu form. */
export function DesignMenu({
  open,
  anchor,
  entries,
  onClose,
  onChoose,
  label = "画布菜单",
  layerId,
}: {
  readonly open: boolean;
  readonly anchor: WebuiDropdownAnchorRect;
  readonly entries: readonly DesignMenuEntry[];
  readonly onClose: () => void;
  readonly onChoose: (action: string) => void;
  readonly label?: string;
  readonly layerId?: string;
}): ReactElement {
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (open)
      content.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
  }, [open, anchor]);
  return (
    <WebuiDropdown
      open={open}
      onOpen={() => undefined}
      onClose={onClose}
      anchorRect={() => anchor}
      managed
      managedLayerId={layerId ?? id}
      role="menu"
      ariaLabel={label}
      side="bottom"
      align="start"
      collision="clamp"
      offset={0}
      className="webui-design-menu"
      popupDataAttributes={{ "data-design-menu": label }}
    >
      <div
        ref={content}
        aria-label={label}
        onKeyDown={(event) => {
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          ];
          const index = items.indexOf(event.target as HTMLButtonElement);
          let next: number | undefined;
          if (
            event.key === "ArrowDown" ||
            (event.key === "Tab" && !event.shiftKey)
          )
            next = index + 1;
          else if (
            event.key === "ArrowUp" ||
            (event.key === "Tab" && event.shiftKey)
          )
            next = index - 1;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = items.length - 1;
          if (next !== undefined && items.length) {
            event.preventDefault();
            event.stopPropagation();
            items[(next + items.length) % items.length]?.focus({
              preventScroll: true,
            });
          }
        }}
      >
        {entries.map((entry, index) =>
          entry === "-" ? (
            <div
              role="separator"
              className="webui-design-menu-separator"
              key={`separator-${index}`}
            />
          ) : (
            <WebuiButton
              key={`${entry.action}-${index}`}
              role="menuitem"
              aria-label={entry.label}
              variant="plain"
              size="inline-dense"
              disabled={entry.disabled}
              title={entry.hint}
              data-danger={entry.danger ? "true" : undefined}
              className="webui-design-menu-item"
              onClick={() => {
                onClose();
                onChoose(entry.action);
              }}
            >
              {entry.kind ? (
                <i
                  className="webui-design-kind-dot"
                  data-kind={entry.kind}
                  aria-hidden="true"
                />
              ) : null}
              <span>{entry.label}</span>
              {entry.hint ? <small>{entry.hint}</small> : null}
            </WebuiButton>
          ),
        )}
      </div>
    </WebuiDropdown>
  );
}
