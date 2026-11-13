import type { InternalSessionCreateInput, SessionRecord } from '../session-system/index.js';
import type { AgentTurnModelSelection } from './contracts.js';

/** `effectiveModel` is `provider/model`; splits at the first `/`. */
export function modelSelectionFromRecord(
  record: Pick<
    SessionRecord,
    'effectiveModel' | 'effectiveModelVariant' | 'effectiveModelThinking'
  >,
): AgentTurnModelSelection | undefined {
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
  selection: AgentTurnModelSelection,
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
