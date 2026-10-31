import { describe, expect, it } from 'vitest';
import {
  modelSelectionFromRecord,
  readMiniAppAgentModelSelection,
  sessionModelFields,
} from '../../../src/service/miniapp/agent/model-selection.js';

describe('Mini App model selection', () => {
  it('reads the contract shape and nothing else', () => {
    expect(
      readMiniAppAgentModelSelection({
        providerId: 'minimax',
        modelId: 'M3',
        variant: 'fast',
        thinking: { effort: 'high' },
        extra: 1,
      }),
    ).toEqual({
      providerId: 'minimax',
      modelId: 'M3',
      variant: 'fast',
      thinking: { effort: 'high' },
    });
    for (const bad of [
      null,
      {},
      { providerId: '', modelId: 'x' },
      { providerId: 'p', modelId: 'm', thinking: { effort: 3 } },
      { providerId: 'p', modelId: 'm', variant: 7 },
    ]) {
      expect(readMiniAppAgentModelSelection(bad)).toBeNull();
    }
  });

  it('round-trips a session record', () => {
    const selection = { providerId: 'minimax', modelId: 'M3', thinking: { effort: 'low' } };
    const fields = sessionModelFields(selection);
    expect(fields).toEqual({
      effectiveModel: 'minimax/M3',
      effectiveModelVariant: null,
      effectiveModelThinking: { effort: 'low' },
    });
    expect(modelSelectionFromRecord(fields)).toEqual(selection);
    expect(modelSelectionFromRecord({ effectiveModel: '' })).toBeUndefined();
    expect(
      modelSelectionFromRecord({
        effectiveModel: 'byok-acme/orion/with-slash',
        effectiveModelVariant: 'v',
      }),
    ).toEqual({ providerId: 'byok-acme', modelId: 'orion/with-slash', variant: 'v' });
  });

  it('keeps variant "" (thinking explicitly off) end to end, distinct from no variant', () => {
    expect(readMiniAppAgentModelSelection({ providerId: 'p', modelId: 'm', variant: '' })).toEqual({
      providerId: 'p',
      modelId: 'm',
      variant: '',
    });
    const off = { providerId: 'p', modelId: 'm', variant: '' };
    const fields = sessionModelFields(off);
    expect(fields.effectiveModelVariant).toBe('');
    expect(sessionModelFields({ providerId: 'p', modelId: 'm' }).effectiveModelVariant).toBeNull();
    expect(modelSelectionFromRecord(fields)).toEqual(off);
    expect(modelSelectionFromRecord({ ...fields, effectiveModelVariant: null })).toEqual({
      providerId: 'p',
      modelId: 'm',
    });
  });
});
