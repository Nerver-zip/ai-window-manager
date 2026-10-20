import type { SchedulePolicyScope } from '../storage/repositories.js';

export type ActivationPolicyScope = 'default' | 'gemini' | 'claude_gpt' | 'argon';

export const ANTIGRAVITY_POLICY_SCOPES = ['gemini', 'claude_gpt', 'argon'] as const;

const ANTIGRAVITY_POLICY_IDS: Record<Exclude<ActivationPolicyScope, 'default'>, string> = {
  gemini: 'activation-antigravity-gemini',
  claude_gpt: 'activation-antigravity-claude-gpt',
  argon: 'activation-antigravity-argon',
};

export function activationPolicyId(
  providerId: string,
  scope: SchedulePolicyScope = 'default',
): string {
  if (scope === 'legacy') return `activation-${providerId}`;
  if (providerId !== 'antigravity' || scope === 'default') return `activation-${providerId}`;
  return ANTIGRAVITY_POLICY_IDS[scope];
}

export function activationPolicyScopes(providerKind: string): readonly ActivationPolicyScope[] {
  return providerKind === 'antigravity' ? ANTIGRAVITY_POLICY_SCOPES : ['default'];
}

export function policyScopeForWindowKind(windowKind: string): ActivationPolicyScope | undefined {
  if (windowKind.startsWith('antigravity_gemini_')) return 'gemini';
  if (windowKind.startsWith('antigravity_claude_gpt_')) return 'claude_gpt';
  if (windowKind === 'antigravity_argon_weekly') return 'argon';
  return undefined;
}

export function windowKindBelongsToPolicyScope(
  windowKind: string,
  scope: ActivationPolicyScope,
): boolean {
  if (scope === 'default') return true;
  if (scope === 'gemini') {
    return (
      windowKind === 'antigravity_gemini_five_hour' || windowKind === 'antigravity_gemini_weekly'
    );
  }
  if (scope === 'claude_gpt') {
    return (
      windowKind === 'antigravity_claude_gpt_five_hour' ||
      windowKind === 'antigravity_claude_gpt_weekly'
    );
  }
  return windowKind === 'antigravity_argon_weekly';
}
