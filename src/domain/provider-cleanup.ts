export type ProviderCleanupArtifactKind = 'codex_thread' | 'antigravity_conversation';

export interface ProviderCleanupArtifact {
  kind: ProviderCleanupArtifactKind;
  externalId: string;
}
