// The field contract (ADR 0028 § Shared contracts, #288).
//
// A field is a label, a description, a validation error and one control, and the
// four are connected by id and ARIA rather than placed near each other. The
// connection is the contract: a label that merely sits above an input leaves a
// screen reader announcing "edit text" with no name, and an error that merely
// sits below one is never announced at all.
//
// What belongs here: the wiring. What does not: submission, validation rules,
// pending and dirty state, and the business command behind the control. Those
// stay with the caller, which is why `control` is a render function — the caller
// owns the element, this owns the ids and the attributes that point at it.

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

/** The shared single-line text control. Appearance belongs to the field family. */
export interface WebuiTextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  readonly controlSize?: "regular" | "compact" | "dense";
  readonly appearance?: "boxed" | "bare";
  readonly textSize?: "small" | "regular" | "large";
  readonly textTone?: "primary" | "secondary";
  /** Layout only; the control appearance remains owned by this component. */
  readonly className?: string;
}

export const WebuiTextInput = forwardRef<HTMLInputElement, WebuiTextInputProps>(function WebuiTextInput(
  { controlSize = "regular", appearance = "boxed", textSize = "regular", textTone = "primary", className, ...props },
  ref,
): ReactElement {
  const classes = [
    "webui-control",
    controlSize === "compact" ? "webui-control--compact" : "",
    controlSize === "dense" ? "webui-control--dense" : "",
    appearance === "bare" ? "webui-control--bare" : "",
    textSize !== "regular" ? `webui-control--text-${textSize}` : "",
    textTone === "secondary" ? "webui-control--text-secondary" : "",
    className,
  ].filter(Boolean).join(" ");
  return <input {...props} ref={ref} className={classes} />;
});

/** The shared multi-line text control. */
export interface WebuiTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "size"> {
  readonly controlSize?: "regular" | "compact" | "large" | "document";
  readonly appearance?: "default" | "document";
  /** Layout only; the control appearance remains owned by this component. */
  readonly className?: string;
}

export const WebuiTextarea = forwardRef<
  HTMLTextAreaElement,
  WebuiTextareaProps
>(function WebuiTextarea({ controlSize = "regular", appearance = "default", className, ...props }, ref): ReactElement {
  return <textarea {...props} ref={ref} className={["webui-control", "webui-control--multiline", controlSize === "compact" ? "webui-control--compact" : "", controlSize === "large" ? "webui-control--large" : "", controlSize === "document" ? "webui-control--document" : "", appearance === "document" ? "webui-control--document-appearance" : "", className].filter(Boolean).join(" ")} />;
});

/** The shared native select control, including its focus and disabled states. */
export interface WebuiSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> {
  readonly controlSize?: "regular" | "compact" | "dense";
  readonly appearance?: "boxed" | "custom-chevron";
  readonly className?: string;
}

export const WebuiSelect = forwardRef<HTMLSelectElement, WebuiSelectProps>(function WebuiSelect(
  { controlSize = "regular", appearance = "boxed", className, ...props },
  ref,
): ReactElement {
  return <select {...props} ref={ref} className={["webui-control", controlSize === "compact" ? "webui-control--compact" : "", controlSize === "dense" ? "webui-control--dense" : "", appearance === "custom-chevron" ? "webui-control--custom-chevron" : "", className].filter(Boolean).join(" ")} />;
});

export const WebuiCheckbox = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type"> & { readonly className?: string }
>(function WebuiCheckbox({ className, ...props }, ref): ReactElement {
  return <input {...props} ref={ref} type="checkbox" className={["webui-checkbox", className].filter(Boolean).join(" ")} />;
});

export const WebuiRadio = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type"> & { readonly className?: string }
>(function WebuiRadio({ className, ...props }, ref): ReactElement {
  return <input {...props} ref={ref} type="radio" className={["webui-radio", className].filter(Boolean).join(" ")} />;
});

/** A visually hidden native file picker, triggered by its owning surface's button. */
export const WebuiFileInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">
>(function WebuiFileInput(props, ref): ReactElement {
  return <input {...props} ref={ref} type="file" className="webui-file-input" />;
});

export interface WebuiSearchFieldProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly onChange: NonNullable<InputHTMLAttributes<HTMLInputElement>["onChange"]>;
  readonly placeholder?: string;
  readonly appearance?: "regular" | "compact";
  /** Surface placement only; the search control's appearance stays shared. */
  readonly className?: string;
  readonly testId?: string;
}

