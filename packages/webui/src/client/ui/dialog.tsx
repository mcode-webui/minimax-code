// The shared modal frame. Business callers supply meaning, body content,
// dismissal policy and commands; this module owns the common modal geometry.

import { IconX } from "@tabler/icons-react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWebuiBrowserCapabilities } from "../bindings/browser-capabilities.js";
import { useDialogLayer } from "./overlay-listeners.js";
import { ManagedOverlayBoundary } from "./overlay-listeners.js";
import { useOverlayCoordinator } from "./overlay-coordinator.js";
import { WebuiIconButton } from "./button.js";

export type WebuiDialogWidth = "compact" | "standard" | "wide";

export interface WebuiDialogProps {
  readonly id?: string;
  readonly parentLayerId?: string | null;
  readonly open?: boolean;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly headerActions?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly footerClassName?: string;
  readonly onClose: () => void;
  readonly closeLabel?: string;
  readonly closeTestId?: string;
  readonly dismissOnEscape?: boolean;
  readonly dismissOnBackdrop?: boolean;
  readonly width?: WebuiDialogWidth;
  readonly portalTarget: HTMLElement | null;
  readonly testId?: string;
  readonly dataAttributes?: Readonly<Record<string, string>>;
  readonly role?: "dialog" | "alertdialog";
  readonly showClose?: boolean;
  readonly initialFocusRef?: { readonly current: HTMLElement | null };
  readonly dialogRef?: (element: HTMLElement | null) => void;
}

const DialogFooterContext = createContext<HTMLElement | null>(null);

/** Render form-owned actions in the modal's fixed shared footer slot. */
export function WebuiDialogActions({ children }: { readonly children: ReactNode }): ReactElement | null {
  const footerTarget = useContext(DialogFooterContext);
  return footerTarget
    ? createPortal(<div className="webui-dialog-actions">{children}</div>, footerTarget)
    : null;
}

/** A modal whose header and action row stay visible while its body scrolls. */
export function WebuiDialog({
  id: requestedId,
  parentLayerId,
  open = true,
  title,
  description,
  headerActions,
  children,
  footer,
  footerClassName,
  onClose,
  closeLabel = "关闭",
  closeTestId,
  dismissOnEscape = false,
  dismissOnBackdrop = false,
  width = "standard",
  portalTarget,
  testId,
  dataAttributes,
  role = "dialog",
  showClose = true,
  initialFocusRef,
  dialogRef,
}: WebuiDialogProps): ReactElement | null {
  const [footerTarget, setFooterTarget] = useState<HTMLElement | null>(null);
  const generatedId = useId();
  const id = requestedId ?? `webui-dialog-${generatedId}`;
  const titleId = `${id}-title`;
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  const surfaceRef = useRef<HTMLElement | null>(null);
  const maskRef = useRef<HTMLDivElement | null>(null);
  const { dom } = useWebuiBrowserCapabilities();
  const coordinator = useOverlayCoordinator();
  const layerId = useDialogLayer({
    id,
    parentId: parentLayerId,
    active: open,
    dismissible: dismissOnEscape || dismissOnBackdrop,
    onClose,
  });

  useEffect(() => {
    if (!open || !surfaceRef.current) return;
    const surface = surfaceRef.current;
    const mask = maskRef.current;
    if (!mask) return;
    const descendantLayerIds = () => {
      const layers = coordinator?.layers() ?? [];
      const descendants = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const layer of layers) {
          if ((layer.parentId === id || (layer.parentId && descendants.has(layer.parentId))) && !descendants.has(layer.id)) {
            descendants.add(layer.id);
            changed = true;
          }
        }
      }
      return descendants;
    };
    const deactivate = dom.activateModalSurface(surface, mask, descendantLayerIds);
    (initialFocusRef?.current ?? surface).focus();
    return deactivate;
  }, [coordinator, dom, id, initialFocusRef, open]);

  if (!open || !portalTarget) return null;

  const dialog = (
    <div
      ref={maskRef}
      className="webui-dialog-mask"
      data-webui-dialog-scrim="true"
    >
      <section
        ref={(element) => {
          surfaceRef.current = element;
          dialogRef?.(element);
        }}
        data-webui-dialog-shell="true"
        data-overlay-layer={layerId}
        data-testid={testId}
        {...(dataAttributes ?? {})}
        className={`webui-dialog-surface webui-dialog-surface--${width}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        {...(descriptionId ? { "aria-describedby": descriptionId } : {})}
        tabIndex={-1}
      >
        <ManagedOverlayBoundary layerId={layerId}>
        <header className="webui-dialog-header">
          <div className="webui-dialog-heading">
            <h2 id={titleId}>{title}</h2>
            {descriptionId ? <p id={descriptionId}>{description}</p> : null}
          </div>
          {headerActions}
          {showClose ? (
            <WebuiIconButton
              label={closeLabel}
              data-testid={closeTestId}
              className="webui-dialog-close"
              onClick={onClose}
            >
              <IconX size={18} stroke={1.8} />
            </WebuiIconButton>
          ) : null}
        </header>
        <DialogFooterContext.Provider value={footerTarget}>
          <div className="webui-dialog-body">{children}</div>
          <footer
            ref={setFooterTarget}
            className={`webui-dialog-footer${footerClassName ? ` ${footerClassName}` : ""}`}
          >
            {footer}
          </footer>
        </DialogFooterContext.Provider>
        </ManagedOverlayBoundary>
      </section>
    </div>
  );

  return createPortal(dialog, portalTarget);
}
