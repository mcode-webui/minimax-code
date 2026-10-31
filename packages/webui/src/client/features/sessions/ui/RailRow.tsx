import type { ReactElement } from "react";
import { WebuiButton } from "../../../ui/button.js";

export function RailRow({
  label,
  icon,
  active,
  onSelect,
  inert,
}: {
  readonly label: string;
  readonly icon?: ReactElement;
  readonly active?: boolean;
  readonly onSelect?: () => void;
  readonly inert?: boolean;
}): ReactElement {
  return (
    <div
      className={`webui-nav-item group/nav flex h-8 w-full items-center rounded-lg text-sm transition-colors ${inert ? "cursor-not-allowed text-text_default_tertiary opacity-60" : "text-text_default_primary hover:bg-bg_interaction_tertiary_hover"}`}
      data-webui-placeholder-chrome={inert ? "rail-nav" : undefined}
      data-webui-nav-item={label}
      data-webui-nav-active={active ? "true" : "false"}
    >
      <WebuiButton
        variant="plain"
        size="regular"
        onClick={() => onSelect?.()}
        disabled={inert}
        aria-disabled={inert ? "true" : undefined}
        tabIndex={inert ? -1 : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 pr-2.5 text-left"
      >
        {icon ? (
          <span className="flex flex-shrink-0 items-center justify-center">
            {icon}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate whitespace-nowrap">
          {label}
        </span>
      </WebuiButton>
    </div>
  );
}
