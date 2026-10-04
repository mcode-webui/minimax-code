// Owns the workspace canvas feature: the canvas document state, the zoom
// state, and the whole `webui-canvas-content` render. A different implementer
// works in this file; the container in `WorkspacePanels.tsx` only mounts it.

import { useEffect, useState, type ReactElement } from "react";
import type { WebuiCanvasDocument } from "../../server/port.js";

const DESKTOP_COPY = { canvasEmptyTitle: "把文件放到画布上", canvasEmptyDescription: "添加图片或其他工作区文件，然后自由排列和调整大小。" } as const;

export function WorkspaceCanvas({ sessionId, readCanvas }: {
  /** The session whose canvas document is shown; absent means no canvas. */
  readonly sessionId?: string;
  /** Port call that reads the canvas document for a session. */
  readonly readCanvas?: (request: { sessionId: string }) => Promise<WebuiCanvasDocument>;
}): ReactElement {
  const [canvas, setCanvas] = useState<WebuiCanvasDocument>();
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    if (!sessionId || !readCanvas) { setCanvas(undefined); return undefined; }
    let cancelled = false;
    void readCanvas({ sessionId }).then((next) => { if (!cancelled) setCanvas(next); }).catch(() => { if (!cancelled) setCanvas(undefined); });
    return () => { cancelled = true; };
  }, [sessionId, readCanvas]);
  return <div className="webui-canvas-content" onWheel={(event) => { event.preventDefault(); setZoom((value) => Math.max(.4, Math.min(2, value + (event.deltaY > 0 ? -.1 : .1)))); }}>
    {!canvas?.nodes.length ? <><strong>{DESKTOP_COPY.canvasEmptyTitle}</strong><p>{DESKTOP_COPY.canvasEmptyDescription}</p></> : <div className="webui-canvas-stage" style={{ transform: `scale(${zoom})` }}>{canvas.nodes.map((node) => <div className="webui-canvas-node" key={String(node.id)}>{String((node.file as Record<string, unknown> | undefined)?.fileName ?? node.id)}</div>)}</div>}
    <span className="webui-canvas-zoom">{Math.round(zoom * 100)}%</span>
  </div>;
}
