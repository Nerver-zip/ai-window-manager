import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOfficialArchiveDownloader,
  type OfficialArchiveDownloaderOptions,
} from '../../src/provider-clients/archive-downloader.js';

const directories: string[] = [];
const digest = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function destination(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'awm-provider-client-download-'));
  directories.push(directory);
  return path.join(directory, 'candidate.tar.gz');
}

function options(
  fetchImpl: typeof fetch,
  overrides: Partial<OfficialArchiveDownloaderOptions> = {},
): OfficialArchiveDownloaderOptions {
  return { architecture: 'amd64', fetchImpl, ...overrides };
}

function request(overrides: { providerId?: string; version?: string; sha256?: string } = {}) {
  return {
    providerId: overrides.providerId ?? 'codex',
    version: overrides.version ?? '0.157.0',
    sha256: overrides.sha256 ?? digest,
  } as Parameters<ReturnType<typeof createOfficialArchiveDownloader>>[0];
}

function requestUrl(input: RequestInfo | URL | undefined): string | undefined {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url;
}

const signal = () => new AbortController().signal;

describe('createOfficialArchiveDownloader', () => {
  it('downloads the fixed Codex asset from the official repository', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(Uint8Array.of(1, 2, 3))),
    );
    const filePath = await destination();

    await createOfficialArchiveDownloader(options(fetchImpl))(request(), filePath, signal());

    expect(requestUrl(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://github.com/openai/codex/releases/download/rust-v0.157.0/codex-package-x86_64-unknown-linux-musl.tar.gz',
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: 'application/octet-stream' },
    });
    expect(await readFile(filePath)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('uses the fixed Antigravity arm64 asset and follows an allowlisted release redirect', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/download/file' },
        }),
      )
      .mockResolvedValueOnce(new Response(Uint8Array.of(9, 8)));
    const filePath = await destination();
    const downloader = createOfficialArchiveDownloader(
      options(fetchImpl, { architecture: 'arm64' }),
    );

    await downloader(request({ providerId: 'antigravity', version: '1.2.11' }), filePath, signal());

    expect(requestUrl(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://github.com/google-antigravity/antigravity-cli/releases/download/1.2.11/agy_cli_linux_arm64.tar.gz',
    );
    expect(requestUrl(fetchImpl.mock.calls[1]?.[0])).toBe(
      'https://release-assets.githubusercontent.com/download/file',
    );
    expect(await readFile(filePath)).toEqual(Buffer.from([9, 8]));
  });

  it('rejects malformed configuration and candidate values before network access', async () => {
    expect(() => createOfficialArchiveDownloader(options(fetch, { maxBytes: 0 }))).toThrow(
      /maxBytes/,
    );
    expect(() => createOfficialArchiveDownloader(options(fetch, { timeoutMs: 0 }))).toThrow(
      /timeoutMs/,
    );

    const fetchImpl = vi.fn<typeof fetch>();
    const downloader = createOfficialArchiveDownloader(options(fetchImpl));
    const filePath = await destination();
    await expect(downloader(request({ version: 'latest' }), filePath, signal())).rejects.toThrow(
      /version/,
    );
    await expect(downloader(request({ sha256: 'bad' }), filePath, signal())).rejects.toThrow(
      /digest/,
    );
    await expect(
      downloader(request({ providerId: 'unsupported' }), filePath, signal()),
    ).rejects.toThrow(/provider/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a redirect to an untrusted host and a redirect without Location', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.invalid/archive' },
      }),
    );
    const filePath = await destination();
    const downloader = createOfficialArchiveDownloader(options(fetchImpl));
    await expect(downloader(request(), filePath, signal())).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const missingLocationFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 302 })),
    );
    await expect(
      createOfficialArchiveDownloader(options(missingLocationFetch))(request(), filePath, signal()),
    ).rejects.toThrow(/redirect/);
  });

  it('bounds redirect count and validates the response and declared size', async () => {
    const redirectLoop = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (!url) return Promise.reject(new Error('request URL is unavailable'));
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: new URL(url).toString() } }),
      );
    });
    const filePath = await destination();
    await expect(
      createOfficialArchiveDownloader(options(redirectLoop))(request(), filePath, signal()),
    ).rejects.toThrow(/redirect/);
    expect(redirectLoop).toHaveBeenCalledTimes(6);

    const missingBody = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    await expect(
      createOfficialArchiveDownloader(options(missingBody))(request(), filePath, signal()),
    ).rejects.toThrow(/unavailable/);

    const failedResponse = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('missing', { status: 404 })),
    );
    await expect(
      createOfficialArchiveDownloader(options(failedResponse))(request(), filePath, signal()),
    ).rejects.toThrow(/unavailable/);

    const oversized = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(Uint8Array.of(1), { headers: { 'content-length': '100' } })),
    );
    await expect(
      createOfficialArchiveDownloader(options(oversized, { maxBytes: 3 }))(
        request(),
        filePath,
        signal(),
      ),
    ).rejects.toThrow(/size limit/);
  });

  it('limits streamed bytes, rejects empty output and does not overwrite a destination', async () => {
    const filePath = await destination();
    const tooLarge = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(Uint8Array.of(1, 2, 3, 4))),
    );
    await expect(
      createOfficialArchiveDownloader(options(tooLarge, { maxBytes: 3 }))(
        request(),
        filePath,
        signal(),
      ),
    ).rejects.toThrow(/size limit/);
    await rm(filePath, { force: true });

    const empty = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new Uint8Array())));
    await expect(
      createOfficialArchiveDownloader(options(empty))(request(), filePath, signal()),
    ).rejects.toThrow(/empty/);

    const valid = vi.fn<typeof fetch>(() => Promise.resolve(new Response(Uint8Array.of(1))));
    const downloader = createOfficialArchiveDownloader(options(valid));
    await downloader(request(), filePath, signal());
    await expect(downloader(request(), filePath, signal())).rejects.toThrow();
  });

  it('passes cancellation to fetch and stream pipeline', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      if (init?.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
      return Promise.resolve(new Response(Uint8Array.of(1)));
    });
    const filePath = await destination();
    await expect(
      createOfficialArchiveDownloader(options(fetchImpl))(request(), filePath, controller.signal),
    ).rejects.toThrow(/aborted/i);
  });
});
