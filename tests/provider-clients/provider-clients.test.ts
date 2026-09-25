import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  bumpProviderClientPins,
  checkProviderClientPins,
  compareStableVersions,
  createOfficialReleaseSource,
  discoverLatestStableRelease,
  parseProviderClientManifest,
  type OfficialReleaseSource,
  type ProviderClientId,
  type ProviderClientManifest,
} from '../../scripts/provider-clients-core.js';

const manifestFixture = JSON.parse(
  readFileSync(new URL('../../provider-clients.lock.json', import.meta.url), 'utf8'),
) as unknown;
const codexFixture = JSON.parse(
  readFileSync(new URL('./fixtures/codex-releases.json', import.meta.url), 'utf8'),
) as unknown;
const antigravityFixture = JSON.parse(
  readFileSync(new URL('./fixtures/antigravity-releases.json', import.meta.url), 'utf8'),
) as unknown;

interface ReleaseFixture {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: Array<{ name: string; digest?: string }>;
}

function releaseSource(
  releases: Partial<Record<ProviderClientId, unknown>>,
): OfficialReleaseSource {
  return (providerId) => Promise.resolve(releases[providerId] ?? null);
}

function cloneManifest(): ProviderClientManifest {
  return parseProviderClientManifest(structuredClone(manifestFixture));
}

function nextPatchVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

function lowerVersion(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  if (patch! > 0) return `${major}.${minor}.${patch! - 1}`;
  if (minor! > 0) return `${major}.${minor! - 1}.999`;
  if (major! > 0) return `${major! - 1}.999.999`;
  throw new Error('test manifest needs a version above 0.0.0');
}

function nextFixtureRelease(providerId: ProviderClientId, fixture: unknown): ReleaseFixture {
  const pin = cloneManifest().providers[providerId];
  const prefix = providerId === 'codex' ? 'rust-v' : '';
  const release = structuredClone(fixture) as ReleaseFixture;
  return { ...release, tag_name: `${prefix}${nextPatchVersion(pin.version)}` };
}

function releaseFromPin(providerId: ProviderClientId): ReleaseFixture {
  const pin = cloneManifest().providers[providerId];
  return {
    tag_name: pin.tag,
    draft: false,
    prerelease: false,
    published_at: '2026-09-24T00:00:00Z',
    assets: [
      { name: pin.assets.amd64.name, digest: `sha256:${pin.assets.amd64.sha256}` },
      { name: pin.assets.arm64.name, digest: `sha256:${pin.assets.arm64.sha256}` },
    ],
  };
}

