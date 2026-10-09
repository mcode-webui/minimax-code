/**
 * Phase 4: prompt profile validation.
 *
 * `AgentPromptProfile = 'desktop' | 'tui'` is a compile-time union with no runtime
 * check. An out-of-union value used to pass through silently: `profile.tui` became
 * `false`, `usesV2Prompts` answered false, and the catalog fell back to the legacy
 * renderer. A typo produced a working host running the wrong prompt text with no
 * error anywhere.
 *
 * The validation here accepts `undefined` on purpose: a caller that passes only
 * `--prompt-mode coding|work` never sets a profile, so requiring one would reject a
 * supported invocation. Only a present-but-invalid value throws.
 */

import { describe, expect, it } from 'vitest';

import {
  AGENT_PROMPT_PROFILES,
  assertAgentPromptProfile,
} from '../../../local-runtime-v2/src/service/agent/builtin/prompt-renderer.js';

describe('assertAgentPromptProfile', () => {
  it('accepts every declared profile', () => {
    for (const profile of AGENT_PROMPT_PROFILES) {
      expect(() => assertAgentPromptProfile(profile)).not.toThrow();
    }
  });

  it('accepts an absent profile, which is how --prompt-mode coding|work arrives', () => {
    // Headless callers set promptMode and never promptProfile. Requiring one would
    // break `--prompt-mode coding` and `--prompt-mode work`.
    expect(() => assertAgentPromptProfile(undefined)).not.toThrow();
  });

  it('rejects an out-of-union profile with a named error', () => {
    expect(() => assertAgentPromptProfile('webui')).toThrow(/Unknown agent prompt profile/);
    expect(() => assertAgentPromptProfile('webui')).toThrow(/desktop, tui/);
  });

  it('rejects near-miss values rather than degrading', () => {
    // The failure mode being fixed: these used to render, with the wrong prompt.
    for (const bad of ['', 'TUI', 'Desktop', 'tui ', 'coding', 'work']) {
      expect(() => assertAgentPromptProfile(bad), `profile ${JSON.stringify(bad)}`).toThrow(
        /Unknown agent prompt profile/,
      );
    }
  });

  it('names the offending value so a typo is diagnosable', () => {
    expect(() => assertAgentPromptProfile('tsi')).toThrow(/"tsi"/);
  });
});