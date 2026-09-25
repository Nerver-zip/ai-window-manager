import { describe, expect, it } from 'vitest';
import {
  activationPolicyId,
  activationPolicyScopes,
  policyScopeForWindowKind,
  windowKindBelongsToPolicyScope,
} from '../../src/scheduler/policy-scope.js';

describe('activation policy scopes', () => {
  it('keeps Codex on its existing policy ID and assigns each Antigravity family its own ID', () => {
    expect(activationPolicyId('codex')).toBe('activation-codex');
    expect(activationPolicyId('antigravity', 'gemini')).toBe('activation-antigravity-gemini');
    expect(activationPolicyId('antigravity', 'claude_gpt')).toBe(
      'activation-antigravity-claude-gpt',
    );
    expect(activationPolicyId('antigravity', 'legacy')).toBe('activation-antigravity');
    expect(activationPolicyScopes('codex')).toEqual(['default']);
    expect(activationPolicyScopes('antigravity')).toEqual(['gemini', 'claude_gpt']);
  });

  it('matches only exact allowlisted Antigravity targets to their family', () => {
    expect(policyScopeForWindowKind('antigravity_gemini_five_hour')).toBe('gemini');
    expect(policyScopeForWindowKind('antigravity_claude_gpt_weekly')).toBe('claude_gpt');
    expect(policyScopeForWindowKind('five_hour')).toBeUndefined();
    expect(windowKindBelongsToPolicyScope('antigravity_gemini_weekly', 'gemini')).toBe(true);
    expect(windowKindBelongsToPolicyScope('antigravity_claude_gpt_five_hour', 'gemini')).toBe(
      false,
    );
    expect(windowKindBelongsToPolicyScope('five_hour', 'claude_gpt')).toBe(false);
  });
});