describe('provider client source pins', () => {
  it('validates fixed official repositories and supported Linux assets', () => {
    const manifest = cloneManifest();

    expect(manifest.providers.codex).toMatchObject({
      repository: 'openai/codex',
      assets: {
        amd64: { name: 'codex-package-x86_64-unknown-linux-musl.tar.gz' },
        arm64: { name: 'codex-package-aarch64-unknown-linux-musl.tar.gz' },
      },
    });
    expect(manifest.providers.antigravity).toMatchObject({
      repository: 'google-antigravity/antigravity-cli',
      assets: {
        amd64: { name: 'agy_cli_linux_x64.tar.gz' },
        arm64: { name: 'agy_cli_linux_arm64.tar.gz' },
      },
    });
    expect(manifest.providers.codex.tag).toBe(`rust-v${manifest.providers.codex.version}`);
    expect(manifest.providers.antigravity.tag).toBe(manifest.providers.antigravity.version);
  });

  it('compares stable semantic versions numerically and rejects non-stable inputs', () => {
    expect(compareStableVersions('1.10.0', '1.9.99')).toBeGreaterThan(0);
    expect(compareStableVersions('2.0.0', '2.0.0')).toBe(0);
    expect(() => compareStableVersions('1.0.0-rc.1', '1.0.0')).toThrow(/stable semantic version/);
    expect(() => compareStableVersions('01.0.0', '1.0.0')).toThrow(/stable semantic version/);
  });

  it('accepts the official latest published stable semantic release and its architecture digests', async () => {
    const codexRelease = nextFixtureRelease('codex', codexFixture);
    const antigravityRelease = nextFixtureRelease('antigravity', antigravityFixture);
    const codex = await discoverLatestStableRelease(
      'codex',
      releaseSource({ codex: codexRelease }),
    );
    const antigravity = await discoverLatestStableRelease(
      'antigravity',
      releaseSource({ antigravity: antigravityRelease }),
    );

    expect(codex).toMatchObject({
      version: nextPatchVersion(cloneManifest().providers.codex.version),
      tag: `rust-v${nextPatchVersion(cloneManifest().providers.codex.version)}`,
      assets: {
        amd64: { sha256: 'c'.repeat(64) },
        arm64: { sha256: 'd'.repeat(64) },
      },
    });
    expect(antigravity).toMatchObject({
      version: nextPatchVersion(cloneManifest().providers.antigravity.version),
      tag: nextPatchVersion(cloneManifest().providers.antigravity.version),
      assets: {
        amd64: { sha256: 'e'.repeat(64) },
        arm64: { sha256: 'f'.repeat(64) },
      },
    });
  });

  it('reports pinned/latest versions and update availability for both providers', async () => {
    const manifest = cloneManifest();
    const releases = {
      codex: nextFixtureRelease('codex', codexFixture),
      antigravity: nextFixtureRelease('antigravity', antigravityFixture),
    };
    const result = await checkProviderClientPins(manifest, releaseSource(releases));

    expect(result).toEqual([
      {
        providerId: 'codex',
        displayName: 'Codex',
        pinnedVersion: manifest.providers.codex.version,
        latestVersion: nextPatchVersion(manifest.providers.codex.version),
        status: 'update-available',
      },
      {
        providerId: 'antigravity',
        displayName: 'Antigravity',
        pinnedVersion: manifest.providers.antigravity.version,
        latestVersion: nextPatchVersion(manifest.providers.antigravity.version),
        status: 'update-available',
      },
    ]);
  });

  it('bumps only version, tag, and per-architecture asset metadata', async () => {
    const before = cloneManifest();
    const codexRelease = nextFixtureRelease('codex', codexFixture);
    const antigravityRelease = nextFixtureRelease('antigravity', antigravityFixture);
    const result = await bumpProviderClientPins(
      before,
      releaseSource({ codex: codexRelease, antigravity: antigravityRelease }),
    );

    expect(result.updated).toEqual(['codex', 'antigravity']);
    expect(result.manifest.providers.codex).toEqual({
      ...before.providers.codex,
      version: codexRelease.tag_name.slice('rust-v'.length),
      tag: codexRelease.tag_name,
      assets: {
        amd64: {
          name: before.providers.codex.assets.amd64.name,
          sha256: 'c'.repeat(64),
        },
        arm64: {
          name: before.providers.codex.assets.arm64.name,
          sha256: 'd'.repeat(64),
        },
      },
    });
    expect(result.manifest.providers.antigravity).toEqual({
      ...before.providers.antigravity,
      version: antigravityRelease.tag_name,
      tag: antigravityRelease.tag_name,
      assets: {
        amd64: { name: before.providers.antigravity.assets.amd64.name, sha256: 'e'.repeat(64) },
        arm64: { name: before.providers.antigravity.assets.arm64.name, sha256: 'f'.repeat(64) },
      },
    });
    expect(before).toEqual(cloneManifest());

    const candidateStatus = await checkProviderClientPins(
      result.manifest,
      releaseSource({ codex: codexRelease, antigravity: antigravityRelease }),
    );
    expect(candidateStatus.map(({ status }) => status)).toEqual(['current', 'current']);
  });

  it('does not downgrade a pin and reports when a pin is ahead of the latest release', async () => {
    const manifest = cloneManifest();
    const codexVersion = lowerVersion(manifest.providers.codex.version);
    const antigravityVersion = lowerVersion(manifest.providers.antigravity.version);
    const releases = {
      codex: {
        tag_name: `rust-v${codexVersion}`,
        draft: false,
        prerelease: false,
        published_at: '2026-09-17T20:03:04Z',
        assets: [
          {
            name: manifest.providers.codex.assets.amd64.name,
            digest: `sha256:${'3'.repeat(64)}`,
          },
          {
            name: manifest.providers.codex.assets.arm64.name,
            digest: `sha256:${'4'.repeat(64)}`,
          },
        ],
      },
      antigravity: {
        tag_name: antigravityVersion,
        draft: false,
        prerelease: false,
        published_at: '2026-09-22T04:12:17Z',
        assets: [
          {
            name: manifest.providers.antigravity.assets.amd64.name,
            digest: `sha256:${'5'.repeat(64)}`,
          },
          {
            name: manifest.providers.antigravity.assets.arm64.name,
            digest: `sha256:${'6'.repeat(64)}`,
          },
        ],
      },
    };
    const status = await checkProviderClientPins(manifest, releaseSource(releases));
    const result = await bumpProviderClientPins(manifest, releaseSource(releases));

    expect(status.map(({ status: pinStatus }) => pinStatus)).toEqual([
      'pinned-ahead',
      'pinned-ahead',
    ]);
    expect(result.updated).toEqual([]);
    expect(result.manifest).toEqual(manifest);
  });

  it('fails closed when a stable release is missing either required digest', async () => {
    const noDigest = nextFixtureRelease('codex', codexFixture);
    delete noDigest.assets[0]!.digest;

    await expect(
      discoverLatestStableRelease('codex', releaseSource({ codex: noDigest })),
    ).rejects.toThrow(/missing GitHub SHA-256 metadata/);
  });

  it('fails closed for absent or malformed architecture assets and digests', async () => {
    const missingAsset = nextFixtureRelease('codex', codexFixture);
    missingAsset.assets = missingAsset.assets.slice(1);
    await expect(
      discoverLatestStableRelease('codex', releaseSource({ codex: missingAsset })),
    ).rejects.toThrow(/must publish exactly one amd64 asset/);

    const invalidDigest = nextFixtureRelease('codex', codexFixture);
    invalidDigest.assets[0]!.digest = 'sha256:not-a-digest';
    await expect(
      discoverLatestStableRelease('codex', releaseSource({ codex: invalidDigest })),
    ).rejects.toThrow(/invalid GitHub SHA-256 metadata/);
  });

  it('fails closed when the latest release is a draft, prerelease, unpublished, or non-semver', async () => {
    const validRelease = nextFixtureRelease('codex', codexFixture);
    const invalidReleases = [
      { ...structuredClone(validRelease), draft: true },
      { ...structuredClone(validRelease), prerelease: true },
      { ...structuredClone(validRelease), published_at: null },
      { ...structuredClone(validRelease), tag_name: `${validRelease.tag_name}-rc.1` },
    ];

    for (const release of invalidReleases) {
      await expect(
        discoverLatestStableRelease('codex', releaseSource({ codex: release })),
      ).rejects.toThrow(/not a published stable semantic version/);
    }
  });

  it('fails closed if metadata for an already pinned version changes', async () => {
    const release = releaseFromPin('codex');
    release.assets[0]!.digest = `sha256:${'0'.repeat(64)}`;

    await expect(
      checkProviderClientPins(
        cloneManifest(),
        releaseSource({ codex: release, antigravity: releaseFromPin('antigravity') }),
      ),
    ).rejects.toThrow(/release metadata differs from the pinned digest/);
  });

  it('uses only hard-coded official GitHub latest-release endpoints', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(codexFixture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const source = createOfficialReleaseSource(fetchMock);
    await source('codex');
    await source('antigravity');

    expect(
      fetchMock.mock.calls.map(([input]) =>
        input instanceof URL ? input.href : input instanceof Request ? input.url : input,
      ),
    ).toEqual([
      'https://api.github.com/repos/openai/codex/releases/latest',
      'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest',
    ]);
    await expect(source('evil' as ProviderClientId)).rejects.toThrow(/unsupported provider client/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails on HTTP errors and malformed latest-release responses', async () => {
    const failedFetch = createOfficialReleaseSource(
      vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 503 }))),
    );
    await expect(failedFetch('codex')).rejects.toThrow(/HTTP 503/);
    await expect(discoverLatestStableRelease('codex', () => Promise.resolve([]))).rejects.toThrow(
      /release entry is not an object/,
    );
  });

  it('requires exactly the known manifest provider IDs and official release metadata', () => {
    const invalid = structuredClone(manifestFixture) as {
      providers: Record<string, unknown>;
    };
    invalid.providers.other = {};
    expect(() => parseProviderClientManifest(invalid)).toThrow(/invalid schema/);

    const untrustedRepo = structuredClone(manifestFixture) as {
      providers: { codex: { repository: string } };
    };
    untrustedRepo.providers.codex.repository = 'attacker.invalid/tool';
    expect(() => parseProviderClientManifest(untrustedRepo)).toThrow(
      /must use the official repository/,
    );
  });
});
