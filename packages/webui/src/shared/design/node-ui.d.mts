import type { DesignNode } from "../contracts/design.js";
export interface NodeOption { readonly value: string; readonly label: string; readonly hint?: string }
export interface NodeField { readonly key: string; readonly label: string; readonly value: string; readonly options: readonly NodeOption[]; readonly chip: string }
export interface CardLayers { readonly material: readonly string[]; readonly ops: readonly string[]; readonly above: readonly string[] }
export interface NodeMenuEntry { readonly label: string; readonly action: string; readonly disabled?: boolean; readonly danger?: boolean }
export interface NodePanel { readonly nodeId?: string; readonly type: string }
export interface ClipRange { readonly durationMs: number; readonly startMs: number; readonly endMs: number; readonly minMs: number }
export interface Box { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly width: number; readonly height: number }
export function nodeModeLabel(node: DesignNode): string;
export function nodeKindLabel(node: DesignNode, context?: { readonly inputKindLabels?: Readonly<Record<string, string>> }): string;
export function modeChoice(node: DesignNode, caps: Readonly<Record<string, unknown>>): { readonly value: string; readonly options: readonly NodeOption[] } | null;
export function openChip(panel: NodePanel | undefined | null, nodeId: string): string | null;
export function chipPress(panel: NodePanel | undefined | null, nodeId: string, kind: string): "close" | "open";
export function panelFields(fields: readonly NodeField[], scope: string): readonly NodeField[];
export function railParts(layers: CardLayers): readonly { readonly part: string; readonly where: "acts" | "main" }[];
export function paramFields(node: DesignNode, caps: Readonly<Record<string, unknown>>, context?: { readonly models?: readonly NodeOption[]; readonly voices?: readonly NodeOption[]; readonly counts?: readonly NodeOption[] }): readonly NodeField[];
export function paramSummary(fields: readonly NodeField[]): string;
export function cardLayers(node: DesignNode, context?: { readonly tools?: readonly Readonly<Record<string, unknown>>[] }): CardLayers;
export function opsSurfaceClass(layers: CardLayers): string;
export const OPS_GAP: number;
export function opsSide(input: { readonly nodeTop: number; readonly nodeBottom: number; readonly panelHeight: number; readonly viewTop: number; readonly viewBottom: number; readonly gap?: number; readonly prefer?: "below" | "above" }): "below" | "above";
export function opsOffset(input: { readonly rect?: Box; readonly view?: Box; readonly margin?: number }): number;
export function textAnchor(layers: CardLayers): string | null;
export function ratioGlyph(ratio: string, box?: { readonly width: number; readonly height: number }): { readonly width: number; readonly height: number; readonly adaptive: boolean };
export function modelRange(model: Readonly<Record<string, unknown>>): string;
export function errorActions(node: DesignNode): readonly { readonly key: string; readonly label: string }[];
export function nodeMenuEntries(node: DesignNode, context?: { readonly selectedCount?: number; readonly isGroup?: boolean; readonly canPaste?: boolean }): readonly (NodeMenuEntry | "-")[];
export function groupMembers(group: DesignNode | undefined, nodes: readonly DesignNode[]): readonly string[];
export const CLIP_MIN_MS: number;
export const CLIP_HANDLE_INSET: number;
export function stripPercent(ms: number, durationMs: number): number;
export function stripMsAt(input: { readonly clientX: number; readonly rectLeft?: number; readonly rectWidth?: number; readonly durationMs?: number }): number;
export function stripMsShift(input: { readonly baseMs: number; readonly deltaX: number; readonly rectWidth: number; readonly durationMs: number }): number;
export function stripAt(percent: number): string;
export function stripWidth(percent: number): string;
export function playheadMs(input?: { readonly ms?: number; readonly range?: ClipRange }): number;
export function clipRange(input?: { readonly durationMs?: number; readonly startMs?: number; readonly endMs?: number; readonly minMs?: number }): ClipRange;
export function timecode(ms: number): string;
export function clipClock(currentMs: number, totalMs: number): string;
export function durationLabel(ms: number): string;
export function isPlaying(media: { readonly paused: boolean; readonly ended: boolean } | null | undefined): boolean;
export function clipSeconds(range: ClipRange): { readonly start: number; readonly end: number };
export function clipSecond(ms: number): number;
export function previewAction(input?: { readonly currentSec?: number; readonly fromSec?: number; readonly toSec?: number; readonly ended?: boolean; readonly playing?: boolean }): { readonly type: "restart" | "pause" | "seek" | "continue"; readonly at: number };
