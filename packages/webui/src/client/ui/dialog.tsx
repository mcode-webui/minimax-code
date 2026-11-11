// The shared modal frame. Business callers supply meaning, body content,
// dismissal policy and commands; this module owns the common modal geometry.

import { IconX } from "@tabler/icons-react";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWebuiBrowserCapabilities } from "../bindings/browser-capabilities.js";
import { useDialogLayer } from "./overlay-listeners.js";
import { ManagedOverlayBoundary } from "./overlay-listeners.js";
import { useOverlayCoordinator } from "./overlay-coordinator.js";
import { WebuiIconButton } from "./button.js";
import { isWebuiMotionExitAnimation, WebuiMotion, WebuiPage, WebuiSkeletonProjection } from "./page.js";

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The sizes a dialog can be drawn at.
 *
 * "compact" and "standard" are the usual surfaces; "wide" is the roomy form
 * a list or a form needs; "expanded" is the room a terminal needs — a shell
 * with a fixed grid, which fits far fewer columns than a text editor would.
 *
 * The sizes are the shared shell's: a caller that needs a different capacity
 * says which one it needs and the shell draws it. A caller that reached into
 * the shell's own rules to widen its window would be dressing another
 * contract's class names, and the shell would not know how wide it had been
 * made.
 */
export type WebuiDialogWidth = "compact" | "standard" | "wide" | "expanded";

