// The composer's permission-mode control: the pill and the popover it opens.
//
// The pill, its option table and the popover were 58 lines of the composer
// render plus four module constants that only this control reads. They live
// here now, together with the one glyph-per-mode helper, so what the control
// can say is defined beside the control.
//
// The open flag and the intent stay with the composer, because the trigger's
// click also closes the composer's other surfaces. The dismissal does not: the
// popover is a `WebuiDropdown`, so the shared skeleton owns the outside press
// and the Escape — the same way it does for every other dropdown in the client.

import type { ReactElement } from "react";

import { WebuiDropdown } from "../../../ui/Dropdown.js";

import type { WebuiPermissionMode } from "../../../features/settings/contracts/settings-port.js";
import type { WebuiIconProps } from "../../../shell/icons.js";
import {
  WebuiIconCheck,
  WebuiIconChevronDown,
  WebuiIconPermissionAuto,
  WebuiIconPermissionFull,
  WebuiIconPermissionRequest,
} from "../../../shell/icons.js";

type WebuiComposerPermissionMode = WebuiPermissionMode;

const PERMISSION_MODE_ORDER = ["default", "auto", "bypassPermissions"] as const;

interface WebuiComposerPermissionOption {
  readonly label: string;
  readonly description: string;
  readonly Icon: (props: WebuiIconProps) => ReactElement;
}

/** The popover's own question, and where "了解更多" points. The docs page is the
 *  public one the README already links; `/permission` is documented there. */
const PERMISSION_MODE_QUESTION = "应如何批准 minimax code 操作?";
const PERMISSION_MODE_LEARN_MORE = "了解更多";
const PERMISSION_MODE_DOCS_URL = "https://agent.minimax.io/docs/cli/features";

/** Ordered most-restrictive first, mirroring the `ask` / `auto` / `full` actions
 *  the `/permission` command takes. */
const PERMISSION_MODE_OPTION: Readonly<Record<WebuiComposerPermissionMode, WebuiComposerPermissionOption>> = {
  default: {
    label: "请求批准",
    description: "编辑外部文件和使用互联网时始终询问",
    Icon: WebuiIconPermissionRequest,
  },
  auto: {
    label: "帮我批准",
    description: "仅对检测到的风险操作请求批准",
    Icon: WebuiIconPermissionAuto,
  },
  bypassPermissions: {
    label: "完全访问权限",
    description: "可不受限制地访问互联网和你电脑上的任何文件",
    Icon: WebuiIconPermissionFull,
  },
};

/** The trigger and the rows share one glyph per mode, so the pill always
 *  previews the icon the popover marks as selected. */
function PermissionModeIcon({ mode }: { readonly mode: WebuiComposerPermissionMode }): ReactElement {
  const { Icon } = PERMISSION_MODE_OPTION[mode];
  return <Icon className="webui-composer-permission-icon" />;
}

export interface WebuiComposerPermissionControlProps {
  /** The live mode; `undefined` while the settings read has not answered. */
  readonly mode: WebuiComposerPermissionMode | undefined;
  readonly busy: boolean;
  readonly unavailable: boolean;
  readonly menuOpen: boolean;
  /** The trigger was pressed: the composer closes the other surfaces and toggles. */
  readonly onToggleRequest: () => void;
  readonly onClose: () => void;
  readonly onChangeMode: (mode: WebuiComposerPermissionMode) => void;
}

export function WebuiComposerPermissionControl({
  mode,
  busy,
  unavailable,
  menuOpen,
  onToggleRequest,
  onClose,
  onChangeMode,
}: WebuiComposerPermissionControlProps) {
  return (
    <WebuiDropdown
          managed
          managedLayerId="composer-permission"
      open={menuOpen}
      onOpen={onToggleRequest}
      onClose={onClose}
      role="menu"
      ariaLabel={PERMISSION_MODE_QUESTION}
      side="top"
      align="start"
      offset={8}
      wrapperClassName="webui-composer-permission-wrap"
      className="webui-composer-permission-menu"
      trigger={(triggerProps) => (
        <button
          type="button"
          {...triggerProps}
          className={`webui-composer-permission-button${mode === "bypassPermissions" ? " webui-composer-permission-button--warning" : ""}`}
          aria-label={mode ? `授权模式：${PERMISSION_MODE_OPTION[mode].label}` : "授权模式"}
          disabled={unavailable || busy || !mode}
          // The control drops its words when the composer is narrow and keeps a
          // shield instead, so the hover affordance has to carry the mode's
          // name (ADR 0025).
          title={unavailable
            ? "授权模式当前不可用"
            : mode
              ? `授权模式：${PERMISSION_MODE_OPTION[mode].label}`
              : undefined}
          data-testid="composer-permission-mode"
        >
          {mode ? <PermissionModeIcon mode={mode} /> : <WebuiIconPermissionRequest className="webui-composer-permission-icon" />}
          <span className="webui-composer-permission-label">{mode ? PERMISSION_MODE_OPTION[mode].label : unavailable ? "授权不可用" : "读取授权模式…"}</span>
          <WebuiIconChevronDown className="webui-composer-permission-chevron" />
        </button>
      )}
    >
      <div className="webui-composer-permission-header">
          <span className="webui-composer-permission-question">{PERMISSION_MODE_QUESTION}</span>
          <a
            className="webui-composer-permission-learn-more"
            href={PERMISSION_MODE_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {PERMISSION_MODE_LEARN_MORE}
          </a>
        </div>
        {PERMISSION_MODE_ORDER.map((option) => {
          const { label, description, Icon } = PERMISSION_MODE_OPTION[option];
          const active = mode === option;
          return (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              data-permission-mode={option}
              className="webui-composer-permission-option"
              // The dropdown keeps the popup mounted during its exit motion.
              // Once a choice closes it, do not repaint the leaving copy as
              // disabled/grey while the runtime write is in flight.
              disabled={busy && menuOpen}
              onClick={() => onChangeMode(option)}
            >
              <Icon className="webui-composer-permission-icon" />
              <span className="webui-composer-permission-copy">
                <span className="webui-composer-permission-label">{label}</span>
                <span className="webui-composer-permission-description">{description}</span>
              </span>
              {active ? <WebuiIconCheck className="webui-composer-permission-check" /> : null}
            </button>
          );
        })}
    </WebuiDropdown>
  );
}
