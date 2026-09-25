import { describe, expect, it } from 'vitest';
import {
  packagedProviderClients,
  providerArchitectureFromNode,
} from '../../src/provider-clients/packaged-clients.js';

const manifest = {
  schemaVersion: 1,
  providers: {
    codex: {
      repository: 'openai/codex',
      version: '0.157.0',
      tag: 'rust-v0.157.0',
      assets: {
        amd64: { name: 'codex-package-x86_64-unknown-linux-musl.tar.gz', sha256: 'a'.repeat(64) },
        arm64: { name: 'codex-package-aarch64-unknown-linux-musl.tar.gz', sha256: 'b'.repeat(64) },
      },
    },
    antigravity: {
      repository: 'google-antigravity/antigravity-cli',
      version: '1.2.11',
      tag: '1.2.11',
      assets: {
        amd64: { name: 'agy_cli_linux_x64.tar.gz', sha256: 'c'.repeat(64) },
        arm64: { name: 'agy_cli_linux_arm64.tar.gz', sha256: 'd'.repeat(64) },
      },
    },
  },
};

describe('packaged provider clients', () => {
  it('derives only versions from the validated manifest and uses fixed executable paths', () => {
    expect(
      packagedProviderClients(manifest, {
        codex: '/opt/codex/bin/codex',
        antigravity: '/opt/antigravity/bin/agy',
      }),
    ).toEqual({
      codex: {
        packagedExecutablePath: '/opt/codex/bin/codex',
        packagedVersion: '0.157.0',
        archiveExecutablePath: 'bin/codex',
      },
      antigravity: {
        packagedExecutablePath: '/opt/antigravity/bin/agy',
        packagedVersion: '1.2.11',
        archiveExecutablePath: 'antigravity',
      },
    });
  });

  it('rejects a manifest whose provider repository differs from the official allowlist', () => {
    expect(() =>
      packagedProviderClients(
        {
          ...manifest,
          providers: {
            ...manifest.providers,
            codex: { ...manifest.providers.codex, repository: 'attacker/repository' },
          },
        },
        { codex: '/opt/codex/bin/codex', antigravity: '/opt/antigravity/bin/agy' },
      ),
    ).toThrow(/official repository/);
  });

  it('maps only supported Docker architectures', () => {
    expect(providerArchitectureFromNode('x64')).toBe('amd64');
    expect(providerArchitectureFromNode('arm64')).toBe('arm64');
    expect(() => providerArchitectureFromNode('ia32')).toThrow(/Unsupported/);
  });
});
