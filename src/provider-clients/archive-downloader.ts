import { createWriteStream } from 'node:fs';
import { rm as removeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import {
  PROVIDER_CLIENTS,
  type ProviderArchitecture,
} from '../../scripts/provider-clients-core.js';
import type { ProviderClientId, RuntimeArchiveDownloader } from './runtime-store.js';

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REDIRECT_LIMIT = 5;
const SAFE_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

export interface OfficialArchiveDownloaderOptions {
  architecture: ProviderArchitecture;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Downloads only fixed release assets from the two allowlisted official repositories. */
export function createOfficialArchiveDownloader(
  options: OfficialArchiveDownloaderOptions,
): RuntimeArchiveDownloader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('archive maxBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('archive timeoutMs must be a positive safe integer');
  }

  return async (request, destinationPath, signal) => {
    const url = officialAssetUrl(request.providerId, request.version, options.architecture);
    if (!SHA256_PATTERN.test(request.sha256)) throw new Error('invalid archive digest');
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const response = await fetchFollowingOfficialRedirects(fetchImpl, url, requestSignal);
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('official provider archive is unavailable');
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const declaredLength = Number(contentLength);
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > maxBytes
      ) {
        await response.body.cancel().catch(() => undefined);
        throw new Error('official provider archive exceeds its size limit');
      }
    }

    let receivedBytes = 0;
    const byteLimit = new Transform({
      transform(chunk: Buffer | string, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += bytes.byteLength;
        if (receivedBytes > maxBytes) {
          callback(new Error('official provider archive exceeds its size limit'));
          return;
        }
        callback(null, bytes);
      },
    });

    const output = createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 });
    let created = false;
    output.once('open', () => {
      created = true;
    });
    try {
      await pipeline(Readable.from(readWebStream(response.body)), byteLimit, output, {
        signal: requestSignal,
      });
      if (receivedBytes === 0) throw new Error('official provider archive is empty');
    } catch (error) {
      if (created) await removeFile(destinationPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };
}

async function* readWebStream(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        return;
      }
      yield Buffer.from(next.value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function officialAssetUrl(
  providerId: ProviderClientId,
  version: string,
  architecture: ProviderArchitecture,
): URL {
  if (!Object.hasOwn(PROVIDER_CLIENTS, providerId)) throw new Error('unsupported provider client');
  if (!STABLE_VERSION_PATTERN.test(version)) throw new Error('invalid stable provider version');
  const provider = PROVIDER_CLIENTS[providerId];
  const tag = providerId === 'codex' ? `rust-v${version}` : version;
  const asset = provider.assets[architecture];
  return new URL(
    `https://github.com/${provider.repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`,
  );
}

async function fetchFollowingOfficialRedirects(
  fetchImpl: typeof fetch,
  initialUrl: URL,
  signal: AbortSignal,
): Promise<Response> {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= REDIRECT_LIMIT; redirectCount += 1) {
    if (!isSafeDownloadUrl(current)) throw new Error('provider archive redirect is not allowed');
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'ai-window-manager-provider-client-updater',
      },
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirectCount === REDIRECT_LIMIT) {
      throw new Error('provider archive redirect limit exceeded');
    }
    current = new URL(location, current);
  }
  throw new Error('provider archive redirect limit exceeded');
}

function isSafeDownloadUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    SAFE_DOWNLOAD_HOSTS.has(url.hostname)
  );
}
