import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_CODE_RELEASE_KEY_FINGERPRINT,
  createGpgvManifestVerifier,
  createOfficialReleaseSource,
  dearmorOpenPgpPublicKey,
  discoverLatestStableRelease,
  validSignatureFingerprint,
} from '../../scripts/provider-clients-core.js';
import { createOfficialArchiveDownloader } from '../../src/provider-clients/archive-downloader.js';

const keyPath = new URL('../../provider-keys/claude-code-release.asc', import.meta.url);
const armoredKey = readFileSync(keyPath, 'utf8');
const manifestBytes = readFileSync(
  new URL('./fixtures/claude-code/manifest-2.1.311.json', import.meta.url),
);
const signatureBytes = readFileSync(
  new URL('./fixtures/claude-code/manifest-2.1.311.json.sig', import.meta.url),
);
const gpgvAvailable = spawnSync('gpgv', ['--version'], { stdio: 'ignore' }).status === 0;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fakeGpgv(script: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'awm-fake-gpgv-'));
  directories.push(directory);
  const executable = path.join(directory, 'gpgv');
  writeFileSync(executable, `#!/bin/sh\n${script}\n`);
  chmodSync(executable, 0o755);
  return executable;
}

const PRIMARY = CLAUDE_CODE_RELEASE_KEY_FINGERPRINT;
const VALIDSIG_LINE = `[GNUPG:] VALIDSIG ${PRIMARY} 2026-10-26 1793042338 0 4 0 1 10 00 ${PRIMARY}`;

function response(body: string | Uint8Array, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), init);
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? '';
}

function releaseFetch(overrides: Record<string, Response> = {}) {
  return vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (overrides[url]) return Promise.resolve(overrides[url]);
    if (url.endsWith('/stable')) return Promise.resolve(response('2.1.311\n'));
    if (url.endsWith('/2.1.311/manifest.json')) return Promise.resolve(response(manifestBytes));
    if (url.endsWith('/2.1.311/manifest.json.sig')) {
      return Promise.resolve(response(signatureBytes));
    }
    return Promise.resolve(response('not found', { status: 404 }));
  });
}

describe('Claude Code release key handling', () => {
  it('decodes the pinned armored key and verifies its CRC-24', () => {
    const bytes = dearmorOpenPgpPublicKey(armoredKey);
    expect(bytes.byteLength).toBeGreaterThan(500);
    expect(bytes[0]! & 0x80).toBe(0x80);
    const tampered = armoredKey.replace(/\n=([A-Za-z0-9+/]{4})/, '\n=AAAA');
    expect(() => dearmorOpenPgpPublicKey(tampered)).toThrow(/checksum/);
    expect(() => dearmorOpenPgpPublicKey('not a key')).toThrow(/invalid armored/);
    expect(() =>
      dearmorOpenPgpPublicKey(
        '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n!!!\n-----END PGP PUBLIC KEY BLOCK-----',
      ),
    ).toThrow(/invalid armored/);
    expect(() =>
      dearmorOpenPgpPublicKey(
        '-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: x\n\n-----END PGP PUBLIC KEY BLOCK-----',
      ),
    ).toThrow(/invalid armored/);
  });

  it('parses only machine-readable VALIDSIG status lines', () => {
    expect(validSignatureFingerprint(`[GNUPG:] GOODSIG X name\n${VALIDSIG_LINE}\n`)).toBe(PRIMARY);
    expect(
      validSignatureFingerprint(`[GNUPG:] VALIDSIG ${'A'.repeat(40)} 2026-10-26 1 0 4 0 1 10 00`),
    ).toBe('A'.repeat(40));
    expect(validSignatureFingerprint('[GNUPG:] VALIDSIG nothex 1 2 3')).toBeUndefined();
    expect(validSignatureFingerprint('[GNUPG:] BADSIG X')).toBeUndefined();
  });

  it.runIf(gpgvAvailable)(
    'verifies the genuine official 2.1.311 manifest signature with gpgv',
    async () => {
      const verify = createGpgvManifestVerifier({
        armoredPublicKey: armoredKey,
        expectedFingerprint: PRIMARY,
      });
      await expect(verify(manifestBytes, signatureBytes)).resolves.toBe(PRIMARY);
      const tampered = Buffer.from(manifestBytes.toString('utf8').replace('2.1.311', '2.1.312'));
      await expect(verify(tampered, signatureBytes)).rejects.toThrow(/not valid/);
    },
  );

  it('rejects a valid signature from any key other than the pin', async () => {
    const verify = createGpgvManifestVerifier({
      armoredPublicKey: armoredKey,
      expectedFingerprint: PRIMARY,
      gpgvPath: fakeGpgv(
        `echo '[GNUPG:] VALIDSIG ${'B'.repeat(40)} 2026 1 0 4 0 1 10 00 ${'B'.repeat(40)}'`,
      ),
    });
    await expect(verify(manifestBytes, signatureBytes)).rejects.toThrow(/pinned key/);

    const nonzero = createGpgvManifestVerifier({
      armoredPublicKey: armoredKey,
      expectedFingerprint: PRIMARY,
      gpgvPath: fakeGpgv(`echo '${VALIDSIG_LINE}'; exit 1`),
    });
    await expect(nonzero(manifestBytes, signatureBytes)).rejects.toThrow(/not valid/);

    const accepted = createGpgvManifestVerifier({
      armoredPublicKey: armoredKey,
      expectedFingerprint: PRIMARY.toLowerCase(),
      gpgvPath: fakeGpgv(`echo '${VALIDSIG_LINE}'`),
    });
    await expect(accepted(manifestBytes, signatureBytes)).resolves.toBe(PRIMARY);

    const flood = createGpgvManifestVerifier({
      armoredPublicKey: armoredKey,
      expectedFingerprint: PRIMARY,
      gpgvPath: fakeGpgv('yes x | head -c 200000'),
    });
    await expect(flood(manifestBytes, signatureBytes)).rejects.toThrow();

    const hung = createGpgvManifestVerifier({
      armoredPublicKey: armoredKey,
      expectedFingerprint: PRIMARY,
      gpgvPath: fakeGpgv('exec sleep 5'),
      timeoutMs: 50,
    });
    await expect(hung(manifestBytes, signatureBytes)).rejects.toThrow();

    const missing = createGpgvManifestVerifier({
      armoredPublicKey: armoredKey,
      expectedFingerprint: PRIMARY,
      gpgvPath: '/nonexistent/gpgv-awm-test',
    });
    await expect(missing(manifestBytes, signatureBytes)).rejects.toThrow();
    expect(() =>
      createGpgvManifestVerifier({ armoredPublicKey: armoredKey, expectedFingerprint: 'abc' }),
    ).toThrow(/fingerprint/);
  });
});

