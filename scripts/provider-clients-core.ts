import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  claude_code: {
    displayName: 'Claude Code',
    // Anthropic's official native-binary release bucket (not a GitHub repository).
    repository: 'downloads.claude.ai/claude-code-releases',
    tagPrefix: '',
    assets: {
      amd64: 'linux-x64/claude',
      arm64: 'linux-arm64/claude',
    },
  },
} as const;

/** Official Claude Code release bucket; only fixed paths below it are ever requested. */
export const CLAUDE_CODE_RELEASE_BASE_URL = 'https://downloads.claude.ai/claude-code-releases';
/** Fingerprint of "Anthropic Claude Code Release Signing" (downloads.claude.ai/keys/claude-code.asc). */
export const CLAUDE_CODE_RELEASE_KEY_FINGERPRINT = '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE';
export const CLAUDE_CODE_MAX_BINARY_BYTES = 512 * 1024 * 1024;
const CLAUDE_CODE_MAX_MANIFEST_BYTES = 64 * 1024;
const CLAUDE_CODE_MAX_SIGNATURE_BYTES = 16 * 1024;

/** Verifies a detached OpenPGP signature and returns the signer's primary-key fingerprint. */
export type SignedManifestVerifier = (data: Buffer, signature: Buffer) => Promise<string>;

export interface OfficialReleaseSourceOptions {
  /** Required for Claude Code: manifest metadata is only trusted after signature verification. */
  verifyClaudeCodeManifest?: SignedManifestVerifier;
}

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
        claude_code: providerPinSchema,
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

const sha256HexSchema = z.string().regex(sha256Pattern);
const claudePlatformSchema = z
  .object({
    binary: z.literal('claude'),
    checksum: sha256HexSchema,
    size: z.number().int().positive().max(CLAUDE_CODE_MAX_BINARY_BYTES),
  })
  .passthrough();
