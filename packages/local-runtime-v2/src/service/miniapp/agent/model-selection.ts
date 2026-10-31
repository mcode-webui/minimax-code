import type { InternalSessionCreateInput, SessionRecord } from '../../session-system/index.js';
import type { MiniAppAgentModelSelection } from './contracts.js';

/**
 * Reads the contract shape from untrusted input; anything else, extra fields included, is dropped.
 * `variant: ''` is legal and kept: it means thinking explicitly off.
 */
export function readMiniAppAgentModelSelection(value: unknown): MiniAppAgentModelSelection | null {
  if (!isRecord(value)) return null;
  const { providerId, modelId, variant } = value;
  if (!isNonEmptyString(providerId) || !isNonEmptyString(modelId)) return null;
  if (variant !== undefined && typeof variant !== 'string') return null;
  const thinking = readThinking(value.thinking);
  if (thinking === null) return null;
  return {
    providerId,
    modelId,
    ...(variant === undefined ? {} : { variant }),
    ...(thinking ? { thinking } : {}),
  };
}

/** `undefined` when absent, `null` when present but malformed. */
function readThinking(value: unknown): MiniAppAgentModelSelection['thinking'] | null {
  if (value === undefined) return undefined;
  return isRecord(value) && typeof value.effort === 'string' ? { effort: value.effort } : null;
}

/** `effectiveModel` is `provider/model`; splits at the first `/`. */
export function modelSelectionFromRecord(
  record: Pick<
    SessionRecord,
    'effectiveModel' | 'effectiveModelVariant' | 'effectiveModelThinking'
  >,
): MiniAppAgentModelSelection | undefined {
  const key = record.effectiveModel;
  const slash = key ? key.indexOf('/') : -1;
  if (!key || slash <= 0 || slash === key.length - 1) return undefined;
  const effort = record.effectiveModelThinking?.effort;
  return {
    providerId: key.slice(0, slash),
    modelId: key.slice(slash + 1),
    ...(typeof record.effectiveModelVariant === 'string'
      ? { variant: record.effectiveModelVariant }
      : {}),
    ...(effort ? { thinking: { effort } } : {}),
  };
}

export function sessionModelFields(
  selection: MiniAppAgentModelSelection,
): Pick<
  InternalSessionCreateInput,
  'effectiveModel' | 'effectiveModelVariant' | 'effectiveModelThinking'
> {
  return {
    effectiveModel: `${selection.providerId}/${selection.modelId}`,
    effectiveModelVariant: selection.variant ?? null,
    effectiveModelThinking: selection.thinking ? { effort: selection.thinking.effort } : null,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