describe('Claude Code stable release resolution', () => {
  it('resolves the stable pointer, verifies the signed manifest and maps both Linux digests', async () => {
    const fetchImpl = releaseFetch();
    const verify = vi.fn(() => Promise.resolve(PRIMARY));
    const release = await discoverLatestStableRelease(
      'claude_code',
      createOfficialReleaseSource(fetchImpl, { verifyClaudeCodeManifest: verify }),
    );
    expect(release).toEqual({
      version: '2.1.311',
      tag: '2.1.311',
      publishedAt: '2026-10-26T19:03:46.000Z',
      assets: {
        amd64: {
          name: 'linux-x64/claude',
          sha256: '86dc1fcc69498159eaf15f446613e847010f9036bfbbdffd4c49350be8489ada',
        },
        arm64: {
          name: 'linux-arm64/claude',
          sha256: '2e2496c9a8065df93acb0fca2d341f59a6b8777649b2e025ab8c9bcd5eef61f3',
        },
      },
    });
    expect(fetchImpl.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      'https://downloads.claude.ai/claude-code-releases/stable',
      'https://downloads.claude.ai/claude-code-releases/2.1.311/manifest.json',
      'https://downloads.claude.ai/claude-code-releases/2.1.311/manifest.json.sig',
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    expect(verify).toHaveBeenCalledWith(manifestBytes, signatureBytes);
  });

  it('fails closed without a verifier, on bad metadata, or when the signature fails', async () => {
    await expect(
      discoverLatestStableRelease('claude_code', createOfficialReleaseSource(releaseFetch())),
    ).rejects.toThrow(/signature verification is not configured/);

    const base = 'https://downloads.claude.ai/claude-code-releases';
    const ok = () => Promise.resolve(PRIMARY);
    const failures: Array<[Record<string, Response>, () => Promise<string>, RegExp]> = [
      [{ [`${base}/stable`]: response('latest-beta') }, ok, /stable semantic version/],
      [{ [`${base}/stable`]: response('x', { status: 503 }) }, ok, /HTTP 503/],
      [
        { [`${base}/stable`]: response('2.1.311', { headers: { 'content-length': '999' } }) },
        ok,
        /size limit/,
      ],
      [{ [`${base}/stable`]: response('') }, ok, /invalid size/],
      [{}, () => Promise.reject(new Error('signature rejected')), /signature rejected/],
      [{}, () => Promise.resolve('B'.repeat(40)), /verified official manifest/],
      [
        { [`${base}/2.1.311/manifest.json`]: response(JSON.stringify({ version: '2.1.311' })) },
        ok,
        /verified official manifest/,
      ],
    ];
    for (const [overrides, verify, error] of failures) {
      await expect(
        discoverLatestStableRelease(
          'claude_code',
          createOfficialReleaseSource(releaseFetch(overrides), {
            verifyClaudeCodeManifest: verify,
          }),
        ),
      ).rejects.toThrow(error);
    }

    const mismatched = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
    mismatched.version = '2.1.300';
    await expect(
      discoverLatestStableRelease(
        'claude_code',
        createOfficialReleaseSource(
          releaseFetch({ [`${base}/2.1.311/manifest.json`]: response(JSON.stringify(mismatched)) }),
          { verifyClaudeCodeManifest: ok },
        ),
      ),
    ).rejects.toThrow(/does not match the stable channel/);
  });

  it('downloads only the manifest-named executable from the official bucket', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response(Uint8Array.of(1, 2))));
    const directory = mkdtempSync(path.join(tmpdir(), 'awm-claude-download-'));
    directories.push(directory);
    for (const architecture of ['amd64', 'arm64'] as const) {
      await createOfficialArchiveDownloader({ architecture, fetchImpl })(
        { providerId: 'claude_code', version: '2.1.311', sha256: 'a'.repeat(64) },
        path.join(directory, `claude-${architecture}`),
        new AbortController().signal,
      );
    }
    expect(fetchImpl.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      'https://downloads.claude.ai/claude-code-releases/2.1.311/linux-x64/claude',
      'https://downloads.claude.ai/claude-code-releases/2.1.311/linux-arm64/claude',
    ]);
  });
});
