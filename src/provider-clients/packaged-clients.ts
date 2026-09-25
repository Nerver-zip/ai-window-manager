import {
  parseProviderClientManifest,
  type ProviderArchitecture,
} from '../../scripts/provider-clients-core.js';
import type { PackagedProviderClients } from './runtime-store.js';

export interface PackagedProviderExecutablePaths {
  readonly codex: string;
  readonly antigravity: string;
}

/** Builds the runtime-store descriptors only from the validated canonical release manifest. */
export function packagedProviderClients(
  manifestValue: unknown,
  executablePaths: PackagedProviderExecutablePaths,
): PackagedProviderClients {
  const manifest = parseProviderClientManifest(manifestValue);
  return {
    codex: {
      packagedExecutablePath: executablePaths.codex,
      packagedVersion: manifest.providers.codex.version,
      archiveExecutablePath: 'bin/codex',
    },
    antigravity: {
      packagedExecutablePath: executablePaths.antigravity,
      packagedVersion: manifest.providers.antigravity.version,
      archiveExecutablePath: 'antigravity',
    },
  };
}

export function providerArchitectureFromNode(value: string): ProviderArchitecture {
  if (value === 'x64') return 'amd64';
  if (value === 'arm64') return 'arm64';
  throw new Error('Unsupported provider-client runtime architecture');
}
