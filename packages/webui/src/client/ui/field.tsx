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

import { useId, type ReactElement, type ReactNode } from "react";

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
      <div className={`webui-field webui-field--row${className ? ` ${className}` : ""}`}>
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
    <div className={`webui-field${className ? ` ${className}` : ""}`}>
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
