import type { Box } from "./node-ui.mjs";
export function panelAnchor(input?: { readonly isClip?: boolean; readonly card?: Box | null; readonly button?: Box | null }): { readonly kind: "card" | "button" | "viewport"; readonly card?: Box; readonly button?: Box };
export function clipPlacement(input: { readonly card: Box; readonly size: { readonly width: number; readonly height: number }; readonly viewport: { readonly width: number; readonly height: number } }): { readonly left: number; readonly top: number; readonly side: "above" | "below" };
