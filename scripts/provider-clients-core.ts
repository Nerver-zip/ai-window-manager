import { z } from 'zod';

export const PROVIDER_CLIENTS = {
  codex: {
    displayName: 'Codex',
    repository: 'openai/codex',
    tagPrefix: 'rust-v',
    assets: {
      amd64: 'codex-package-x86_64-unknown-linux-musl.tar.gz',
      arm64: 'codex-package-aarch64-unknown-linux-musl.tar.gz',
    },
  },
  antigravity: {
    displayName: 'Antigravity',
    repository: 'google-antigravity/antigravity-cli',
    tagPrefix: '',
    assets: {
      amd64: 'agy_cli_linux_x64.tar.gz',
      arm64: 'agy_cli_linux_arm64.tar.gz',
    },
  },
} as const;

export type ProviderClientId = keyof typeof PROVIDER_CLIENTS;
export type ProviderArchitecture = 'amd64' | 'arm64';

const stableVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

const assetSchema = z
  .object({
    name: z.string().min(1),
    sha256: z.string().regex(sha256Pattern),
  })
  .strict();

const providerPinSchema = z
  .object({
    repository: z.string().min(1),
    version: z.string().regex(stableVersionPattern),
    tag: z.string().min(1),
    assets: z.object({ amd64: assetSchema, arm64: assetSchema }).strict(),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    providers: z
      .object({
        codex: providerPinSchema,
        antigravity: providerPinSchema,
      })
      .strict(),
  })
  .strict();

export type ProviderClientManifest = z.infer<typeof manifestSchema>;
export type ProviderClientPin = ProviderClientManifest['providers'][ProviderClientId];

export interface LatestProviderClientRelease {
  version: string;
  tag: string;
  assets: Record<ProviderArchitecture, { name: string; sha256: string }>;
  publishedAt: string;
}

export type OfficialReleaseSource = (providerId: ProviderClientId) => Promise<unknown>;

export type PinStatus = 'current' | 'update-available' | 'pinned-ahead';

export interface ProviderClientStatus {
  providerId: ProviderClientId;
  displayName: string;
  pinnedVersion: string;
  latestVersion: string;
  status: PinStatus;
}

interface ReleaseRecord {
  tag: string;
  version: string;
  publishedAt: string;
  assets: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertProviderId(value: string): asserts value is ProviderClientId {
  if (!Object.hasOwn(PROVIDER_CLIENTS, value)) {
    throw new Error(`unsupported provider client: ${value}`);
  }
}

export function parseProviderClientManifest(value: unknown): ProviderClientManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('provider-clients.lock.json has an invalid schema');
  }

  for (const providerId of Object.keys(PROVIDER_CLIENTS) as ProviderClientId[]) {
    const expected = PROVIDER_CLIENTS[providerId];
    const pin = parsed.data.providers[providerId];
    if (pin.repository !== expected.repository) {
      throw new Error(`${providerId} must use the official repository ${expected.repository}`);
    }
    if (pin.tag !== `${expected.tagPrefix}${pin.version}`) {
      throw new Error(`${providerId} tag does not match its stable version`);
    }
    for (const architecture of ['amd64', 'arm64'] as const) {
      if (pin.assets[architecture].name !== expected.assets[architecture]) {
        throw new Error(`${providerId} has an unexpected ${architecture} release asset`);
      }
    }
  }

  return parsed.data;
}

function parseVersion(version: string): [number, number, number] {
  if (!stableVersionPattern.test(version)) {
    throw new Error(`not a stable semantic version: ${version}`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`semantic version component is out of range: ${version}`);
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function compareStableVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function parseReleaseRecord(
  value: unknown,
  providerId: ProviderClientId,
): ReleaseRecord | undefined {
  if (!isRecord(value)) throw new Error('GitHub release entry is not an object');
  if (typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean') {
    throw new Error('GitHub release entry is missing publication flags');
  }
  if (value.draft || value.prerelease) return undefined;
  if (typeof value.tag_name !== 'string')
    throw new Error('GitHub release entry is missing its tag');
  if (typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at))) {
    return undefined;
  }

  const config = PROVIDER_CLIENTS[providerId];
  if (!value.tag_name.startsWith(config.tagPrefix)) return undefined;
  const version = value.tag_name.slice(config.tagPrefix.length);
  if (!stableVersionPattern.test(version)) return undefined;
  if (!Array.isArray(value.assets)) throw new Error('GitHub release entry has invalid assets');

  return {
    tag: value.tag_name,
    version,
    publishedAt: value.published_at,
    assets: value.assets,
  };
}

