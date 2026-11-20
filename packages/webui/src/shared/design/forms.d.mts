import type { DesignKind, DesignNode, DesignNodeType } from "../contracts/design.js";
export interface DesignPortDeclaration { readonly kind: DesignKind; readonly role?: string; readonly label?: string }
export interface DesignMode { readonly id: string; readonly label: string; readonly ports: readonly DesignPortDeclaration[]; readonly needs?: readonly DesignKind[]; readonly path?: string; readonly reads?: string }
export interface DesignNodeForm { readonly label: string; readonly role: "input" | "generate" | "result" | "group"; readonly kind: DesignKind | null; readonly creatable: boolean }
export const DATA_KINDS: readonly DesignKind[];
export const KIND_LABELS: Readonly<Record<DesignKind, string>>;
export const NODE_FORMS: Readonly<Record<DesignNodeType, DesignNodeForm>>;
export const NODE_MODES: Readonly<Partial<Record<DesignNodeType, readonly DesignMode[]>>>;
export const NODE_KINDS: readonly { readonly role: DesignNodeForm["role"]; readonly kind: DesignKind | null; readonly label: string; readonly type: DesignNodeType }[];
export const NODE_TYPES: readonly DesignNodeType[];
export const CREATABLE_TYPES: readonly DesignNodeType[];
export const NODE_ROLES: Readonly<Record<DesignNodeType, DesignNodeForm["role"]>>;
export function kindLabel(kind: string): string;
export function roleOf(node: DesignNode): DesignNodeForm["role"];
export function kindOf(node: DesignNode): DesignKind;
export function modeOf(node: DesignNode): string;
export function modesOf(node: DesignNode): readonly DesignMode[];
export function modesFor(node: DesignNode, caps?: Readonly<Record<string, unknown>> | null): readonly DesignMode[];
export function modeRecordOf(node: DesignNode): DesignMode | null;
export function modeRecordById(id: string): DesignMode | null;
export function currentModeId(id?: string | null): string;
export function modeLabelOf(node: DesignNode, modeId: string): string;
export function materialToRead(modeId: string): string;
export function runModeOf(node: DesignNode): string;
export function inputsOf(node: DesignNode): readonly DesignPortDeclaration[];
export function acceptsOf(node: DesignNode): readonly DesignKind[];
export function pathOf(node: DesignNode): string;
export function modeForKinds(type: DesignNodeType, kinds?: readonly DesignKind[]): string;
export function slotsOf(node: DesignNode): { readonly inputs: readonly DesignPortDeclaration[]; readonly outputs: readonly DesignPortDeclaration[] };
export function cardTools<T extends { readonly key: string; readonly kind: string }>(node: DesignNode, tools?: readonly T[]): readonly T[];
export function ratioLabel(ratio: string, options?: Readonly<Record<string, unknown>>): string;
export function ratioOptionsFor(node: DesignNode, caps?: Readonly<Record<string, unknown>>): readonly string[];
export function hasTextBox(node: DesignNode): boolean;
export function portKinds(node: DesignNode): readonly DesignKind[];
export function portList(node: DesignNode, caps?: Readonly<Record<string, unknown>> | null): readonly DesignPortDeclaration[];
export function portKindsFor(node: DesignNode, caps?: Readonly<Record<string, unknown>> | null): readonly DesignKind[];
export function stripInputs(node: DesignNode, caps?: Readonly<Record<string, unknown>> | null): readonly DesignPortDeclaration[];