export interface WebuiDialogProps {
  readonly id?: string;
  readonly parentLayerId?: string | null;
  readonly open?: boolean;
  readonly loading?: boolean;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly headerActions?: ReactNode;
  /**
   * The dialog's body. Optional: a confirmation that states its whole case in
   * the title and the description has no body, and the surface then renders no
   * body region at all.
   */
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly bodyClassName?: string;
  readonly footerClassName?: string;
  readonly onClose: () => void;
  readonly onExitComplete?: () => void;
  readonly closeLabel?: string;
  readonly closeTestId?: string;
  readonly dismissOnEscape?: boolean;
  /** Defaults to true; pass false when dismissal must be blocked. */
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

interface DialogPresentationSnapshot {
  readonly loading: boolean;
  readonly title: ReactNode;
  readonly description: ReactNode | undefined;
  readonly headerActions: ReactNode;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly bodyClassName: string | undefined;
  readonly footerClassName: string | undefined;
  readonly width: WebuiDialogWidth;
  readonly testId: string | undefined;
  readonly dataAttributes: Readonly<Record<string, string>> | undefined;
  readonly role: "dialog" | "alertdialog";
  readonly showClose: boolean;
  readonly closeLabel: string;
  readonly closeTestId: string | undefined;
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
  loading = false,
  title,
  description,
  headerActions,
  children,
  footer,
  bodyClassName,
  footerClassName,
  onClose,
  onExitComplete,
  closeLabel = "关闭",
  closeTestId,
  dismissOnEscape = false,
  dismissOnBackdrop = true,
  width = "standard",
  portalTarget,
  testId,
  dataAttributes,
  role = "dialog",
  showClose = true,
  initialFocusRef,
  dialogRef,
}: WebuiDialogProps): ReactElement | null {
  const [present, setPresent] = useState(open);
  const [motionState, setMotionState] = useState<"enter" | "exit">("enter");
  const [footerTarget, setFooterTarget] = useState<HTMLElement | null>(null);
  const generatedId = useId();
  const id = requestedId ?? `webui-dialog-${generatedId}`;
  const titleId = `${id}-title`;
  const currentPresentation: DialogPresentationSnapshot = {
    loading,
    title,
    description,
    headerActions,
    children,
    footer,
    bodyClassName,
    footerClassName,
    width,
    testId,
    dataAttributes,
    role,
    showClose,
    closeLabel,
    closeTestId,
  };
  const presentationRef = useRef(currentPresentation);
  useIsomorphicLayoutEffect(() => {
    if (open) presentationRef.current = currentPresentation;
  });
  const presentation = open ? currentPresentation : presentationRef.current;
  const descriptionId = presentation.description === undefined ? undefined : `${id}-description`;
  const hasBody = presentation.children !== null && presentation.children !== undefined && presentation.children !== false;
  const surfaceRef = useRef<HTMLElement | null>(null);
  const maskRef = useRef<HTMLDivElement | null>(null);
  const { dom } = useWebuiBrowserCapabilities();
  const coordinator = useOverlayCoordinator();
  const layerId = useDialogLayer({
    id,
    parentId: parentLayerId,
    active: open,
    dismissOnEscape,
    dismissOnBackdrop,
    onClose,
  });

  useEffect(() => {
    if (!open) {
      maskRef.current?.toggleAttribute("inert", true);
      surfaceRef.current?.toggleAttribute("inert", true);
      if (present) setMotionState("exit");
      return;
    }
    maskRef.current?.removeAttribute("inert");
    surfaceRef.current?.removeAttribute("inert");
    setPresent(true);
    setMotionState("enter");
  }, [open, present]);

  useEffect(() => {
    if (!present || !surfaceRef.current) return;
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
    return deactivate;
  }, [coordinator, dom, id, present]);

  useEffect(() => {
    if (open && surfaceRef.current) (initialFocusRef?.current ?? surfaceRef.current).focus();
  }, [initialFocusRef, open, present]);

  if (!present || !portalTarget) return null;

  const finishExit = (event: React.AnimationEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target || !isWebuiMotionExitAnimation(event.animationName, "surface") || motionState !== "exit" || open) return;
    setPresent(false);
    onExitComplete?.();
  };

  const dialog = (
    <WebuiMotion as="div" kind="surface" state={motionState} direction="none"
      onAnimationEnd={finishExit}
      ref={(element) => {
        maskRef.current = element as HTMLDivElement | null;
        element?.toggleAttribute("inert", !open);
      }}
      className="webui-dialog-mask"
      data-webui-dialog-scrim="true"
      aria-hidden={!open || undefined}
    >
      <WebuiPage
        as="section"
        kind="dialog"
        motion={{ kind: "surface", state: motionState, direction: "up" }}
        loading={presentation.loading}
        ref={(element) => {
          surfaceRef.current = element;
          element?.toggleAttribute("inert", !open);
          dialogRef?.(element);
        }}
        data-webui-dialog-shell="true"
        data-overlay-layer={layerId}
        data-testid={presentation.testId}
        {...(presentation.dataAttributes ?? {})}
        data-webui-dialog-has-body={hasBody ? "true" : "false"}
        className={`webui-dialog-surface webui-dialog-surface--${presentation.width}`}
        role={presentation.role}
        aria-modal="true"
        aria-hidden={!open || undefined}
        aria-labelledby={titleId}
        {...(descriptionId ? { "aria-describedby": descriptionId } : {})}
        tabIndex={-1}
      >
        <ManagedOverlayBoundary layerId={layerId}>
        <header className="webui-dialog-header">
          <div className="webui-dialog-heading">
            <h2 id={titleId}><WebuiSkeletonProjection>{presentation.title}</WebuiSkeletonProjection></h2>
            {descriptionId ? <p id={descriptionId}><WebuiSkeletonProjection>{presentation.description}</WebuiSkeletonProjection></p> : null}
          </div>
          <WebuiSkeletonProjection>{presentation.headerActions}</WebuiSkeletonProjection>
          {presentation.showClose ? (
            <WebuiIconButton
              label={presentation.closeLabel}
              data-testid={presentation.closeTestId}
              className="webui-dialog-close"
              onClick={onClose}
            >
              <IconX size={18} stroke={1.8} />
            </WebuiIconButton>
          ) : null}
        </header>
        <DialogFooterContext.Provider value={footerTarget}>
          {hasBody ? <div className={`webui-dialog-body${presentation.bodyClassName ? ` ${presentation.bodyClassName}` : ""}`}><WebuiSkeletonProjection>{presentation.children}</WebuiSkeletonProjection></div> : null}
          <footer
            ref={setFooterTarget}
            className={`webui-dialog-footer${presentation.footerClassName ? ` ${presentation.footerClassName}` : ""}`}
          >
            <WebuiSkeletonProjection>{presentation.footer}</WebuiSkeletonProjection>
          </footer>
        </DialogFooterContext.Provider>
        </ManagedOverlayBoundary>
      </WebuiPage>
    </WebuiMotion>
  );

  return createPortal(dialog, portalTarget);
}
