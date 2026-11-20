import type {
  DesignDocument,
  DesignKind,
  DesignNode,
} from "../contracts/design.js";
import type { DesignPortDeclaration } from "./forms.mjs";
export {
  kindOf,
  modeOf,
  modeRecordOf,
  modesOf,
  roleOf,
  runModeOf,
  slotsOf,
} from "./forms.mjs";
export const NODE_GAP: number;
export const TILE_CARD: { readonly width: number; readonly height: number };
export function planPaste(input: {
  readonly clip: { readonly nodes: readonly DesignNode[] };
  readonly viewport: DesignDocument["viewport"];
  readonly viewportSize: { readonly width: number; readonly height: number };
  readonly idFor?: (node: DesignNode) => string;
}): readonly DesignNode[];
export function planBatchPlacement(input: {
  readonly count?: number;
  readonly sizes?: readonly {
    readonly width: number;
    readonly height: number;
  }[];
  readonly originX?: number;
  readonly originY?: number;
  readonly cardWidth?: number;
  readonly cardHeight?: number;
  readonly gap?: number;
  readonly perRow?: number;
}): {
  readonly columns: number;
  readonly rows: number;
  readonly cells: readonly {
    readonly index: number;
    readonly x: number;
    readonly y: number;
  }[];
};
export function pushAside(
  document: DesignDocument,
  placedIds: readonly string[],
  options?: { readonly gap?: number; readonly keepIds?: readonly string[] },
): DesignDocument;
export const BATCH_COUNTS: readonly string[];
export const BATCH_MODES: readonly string[];
export function mediaBoxFor(
  aspect: number,
  cardWidth: number,
  userSized?: boolean,
): { readonly width: number; readonly height: number };
export function planGridSplit(options: {
  readonly width: number;
  readonly height: number;
  readonly rows: number;
  readonly cols: number;
}): {
  readonly cells: readonly {
    readonly sx: number;
    readonly sy: number;
    readonly sw: number;
    readonly sh: number;
    readonly index: number;
    readonly x: number;
    readonly y: number;
  }[];
};
export function clampCropRect(rect: Readonly<Record<string, unknown>>): {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};
export function mentionCandidates(
  canvas: DesignDocument,
  node: DesignNode,
): readonly {
  readonly id: string;
  readonly title: string;
  readonly kind: DesignKind;
  readonly url: string;
  readonly upstream: boolean;
}[];
export function ownTextOf(canvas: DesignDocument, node: DesignNode): string;
export function portState(
  canvas: DesignDocument,
  node: DesignNode,
  port: DesignPortDeclaration,
): string;
export function fitParamsToCaps(
  params: Readonly<Record<string, unknown>>,
  caps?: Readonly<Record<string, unknown>>,
): Record<string, unknown>;
export function modelSummary(model: Readonly<Record<string, unknown>>): string;
export function fanOutParams(
  tool: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
): { params: Record<string, unknown>; label: string }[];
export function toolPrompt(
  tool: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
): string;
export function toolSizeReason(
  tool: Readonly<Record<string, unknown>>,
  size?: {
    readonly width?: number;
    readonly height?: number;
    readonly bytes?: number;
  },
): string | null;
export function dragPositions(
  origins: readonly {
    readonly id: string;
    readonly x: number;
    readonly y: number;
  }[],
  dx: number,
  dy: number,
  scale?: number,
): readonly { readonly id: string; readonly x: number; readonly y: number }[];
export function bandSelection(options: {
  readonly band: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  readonly viewport: {
    readonly x: number;
    readonly y: number;
    readonly k: number;
  };
  readonly nodes: readonly DesignNode[];
}): readonly string[];
