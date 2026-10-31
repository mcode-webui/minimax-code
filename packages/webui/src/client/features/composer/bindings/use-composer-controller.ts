import { useEffect, useRef, useSyncExternalStore } from "react";
import { useWebuiApplicationOptional } from "../../../bindings/application-context.js";
import type { WebuiComposerController, WebuiComposerControllerSnapshot } from "../contracts/composer-controller.js";

const subscribeNone = (): (() => void) => () => undefined;
const getNoSnapshot = (): undefined => undefined;

export function useComposerController(sessionId: string | undefined): {
  readonly controller: WebuiComposerController | undefined;
  readonly snapshot: WebuiComposerControllerSnapshot | undefined;
  readonly isAttachedTo: (sessionId: string | undefined) => boolean;
} {
  const application = useWebuiApplicationOptional();
  const controller = application?.composerController;
  const currentSession = useRef(sessionId);
  const attached = useRef(false);
  currentSession.current = sessionId;
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? subscribeNone,
    controller?.getSnapshot ?? getNoSnapshot,
    controller?.getSnapshot ?? getNoSnapshot,
  );
  useEffect(() => {
    if (!controller) return undefined;
    attached.current = true;
    const release = controller.attachView(sessionId);
    return () => {
      attached.current = false;
      release();
    };
  }, [controller, sessionId]);
  return {
    controller,
    snapshot,
    isAttachedTo: (targetSessionId: string | undefined) =>
      attached.current && currentSession.current === targetSessionId,
  };
}
