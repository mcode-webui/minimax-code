import type { DesignDocument, DesignNode, DesignTask, DesignTemplate } from "../contracts/design.js";
export interface DesignActionContext { readonly sizes?: Readonly<Record<string, unknown>>; readonly modelsByType?: Readonly<Record<string, unknown>>; readonly defaultModelKey?: string | null; readonly promptTemplates?: readonly unknown[]; readonly idFor?: (prefix: string) => string; readonly [key: string]: unknown }
export function applyAction(canvas: DesignDocument, action: { type: string; args: Readonly<Record<string, unknown>> }, context?: DesignActionContext): { canvas: DesignDocument; error?: string; info?: Readonly<Record<string, unknown>> };
export function applyTemplate(canvas: DesignDocument, template: DesignTemplate, context?: DesignActionContext): { canvas: DesignDocument; error?: string; info?: Readonly<Record<string, unknown>> };
export function runSpecFor(canvas: DesignDocument, node: DesignNode | undefined, context?: DesignActionContext): Record<string, unknown> & { error?: string };
export function runFingerprintFor(spec: Readonly<Record<string, unknown>>): string;
export function validateRunSpec(spec: Readonly<Record<string, unknown>>): string | undefined;
export function materializeResults(canvas: DesignDocument, node: DesignNode, task: DesignTask, context?: DesignActionContext): { canvas: DesignDocument; error?: string };
export function templateFromCanvas(canvas: DesignDocument, options?: { id?: string; title?: string }): DesignTemplate;
export function templateFile(template: DesignTemplate): DesignTemplate;
export function readTemplateFile(text: string): { readonly ok: true; readonly template: DesignTemplate } | { readonly ok: false; readonly error: string };
export function templateStepsError(actions: unknown): string;
export function linesDroppedByMode(canvas: DesignDocument, node: DesignNode, mode: string): unknown[];
export function pendingAncestors(canvas: DesignDocument, node: DesignNode): DesignNode[];
