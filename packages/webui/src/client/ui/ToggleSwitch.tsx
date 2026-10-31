import type { ButtonHTMLAttributes, ReactElement } from "react";

type ToggleSwitchProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-checked" | "aria-label" | "onChange" | "role" | "type"
> & {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange?: (checked: boolean) => void;
  readonly testId?: string;
};

/** Shared switch appearance and semantics for every binary WebUI setting. */
export function ToggleSwitch({
  checked,
  label,
  onChange,
  testId,
  className,
  disabled = false,
  ...buttonProps
}: ToggleSwitchProps): ReactElement {
  return (
    <button
      {...buttonProps}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      className={`webui-toggle-switch${checked ? " is-checked" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => onChange?.(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}