function readReleaseAsset(
  release: ReleaseRecord,
  providerId: ProviderClientId,
  architecture: ProviderArchitecture,
): { name: string; sha256: string } {
  const expectedName = PROVIDER_CLIENTS[providerId].assets[architecture];
  const matches: Record<string, unknown>[] = [];
  for (const asset of release.assets) {
    if (isRecord(asset) && asset.name === expectedName) matches.push(asset);
  }
  if (matches.length !== 1) {
    throw new Error(
      `${providerId} ${release.tag} must publish exactly one ${architecture} asset ${expectedName}`,
    );
  }
  const matchingAsset = matches[0];
  if (!matchingAsset) throw new Error(`${providerId} ${release.tag} is missing ${expectedName}`);
  const digest = matchingAsset.digest;
  if (typeof digest !== 'string' || !digest.startsWith('sha256:')) {
    throw new Error(
      `${providerId} ${release.tag} is missing GitHub SHA-256 metadata for ${expectedName}`,
    );
  }
  const sha256 = digest.slice('sha256:'.length).toLowerCase();
  if (!sha256Pattern.test(sha256)) {
    throw new Error(
      `${providerId} ${release.tag} has invalid GitHub SHA-256 metadata for ${expectedName}`,
    );
  }
  return { name: expectedName, sha256 };
}

export async function discoverLatestStableRelease(
  providerId: ProviderClientId,
  fetchRelease: OfficialReleaseSource,
): Promise<LatestProviderClientRelease> {
  assertProviderId(providerId);
  const response = await fetchRelease(providerId);
  const latest = parseReleaseRecord(response, providerId);
  if (!latest) {
    throw new Error(`${providerId} latest release is not a published stable semantic version`);
  }

  return {
    version: latest.version,
    tag: latest.tag,
    publishedAt: latest.publishedAt,
    assets: {
      amd64: readReleaseAsset(latest, providerId, 'amd64'),
      arm64: readReleaseAsset(latest, providerId, 'arm64'),
    },
  };
}

export function createOfficialReleaseSource(
  fetchImpl: typeof fetch = fetch,
): OfficialReleaseSource {
  return async (providerId) => {
    assertProviderId(providerId);

    const repository = PROVIDER_CLIENTS[providerId].repository;
    const url = new URL(`https://api.github.com/repos/${repository}/releases/latest`);
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-window-manager-provider-client-pins',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub release API returned HTTP ${response.status} for ${providerId}`);
    }
    return response.json() as Promise<unknown>;
  };
}

export async function checkProviderClientPins(
  input: unknown,
  fetchRelease: OfficialReleaseSource,
): Promise<ProviderClientStatus[]> {
  const manifest = parseProviderClientManifest(input);
  const providerIds = Object.keys(PROVIDER_CLIENTS) as ProviderClientId[];
  return Promise.all(
    providerIds.map(async (providerId) => {
      const pin = manifest.providers[providerId];
      const latest = await discoverLatestStableRelease(providerId, fetchRelease);
      const comparison = compareStableVersions(latest.version, pin.version);
      if (comparison === 0) assertMatchingReleaseMetadata(providerId, pin, latest);
      return {
        providerId,
        displayName: PROVIDER_CLIENTS[providerId].displayName,
        pinnedVersion: pin.version,
        latestVersion: latest.version,
        status: comparison > 0 ? 'update-available' : comparison < 0 ? 'pinned-ahead' : 'current',
      };
    }),
  );
}

function assertMatchingReleaseMetadata(
  providerId: ProviderClientId,
  pin: ProviderClientPin,
  latest: LatestProviderClientRelease,
): void {
  if (pin.tag !== latest.tag) {
    throw new Error(`${providerId} stable release tag changed without a version change`);
  }
  for (const architecture of ['amd64', 'arm64'] as const) {
    if (
      pin.assets[architecture].name !== latest.assets[architecture].name ||
      pin.assets[architecture].sha256 !== latest.assets[architecture].sha256
    ) {
      throw new Error(
        `${providerId} ${latest.version} release metadata differs from the pinned digest`,
      );
    }
  }
}

export async function bumpProviderClientPins(
  input: unknown,
  fetchRelease: OfficialReleaseSource,
): Promise<{ manifest: ProviderClientManifest; updated: ProviderClientId[] }> {
  const manifest = parseProviderClientManifest(input);
  const providers = { ...manifest.providers };
  const updated: ProviderClientId[] = [];

  for (const providerId of Object.keys(PROVIDER_CLIENTS) as ProviderClientId[]) {
    const pin = manifest.providers[providerId];
    const latest = await discoverLatestStableRelease(providerId, fetchRelease);
    const comparison = compareStableVersions(latest.version, pin.version);
    if (comparison === 0) {
      assertMatchingReleaseMetadata(providerId, pin, latest);
      continue;
    }
    if (comparison < 0) continue;

    providers[providerId] = {
      ...pin,
      version: latest.version,
      tag: latest.tag,
      assets: latest.assets,
    };
    updated.push(providerId);
  }

  return {
    manifest: parseProviderClientManifest({ ...manifest, providers }),
    updated,
  };
}

export function serializeProviderClientManifest(manifest: ProviderClientManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