const claudeSignedReleaseSchema = z
  .object({
    source: z.literal('anthropic-signed-manifest'),
    channel: z.literal('stable'),
    version: z.string().regex(stableVersionPattern),
    signerFingerprint: z.literal(CLAUDE_CODE_RELEASE_KEY_FINGERPRINT),
    manifest: z
      .object({
        version: z.string().regex(stableVersionPattern),
        buildDate: z.string().refine((value) => Number.isFinite(Date.parse(value))),
        platforms: z
          .object({
            'linux-x64': claudePlatformSchema,
            'linux-arm64': claudePlatformSchema,
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .strict();

/** Accept Claude Code metadata only from a signature-verified official stable manifest. */
function parseClaudeCodeRelease(value: unknown): LatestProviderClientRelease {
  const parsed = claudeSignedReleaseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('claude_code stable release metadata is not a verified official manifest');
  }
  const release = parsed.data;
  if (release.manifest.version !== release.version) {
    throw new Error('claude_code signed manifest version does not match the stable channel');
  }
  const assets = PROVIDER_CLIENTS.claude_code.assets;
  return {
    version: release.version,
    tag: release.version,
    publishedAt: new Date(Date.parse(release.manifest.buildDate)).toISOString(),
    assets: {
      amd64: { name: assets.amd64, sha256: release.manifest.platforms['linux-x64'].checksum },
      arm64: { name: assets.arm64, sha256: release.manifest.platforms['linux-arm64'].checksum },
    },
  };
}

export async function discoverLatestStableRelease(
  providerId: ProviderClientId,
  fetchRelease: OfficialReleaseSource,
): Promise<LatestProviderClientRelease> {
  assertProviderId(providerId);
  const response = await fetchRelease(providerId);
  if (providerId === 'claude_code') return parseClaudeCodeRelease(response);
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

async function fetchBoundedBytes(
  fetchImpl: typeof fetch,
  url: URL,
  maxBytes: number,
  accept: string,
): Promise<Buffer> {
  const response = await fetchImpl(url, {
    redirect: 'error',
    headers: { Accept: accept, 'User-Agent': 'ai-window-manager-provider-client-pins' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`official release metadata returned HTTP ${response.status}`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('official release metadata exceeds its size limit');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error('official release metadata has an invalid size');
  }
  return bytes;
}

async function resolveClaudeCodeStableRelease(
  fetchImpl: typeof fetch,
  verify: SignedManifestVerifier | undefined,
): Promise<unknown> {
  if (!verify) throw new Error('claude_code release signature verification is not configured');
  const pointer = (
    await fetchBoundedBytes(
      fetchImpl,
      new URL(`${CLAUDE_CODE_RELEASE_BASE_URL}/stable`),
      64,
      'text/plain',
    )
  )
    .toString('utf8')
    .trim();
  if (!stableVersionPattern.test(pointer)) {
    throw new Error('claude_code stable channel does not name a stable semantic version');
  }
  const manifestUrl = new URL(`${CLAUDE_CODE_RELEASE_BASE_URL}/${pointer}/manifest.json`);
  const manifestBytes = await fetchBoundedBytes(
    fetchImpl,
    manifestUrl,
    CLAUDE_CODE_MAX_MANIFEST_BYTES,
    'application/json',
  );
  const signatureBytes = await fetchBoundedBytes(
    fetchImpl,
    new URL(`${manifestUrl.href}.sig`),
    CLAUDE_CODE_MAX_SIGNATURE_BYTES,
    'application/octet-stream',
  );
  const signerFingerprint = await verify(manifestBytes, signatureBytes);
  return {
    source: 'anthropic-signed-manifest',
    channel: 'stable',
    version: pointer,
    signerFingerprint,
    manifest: JSON.parse(manifestBytes.toString('utf8')) as unknown,
  };
}

export function createOfficialReleaseSource(
  fetchImpl: typeof fetch = fetch,
  options: OfficialReleaseSourceOptions = {},
): OfficialReleaseSource {
  return async (providerId) => {
    assertProviderId(providerId);
    if (providerId === 'claude_code') {
      return resolveClaudeCodeStableRelease(fetchImpl, options.verifyClaudeCodeManifest);
    }

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

const CRC24_INIT = 0xb704ce;
const CRC24_POLY = 0x1864cfb;

function crc24(bytes: Uint8Array): number {
  let crc = CRC24_INIT;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let bit = 0; bit < 8; bit += 1) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= CRC24_POLY;
    }
  }
  return crc & 0xffffff;
}

/** Decode one ASCII-armored OpenPGP public-key block, verifying its CRC-24 checksum. */
export function dearmorOpenPgpPublicKey(armored: string): Buffer {
  const lines = armored.replaceAll('\r', '').split('\n');
  const begin = lines.findIndex((line) => line.trim() === '-----BEGIN PGP PUBLIC KEY BLOCK-----');
  const end = lines.findIndex((line) => line.trim() === '-----END PGP PUBLIC KEY BLOCK-----');
  if (begin === -1 || end === -1 || end <= begin) throw new Error('invalid armored public key');
  let index = begin + 1;
  while (index < end && lines[index]!.includes(':')) index += 1;
  const body: string[] = [];
  let checksum: string | undefined;
  for (; index < end; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    if (line.startsWith('=')) {
      checksum = line.slice(1);
      break;
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(line)) throw new Error('invalid armored public key');
    body.push(line);
  }
  const bytes = Buffer.from(body.join(''), 'base64');
  if (bytes.byteLength === 0) throw new Error('invalid armored public key');
  if (checksum !== undefined) {
    const expected = Buffer.from(checksum, 'base64');
    if (expected.byteLength !== 3 || expected.readUIntBE(0, 3) !== crc24(bytes)) {
      throw new Error('armored public key checksum mismatch');
    }
  }
  return bytes;
}

export interface GpgvVerifierOptions {
  /** The repository-pinned armored release key. */
  armoredPublicKey: string;
  expectedFingerprint: string;
  gpgvPath?: string;
  timeoutMs?: number;
}

/**
 * Verify a detached signature with `gpgv` against exactly one pinned key.
 * `gpgv` never consults a user keyring or the network; the signer fingerprint
 * reported in its machine-readable VALIDSIG status line must match the pin.
 */
export function createGpgvManifestVerifier(options: GpgvVerifierOptions): SignedManifestVerifier {
  const keyring = dearmorOpenPgpPublicKey(options.armoredPublicKey);
  const expected = options.expectedFingerprint.toUpperCase();
  if (!/^[A-F0-9]{40}$/.test(expected)) throw new Error('invalid expected key fingerprint');
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (data, signature) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'awm-gpgv-'));
    try {
      const keyringPath = path.join(directory, 'release-key.gpg');
      const dataPath = path.join(directory, 'manifest.json');
      const signaturePath = path.join(directory, 'manifest.json.sig');
      await writeFile(keyringPath, keyring, { mode: 0o600 });
      await writeFile(dataPath, data, { mode: 0o600 });
      await writeFile(signaturePath, signature, { mode: 0o600 });
      const { code, stdout } = await runBounded(
        options.gpgvPath ?? 'gpgv',
        ['--status-fd', '1', '--keyring', keyringPath, signaturePath, dataPath],
        directory,
        timeoutMs,
      );
      const signer = validSignatureFingerprint(stdout);
      if (code !== 0 || !signer || signer !== expected) {
        throw new Error('release manifest signature is not valid for the pinned key');
      }
      return signer;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/**
 * Parse gpg's `VALIDSIG <fpr> <date> <ts> <expire> <ver> <reserved> <pk> <hash> <class> [<primary>]`
 * status line. The primary-key fingerprint is preferred when a subkey signed.
 */
export function validSignatureFingerprint(statusOutput: string): string | undefined {
  for (const line of statusOutput.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] !== '[GNUPG:]' || tokens[1] !== 'VALIDSIG') continue;
    const signing = tokens[2];
    const primary = tokens.length >= 12 ? tokens[tokens.length - 1] : undefined;
    const fingerprint = primary ?? signing;
    if (fingerprint && /^[A-F0-9]{40}$/.test(fingerprint)) return fingerprint;
    return undefined;
  }
  return undefined;
}

function runBounded(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) {
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}