/** A labelled search control with the shared icon, field and focus-within treatment. */
export function WebuiSearchField({
  icon,
  label,
  value,
  onChange,
  placeholder,
  appearance = "regular",
  className,
  testId,
}: WebuiSearchFieldProps): ReactElement {
  return (
    <label
      className={`webui-search-field webui-search-field--${appearance}${className ? ` ${className}` : ""}`}
      data-testid={testId}
    >
      <span className="webui-search-field-icon" aria-hidden="true">{icon}</span>
      <WebuiTextInput
        appearance="bare"
        controlSize="dense"
        className="webui-search-field-control"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
      />
    </label>
  );
}

/**
 * The attributes the contract owns. Every key here is a DOM attribute, so a
 * caller can spread the object onto an element as it is. The label's own id is
 * passed separately (`FieldContext`) because a control that spreads these props
 * would otherwise forward `labelId` to the DOM, which React rejects.
 */
export interface FieldControlProps {
  /** The id the label points at. */
  readonly id: string;
  /** Present when the field carries a description and/or an error. */
  readonly "aria-describedby"?: string;
  /** Present only while the field carries an error. */
  readonly "aria-invalid"?: true;
}

/** What the field knows that a control may need but must not spread. */
export interface FieldContext {
  /** The id of the label, for a control that points at it with `aria-labelledby`. */
  readonly labelId: string;
}

export interface WebuiFieldProps {
  readonly label: string;
  readonly description?: string;
  readonly error?: string;
  readonly required?: boolean;
  /** Shared label-to-control spacing; callers select a named step, never a CSS value. */
  readonly gap?: "compact" | "small";
  /**
   * How the label, the description and the error sit against the control.
   *
   * `stacked` puts the label above the control — a form that asks for several
   * things in sequence. `row` puts the label and the description on the left and
   * the control on the right — a settings row that changes one thing in place.
   * The two are arrangements of the same field, not two different fields.
   */
  readonly arrangement?: "stacked" | "row";
  readonly className?: string;
  readonly control: (props: FieldControlProps, field: FieldContext) => ReactNode;
}

/**
 * One field: label, optional description, optional error, and the control.
 *
 * The description and the error are both reachable from the control through
 * `aria-describedby`, in that order, so a reader hears what the field is for
 * before it hears what is wrong with it.
 */
export function WebuiField({
  label,
  description,
  error,
  required = false,
  gap = "compact",
  arrangement = "stacked",
  className,
  control,
}: WebuiFieldProps): ReactElement {
  const base = useId();
  const controlId = `${base}-control`;
  const labelId = `${base}-label`;
  const descriptionId = description ? `${base}-description` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  // A `<label for>` associates natively (clicking it focuses the control, and the
  // control takes its name from it); the id on the label is what a control that
  // cannot be named by `for` — a button that opens a listbox — points at through
  // `aria-labelledby`.
  const labelText = (
    <label className="webui-field-label" id={labelId} htmlFor={controlId}>
      {label}
      {required ? (
        <span aria-hidden="true" className="webui-field-required">
          {" *"}
        </span>
      ) : null}
    </label>
  );

  const descriptionText = description ? (
    <span className="webui-field-description" id={descriptionId}>
      {description}
    </span>
  ) : null;

  const errorText = error ? (
    // `role="alert"` announces the message when it appears; the control's
    // `aria-describedby` makes it reachable again afterwards.
    <span className="webui-field-error" id={errorId} role="alert">
      {error}
    </span>
  ) : null;

  const props: FieldControlProps = {
    id: controlId,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true as const } : {}),
  };
  const field: FieldContext = { labelId };

  if (arrangement === "row") {
    return (
      <div className={`webui-field webui-field--gap-${gap} webui-field--row${className ? ` ${className}` : ""}`}>
        <div className="webui-field-text">
          {labelText}
          {descriptionText}
          {errorText}
        </div>
        <div className="webui-field-control">{control(props, field)}</div>
      </div>
    );
  }

  return (
    <div className={`webui-field webui-field--gap-${gap}${className ? ` ${className}` : ""}`}>
      {labelText}
      {descriptionText}
      <div className="webui-field-control">{control(props, field)}</div>
      {errorText}
    </div>
  );
}

/** The arrangement of several fields inside one form. */
export function WebuiFormLayout({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return <div className={`webui-form${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** The actions a form ends with. The commands stay with the caller. */
export function WebuiFormActions({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement {
  return <div className={`webui-form-actions${className ? ` ${className}` : ""}`}>{children}</div>;
}
