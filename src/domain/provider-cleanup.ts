export type ProviderCleanupArtifactKind =
  'codex_thread' | 'antigravity_conversation' | 'opencode_session';

export interface ProviderCleanupArtifact {
  kind: ProviderCleanupArtifactKind;
  externalId: string;
}
