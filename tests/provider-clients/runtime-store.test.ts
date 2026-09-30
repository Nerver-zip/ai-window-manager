import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderClientRuntimeStore,
  ProviderClientRuntimeStoreError,
  nodeRuntimeStoreFileSystem,
  type ProviderClientId,
  type RuntimeClientCandidate,
  type RuntimeArchiveDownloader,
  type RuntimeStoreLimits,
  type RuntimeProcessRunner,
} from '../../src/provider-clients/runtime-store.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

interface TarInput {
  readonly name: string;
  readonly data?: Buffer;
  readonly type?: string;
  readonly linkName?: string;
  readonly mode?: number;
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  block.write(`${text}\0`, offset, length, 'ascii');
}

function tarHeader(entry: TarInput): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, entry.mode ?? (entry.type === '5' ? 0o755 : 0o755));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data?.byteLength ?? 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = (entry.type ?? '0').charCodeAt(0);
  if (entry.linkName) header.write(entry.linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function refreshTarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
}

function tarEntry(entry: TarInput): Buffer {
  const data = entry.data ?? Buffer.alloc(0);
  const padding = (512 - (data.byteLength % 512)) % 512;
  return Buffer.concat([tarHeader(entry), data, Buffer.alloc(padding)]);
}

function paxRecord(key: string, value: string): Buffer {
  let length = 0;
  while (true) {
    const record = `${length} ${key}=${value}\n`;
    const nextLength = Buffer.byteLength(record, 'utf8');
    if (nextLength === length) return Buffer.from(record, 'utf8');
    length = nextLength;
  }
}

function archive(entries: readonly TarInput[]): Buffer {
  return gzipSync(Buffer.concat([...entries.map(tarEntry), Buffer.alloc(512), Buffer.alloc(512)]));
}

function archiveFromTar(bytes: Buffer): Buffer {
  return gzipSync(bytes);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function binaryPayload(providerId: ProviderClientId, version: string): Buffer {
  return Buffer.from(`${providerId}@${version}`, 'utf8');
}

function runtimeArchive(
  providerId: ProviderClientId,
  version: string,
  pathOverride?: string,
): Buffer {
  const executablePath = providerId === 'codex' ? 'bin/codex' : 'antigravity';
  const payload = binaryPayload(providerId, version);
  if (!pathOverride) return archive([{ name: executablePath, data: payload, mode: 0o755 }]);
  return archive([
    { name: 'PaxHeader', type: 'x', data: paxRecord('path', pathOverride) },
    { name: 'ignored-name', data: payload, mode: 0o755 },
  ]);
}

function makeHarness(
  options: {
    readonly probe?: (providerId: ProviderClientId, version: string) => void | Promise<void>;
    readonly processRunner?: RuntimeProcessRunner;
    readonly fileSystem?: typeof nodeRuntimeStoreFileSystem;
    readonly useDefaultProcessRunner?: boolean;
    readonly downloadArchive?: RuntimeArchiveDownloader;
    readonly limits?: Partial<RuntimeStoreLimits>;
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-runtime-store-'));
  temporaryDirectories.push(directory);
  const packageRoot = path.join(directory, 'packaged');
  const runtimeRoot = path.join(directory, 'runtime');
  const packagedCodex = path.join(packageRoot, 'codex', 'bin', 'codex');
  const packagedAgy = path.join(packageRoot, 'antigravity', 'bin', 'agy');
  fs.mkdirSync(path.dirname(packagedCodex), { recursive: true });
  fs.mkdirSync(path.dirname(packagedAgy), { recursive: true });
  fs.writeFileSync(packagedCodex, binaryPayload('codex', '1.0.0'), { mode: 0o555 });
  fs.writeFileSync(packagedAgy, binaryPayload('antigravity', '1.0.0'), { mode: 0o555 });

  const archives = new Map<string, Buffer>();
  const downloaded: Array<{ providerId: ProviderClientId; version: string; sha256: string }> = [];
  const probes: Array<{
    providerId: ProviderClientId;
    version: string;
    quotaConsumptionAllowed: false;
  }> = [];
  const processCalls: Array<{ executablePath: string; args: readonly string[] }> = [];
  const key = (providerId: ProviderClientId, version: string) => `${providerId}:${version}`;
  const processRunner: RuntimeProcessRunner =
    options.processRunner ??
    ((executablePath, args) => {
      processCalls.push({ executablePath, args });
      expect(args).toEqual(['--version']);
      let contents: string;
      try {
        contents = fs.readFileSync(executablePath, 'utf8');
      } catch {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      }
      const separator = contents.indexOf('@');
      if (separator < 0) return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      const providerId = contents.slice(0, separator) as ProviderClientId;
      const version = contents.slice(separator + 1);
      return Promise.resolve({
        exitCode: 0,
        stdout: providerId === 'codex' ? `codex-cli ${version}\n` : `${version}\n`,
        stderr: '',
      });
    });
  const store = new ProviderClientRuntimeStore({
    runtimeRoot,
    packagedClients: {
      codex: {
        packagedExecutablePath: packagedCodex,
        packagedVersion: '1.0.0',
        archiveExecutablePath: 'bin/codex',
      },
      antigravity: {
        packagedExecutablePath: packagedAgy,
        packagedVersion: '1.0.0',
        archiveExecutablePath: 'antigravity',
      },
    },
    downloadArchive:
      options.downloadArchive ??
      ((request, destinationPath, signal) => {
        if (signal.aborted) return Promise.reject(new Error('aborted'));
        downloaded.push(request);
        const bytes = archives.get(key(request.providerId, request.version));
        if (!bytes) return Promise.reject(new Error('missing offline fixture'));
        fs.writeFileSync(destinationPath, bytes, { mode: 0o600, flag: 'wx' });
        return Promise.resolve();
      }),
    ...(options.useDefaultProcessRunner ? {} : { runProcess: processRunner }),
    compatibilityProbe: async (request) => {
      probes.push({
        providerId: request.providerId,
        version: request.expectedVersion,
        quotaConsumptionAllowed: request.quotaConsumptionAllowed,
      });
      expect(request.purpose).toBe('read-only-compatibility-probe');
      await options.probe?.(request.providerId, request.expectedVersion);
    },
    ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });

  function putArchive(
    providerId: ProviderClientId,
    version: string,
    bytes = runtimeArchive(providerId, version),
  ) {
    archives.set(key(providerId, version), bytes);
    return { version, sha256: sha256(bytes) } satisfies RuntimeClientCandidate;
  }

  return {
    directory,
    runtimeRoot,
    packagedCodex,
    packagedAgy,
    store,
    archives,
    downloaded,
    probes,
    processCalls,
    putArchive,
  };
}

async function expectStoreError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

function runtimeVersions(runtimeRoot: string, providerId: ProviderClientId): string[] {
  return fs.readdirSync(path.join(runtimeRoot, providerId, 'versions')).sort();
}

function shellVersion(providerId: ProviderClientId, version: string, extra = ''): Buffer {
  const output = providerId === 'codex' ? `codex-cli ${version}` : version;
  return Buffer.from(`#!/bin/sh\nprintf '%s\\n' '${output}'\n${extra}`, 'utf8');
}

async function expectArchiveRejected(
  bytes: Buffer,
  expectedCode: string,
  limits?: Partial<RuntimeStoreLimits>,
): Promise<void> {
  const harness = makeHarness(limits ? { limits } : {});
  await harness.store.initialize();
  const candidate = harness.putArchive('codex', '1.1.0', bytes);
  await expectStoreError(harness.store.install('codex', candidate), expectedCode);
  expect(fs.readlinkSync(path.join(harness.runtimeRoot, 'codex', 'current'))).toBe(
    harness.packagedCodex,
  );
}

describe('ProviderClientRuntimeStore', () => {
  it('initializes stable current links to trusted packaged fallbacks and repairs invalid pointers', async () => {
    const harness = makeHarness();
    const codexRoot = path.join(harness.runtimeRoot, 'codex');
    fs.mkdirSync(path.join(codexRoot, 'versions', '9.9.9'), { recursive: true });
    fs.mkdirSync(path.join(codexRoot, '.staging-abandoned'), { recursive: true });
    fs.symlinkSync('../../outside', path.join(codexRoot, 'current'));

    await harness.store.initialize();

    const executablePath = await harness.store.resolveExecutable('codex');
    expect(executablePath).toBe(path.join(codexRoot, 'current'));
    expect(fs.readlinkSync(executablePath)).toBe(harness.packagedCodex);
    expect(fs.existsSync(path.join(codexRoot, '.staging-abandoned'))).toBe(false);
    expect(runtimeVersions(harness.runtimeRoot, 'codex')).toEqual([]);
    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      providerId: 'codex',
      packagedVersion: '1.0.0',
      activeVersion: '1.0.0',
      activeSource: 'packaged',
      previousVersion: null,
    });
  });

  it('installs a digest-verified candidate only after exact version and read-only probe validation', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    harness.downloaded.length = 0;
    harness.processCalls.length = 0;
    const candidate = harness.putArchive('codex', '1.1.0');

    const result = await harness.store.install('codex', candidate);

    expect(result.status).toBe('installed');
    expect(result.state).toMatchObject({ activeVersion: '1.1.0', activeSource: 'runtime' });
    expect(result.state.executablePath).toBe(path.join(harness.runtimeRoot, 'codex', 'current'));
    expect(fs.readlinkSync(result.state.executablePath)).toBe(
      path.join('versions', '1.1.0', 'bin', 'codex'),
    );
    expect(fs.readFileSync(result.state.executablePath, 'utf8')).toBe('codex@1.1.0');
    expect(harness.downloaded).toEqual([{ providerId: 'codex', ...candidate }]);
    expect(harness.probes).toContainEqual({
      providerId: 'codex',
      version: '1.1.0',
      quotaConsumptionAllowed: false,
    });
    expect(harness.processCalls.every((call) => call.args.join(' ') === '--version')).toBe(true);
    expect(
      fs
        .readdirSync(path.join(harness.runtimeRoot, 'codex'))
        .some((name) => name.startsWith('.staging-')),
    ).toBe(false);
  });

  it('does not activate an archive whose digest differs from trusted release metadata', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const valid = harness.putArchive('codex', '1.1.0');

    await expectStoreError(
      harness.store.install('codex', { ...valid, sha256: '0'.repeat(64) }),
      'ARCHIVE_DIGEST_MISMATCH',
    );

    expect(fs.readlinkSync(path.join(harness.runtimeRoot, 'codex', 'current'))).toBe(
      harness.packagedCodex,
    );
    expect(harness.probes).toHaveLength(0);
    expect(runtimeVersions(harness.runtimeRoot, 'codex')).toEqual([]);
  });

  it.each(['../escape', '/absolute/outside'])(
    'rejects unsafe archive path %s before activation',
    async (memberName) => {
      const harness = makeHarness();
      await harness.store.initialize();
      const candidate = harness.putArchive(
        'codex',
        '1.1.0',
        archive([{ name: memberName, data: binaryPayload('codex', '1.1.0') }]),
      );

      await expectStoreError(harness.store.install('codex', candidate), 'ARCHIVE_INVALID');

      expect(fs.existsSync(path.join(harness.directory, 'escape'))).toBe(false);
      expect(fs.readlinkSync(path.join(harness.runtimeRoot, 'codex', 'current'))).toBe(
        harness.packagedCodex,
      );
      expect(harness.probes).toHaveLength(0);
    },
  );

  it('rejects symlinks and special filesystem entries instead of extracting them', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const candidate = harness.putArchive(
      'codex',
      '1.1.0',
      archive([{ name: 'bin/codex', type: '2', linkName: '../../outside' }]),
    );

    await expectStoreError(harness.store.install('codex', candidate), 'ARCHIVE_INVALID');

    expect(fs.existsSync(path.join(harness.directory, 'outside'))).toBe(false);
    expect(runtimeVersions(harness.runtimeRoot, 'codex')).toEqual([]);
  });

  it('accepts a validated local PAX path record but rejects a mismatched executable version', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const paxCandidate = harness.putArchive(
      'codex',
      '1.1.0',
      runtimeArchive('codex', '1.1.0', 'bin/codex'),
    );
    await harness.store.install('codex', paxCandidate);

    const wrongVersion = harness.putArchive('codex', '1.2.0', runtimeArchive('codex', '9.9.9'));
    await expectStoreError(
      harness.store.install('codex', wrongVersion),
      'CANDIDATE_VERSION_MISMATCH',
    );
    expect(fs.readlinkSync(path.join(harness.runtimeRoot, 'codex', 'current'))).toBe(
      path.join('versions', '1.1.0', 'bin', 'codex'),
    );
    expect(harness.probes.map((probe) => probe.version)).toEqual(['1.1.0']);
  });

  it('leaves the active executable unchanged when compatibility validation fails', async () => {
    const harness = makeHarness({
      probe: () => Promise.reject(new Error('synthetic probe failure')),
    });
    await harness.store.initialize();
    const candidate = harness.putArchive('codex', '1.1.0');

    await expectStoreError(harness.store.install('codex', candidate), 'COMPATIBILITY_PROBE_FAILED');

    expect(fs.readlinkSync(path.join(harness.runtimeRoot, 'codex', 'current'))).toBe(
      harness.packagedCodex,
    );
    expect(runtimeVersions(harness.runtimeRoot, 'codex')).toEqual([]);
    expect(
      fs
        .readdirSync(path.join(harness.runtimeRoot, 'codex'))
        .some((name) => name.startsWith('.staging-')),
    ).toBe(false);
  });

  it('retains only active and previous versions, and atomically rolls back to the previous runtime', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    await harness.store.install('codex', harness.putArchive('codex', '1.1.0'));
    await harness.store.install('codex', harness.putArchive('codex', '1.2.0'));
    await harness.store.install('codex', harness.putArchive('codex', '1.3.0'));

    expect(runtimeVersions(harness.runtimeRoot, 'codex')).toEqual(['1.2.0', '1.3.0']);
    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      activeVersion: '1.3.0',
      previousVersion: '1.2.0',
    });

    const rolledBack = await harness.store.rollback('codex');
    expect(rolledBack).toMatchObject({ activeVersion: '1.2.0', previousVersion: '1.3.0' });
    expect(fs.readlinkSync(rolledBack.executablePath)).toBe(
      path.join('versions', '1.2.0', 'bin', 'codex'),
    );
    expect(runtimeVersions(harness.runtimeRoot, 'codex')).toEqual(['1.2.0', '1.3.0']);
    expect(harness.probes.some((probe) => probe.version === '1.2.0')).toBe(true);
  });

  it('can roll back the first runtime update directly to the immutable packaged version', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    await harness.store.install('codex', harness.putArchive('codex', '1.1.0'));

    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      activeVersion: '1.1.0',
      activeSource: 'runtime',
      previousVersion: '1.0.0',
    });
    expect(fs.readlinkSync(path.join(harness.runtimeRoot, 'codex', 'previous'))).toBe(
      harness.packagedCodex,
    );

    const rolledBack = await harness.store.rollback('codex');
    expect(rolledBack).toMatchObject({
      activeVersion: '1.0.0',
      activeSource: 'packaged',
      previousVersion: '1.1.0',
    });
    expect(fs.readlinkSync(rolledBack.executablePath)).toBe(harness.packagedCodex);
    expect(fs.readlinkSync(path.join(harness.runtimeRoot, 'codex', 'previous'))).toBe(
      path.join('versions', '1.1.0', 'bin', 'codex'),
    );
  });

  it('recovers a missing current pointer and a runtime pointer whose executable no longer matches', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    await harness.store.install('codex', harness.putArchive('codex', '1.1.0'));
    const currentPath = path.join(harness.runtimeRoot, 'codex', 'current');
    fs.chmodSync(
      path.join(harness.runtimeRoot, 'codex', 'versions', '1.1.0', 'bin', 'codex'),
      0o644,
    );
    fs.writeFileSync(
      path.join(harness.runtimeRoot, 'codex', 'versions', '1.1.0', 'bin', 'codex'),
      'invalid-client',
    );

    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      activeVersion: '1.0.0',
      activeSource: 'packaged',
    });
    expect(fs.readlinkSync(currentPath)).toBe(harness.packagedCodex);
    expect(runtimeVersions(harness.runtimeRoot, 'codex')).toEqual([]);

    fs.unlinkSync(currentPath);
    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      activeVersion: '1.0.0',
    });
    expect(fs.readlinkSync(currentPath)).toBe(harness.packagedCodex);
  });

  it('supports the fixed Antigravity executable layout without sharing provider pointers', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const candidate = harness.putArchive('antigravity', '1.1.0');

    const result = await harness.store.install('antigravity', candidate);

    expect(result.state).toMatchObject({ providerId: 'antigravity', activeVersion: '1.1.0' });
    expect(fs.readlinkSync(result.state.executablePath)).toBe(
      path.join('versions', '1.1.0', 'antigravity'),
    );
    expect(fs.readlinkSync(path.join(harness.runtimeRoot, 'codex', 'current'))).toBe(
      harness.packagedCodex,
    );
  });

  it('returns already_active without downloading and refuses downgrades or rollback without a previous version', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const already = await harness.store.install('codex', {
      version: '1.0.0',
      sha256: 'a'.repeat(64),
    });
    expect(already.status).toBe('already_active');
    expect(harness.downloaded).toHaveLength(0);
    await expectStoreError(
      harness.store.install('codex', { version: '0.9.0', sha256: 'a'.repeat(64) }),
      'CANDIDATE_NOT_NEWER',
    );
    await expectStoreError(harness.store.rollback('codex'), 'NO_PREVIOUS_RUNTIME');
  });

  it('rejects malformed release metadata, unsupported ids, and non-fixed constructor providers', async () => {
    const harness = makeHarness();
    await expectStoreError(
      harness.store.install('codex', { version: '1.2.3-rc.1', sha256: 'a'.repeat(64) }),
      'INVALID_CANDIDATE',
    );
    await expectStoreError(
      harness.store.install('codex', { version: '1.2.3', sha256: 'not-a-digest' }),
      'INVALID_CANDIDATE',
    );
    await expectStoreError(harness.store.getState('fake' as ProviderClientId), 'INVALID_PROVIDER');

    expect(
      () =>
        new ProviderClientRuntimeStore({
          runtimeRoot: path.join(harness.directory, 'another-runtime'),
          packagedClients: {
            codex: {
              packagedExecutablePath: harness.packagedCodex,
              packagedVersion: '1.0.0',
              archiveExecutablePath: '../codex',
            },
            antigravity: {
              packagedExecutablePath: harness.packagedAgy,
              packagedVersion: '1.0.0',
              archiveExecutablePath: 'antigravity',
            },
          },
          downloadArchive: () => Promise.resolve(),
          compatibilityProbe: () => Promise.resolve(),
        }),
    ).toThrowError(ProviderClientRuntimeStoreError);
  });

  it('maps downloader failures and aborted requests without changing the active pointer', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const candidate = harness.putArchive('codex', '1.1.0');
    const failingDownloader = vi.fn(() => Promise.reject(new Error('synthetic download failure')));
    const failureStore = new ProviderClientRuntimeStore({
      runtimeRoot: path.join(harness.directory, 'download-failure'),
      packagedClients: {
        codex: {
          packagedExecutablePath: harness.packagedCodex,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'bin/codex',
        },
        antigravity: {
          packagedExecutablePath: harness.packagedAgy,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'antigravity',
        },
      },
      downloadArchive: failingDownloader,
      runProcess: (executablePath, args) => {
        expect(args).toEqual(['--version']);
        const contents = fs.readFileSync(executablePath, 'utf8');
        const version = contents.slice(contents.indexOf('@') + 1);
        return Promise.resolve({
          exitCode: 0,
          stdout: executablePath === harness.packagedCodex ? `codex-cli ${version}` : version,
          stderr: '',
        });
      },
      compatibilityProbe: () => Promise.resolve(),
    });
    await failureStore.initialize();
    await expectStoreError(failureStore.install('codex', candidate), 'ARCHIVE_DOWNLOAD_FAILED');

    const controller = new AbortController();
    controller.abort();
    await expectStoreError(
      harness.store.install('codex', candidate, controller.signal),
      'OPERATION_ABORTED',
    );
    expect(fs.readlinkSync(path.join(harness.runtimeRoot, 'codex', 'current'))).toBe(
      harness.packagedCodex,
    );
  });

  it('uses the injected filesystem seam and rejects oversized archives before extraction', async () => {
    const harness = makeHarness();
    const fileSystem = {
      ...nodeRuntimeStoreFileSystem,
      lstat: vi.fn((pathname: string) => nodeRuntimeStoreFileSystem.lstat(pathname)),
    };
    const store = new ProviderClientRuntimeStore({
      runtimeRoot: harness.runtimeRoot,
      packagedClients: {
        codex: {
          packagedExecutablePath: harness.packagedCodex,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'bin/codex',
        },
        antigravity: {
          packagedExecutablePath: harness.packagedAgy,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'antigravity',
        },
      },
      downloadArchive: (request, destinationPath) => {
        const bytes = runtimeArchive(request.providerId, request.version);
        fs.writeFileSync(destinationPath, bytes, { mode: 0o600, flag: 'wx' });
        return Promise.resolve();
      },
      runProcess: (executablePath, args) => {
        expect(args).toEqual(['--version']);
        const content = fs.readFileSync(executablePath, 'utf8');
        const version = content.slice(content.indexOf('@') + 1);
        return Promise.resolve({
          exitCode: 0,
          stdout: executablePath === harness.packagedCodex ? `codex-cli ${version}` : version,
          stderr: '',
        });
      },
      compatibilityProbe: () => Promise.resolve(),
      fileSystem,
      limits: { maxCompressedBytes: 16 },
    });
    await store.initialize();
    const bytes = runtimeArchive('codex', '1.1.0');
    await expectStoreError(
      store.install('codex', { version: '1.1.0', sha256: sha256(bytes) }),
      'ARCHIVE_LIMIT_EXCEEDED',
    );
    expect(fileSystem.lstat).toHaveBeenCalled();
  });

  it('rejects corrupt gzip streams and too many archive members', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const corruptGzip = runtimeArchive('codex', '1.1.0');
    const corruptIndex = corruptGzip.length - 5;
    corruptGzip[corruptIndex] = corruptGzip[corruptIndex]! ^ 0xff;
    const corruptCandidate = harness.putArchive('codex', '1.1.0', corruptGzip);
    await expectStoreError(harness.store.install('codex', corruptCandidate), 'ARCHIVE_INVALID');

    const limited = makeHarness();
    const tooMany = archive([
      { name: 'bin', type: '5' },
      { name: 'bin/codex', data: binaryPayload('codex', '1.1.0') },
    ]);
    const constrainedStore = new ProviderClientRuntimeStore({
      runtimeRoot: limited.runtimeRoot,
      packagedClients: {
        codex: {
          packagedExecutablePath: limited.packagedCodex,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'bin/codex',
        },
        antigravity: {
          packagedExecutablePath: limited.packagedAgy,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'antigravity',
        },
      },
      downloadArchive: (_request, destinationPath) => {
        fs.writeFileSync(destinationPath, tooMany, { flag: 'wx' });
        return Promise.resolve();
      },
      runProcess: (executablePath, args) => {
        expect(args).toEqual(['--version']);
        const content = fs.readFileSync(executablePath, 'utf8');
        const version = content.slice(content.indexOf('@') + 1);
        return Promise.resolve({
          exitCode: 0,
          stdout: executablePath === limited.packagedCodex ? `codex-cli ${version}` : version,
          stderr: '',
        });
      },
      compatibilityProbe: () => Promise.resolve(),
      limits: { maxEntries: 1 },
    });
    await constrainedStore.initialize();
    await expectStoreError(
      constrainedStore.install('codex', { version: '1.1.0', sha256: sha256(tooMany) }),
      'ARCHIVE_LIMIT_EXCEEDED',
    );
  });

  it('uses the bounded default process runner only for exact version checks', async () => {
    const harness = makeHarness({ useDefaultProcessRunner: true });
    fs.chmodSync(harness.packagedCodex, 0o755);
    fs.chmodSync(harness.packagedAgy, 0o755);
    fs.writeFileSync(harness.packagedCodex, shellVersion('codex', '1.0.0'));
    fs.writeFileSync(harness.packagedAgy, shellVersion('antigravity', '1.0.0'));
    await harness.store.initialize();

    const candidate = harness.putArchive(
      'codex',
      '1.1.0',
      archive([
        {
          name: 'bin/codex',
          data: shellVersion('codex', '1.1.0', "printf 'bounded diagnostic\\n' >&2\n"),
          mode: 0o755,
        },
      ]),
    );
    const result = await harness.store.install('codex', candidate);

    expect(result.state).toMatchObject({ activeVersion: '1.1.0', activeSource: 'runtime' });
    expect(harness.probes).toContainEqual({
      providerId: 'codex',
      version: '1.1.0',
      quotaConsumptionAllowed: false,
    });
  });

  it.each([
    {
      label: 'process spawn error',
      prepare: (harness: ReturnType<typeof makeHarness>) => {
        fs.chmodSync(harness.packagedCodex, 0o444);
        fs.chmodSync(harness.packagedAgy, 0o444);
      },
      limits: undefined,
    },
    {
      label: 'bounded output overflow',
      prepare: (harness: ReturnType<typeof makeHarness>) => {
        fs.chmodSync(harness.packagedCodex, 0o755);
        fs.chmodSync(harness.packagedAgy, 0o755);
        fs.writeFileSync(harness.packagedCodex, shellVersion('codex', '1.0.0'));
        fs.writeFileSync(harness.packagedAgy, shellVersion('antigravity', '1.0.0'));
      },
      limits: { processOutputBytes: 4 },
    },
    {
      label: 'version timeout',
      prepare: (harness: ReturnType<typeof makeHarness>) => {
        fs.chmodSync(harness.packagedCodex, 0o755);
        fs.chmodSync(harness.packagedAgy, 0o755);
        fs.writeFileSync(harness.packagedCodex, '#!/bin/sh\nwhile :; do :; done\n');
        fs.writeFileSync(harness.packagedAgy, shellVersion('antigravity', '1.0.0'));
      },
      limits: { versionTimeoutMs: 25 },
    },
  ])('fails closed on default process runner $label', async ({ prepare, limits }) => {
    const harness = makeHarness({
      useDefaultProcessRunner: true,
      ...(limits ? { limits } : {}),
    });
    prepare(harness);

    await expectStoreError(harness.store.initialize(), 'PACKAGED_RUNTIME_INVALID');
  });

  it.each([
    ['backslash path', '\\bin\\codex'],
    ['repeated separator', 'bin//codex'],
    ['dot segment', 'bin/./codex'],
    ['empty file path', ''],
  ])('rejects unsafe tar member names: %s', async (_label, memberName) => {
    await expectArchiveRejected(
      archive([{ name: memberName, data: binaryPayload('codex', '1.1.0') }]),
      'ARCHIVE_INVALID',
    );
  });

  it('rejects invalid header checksums, UTF-8, octal fields, and base-256 fields', async () => {
    const sampleEntry = tarEntry({ name: 'bin/codex', data: binaryPayload('codex', '1.1.0') });

    const badChecksum = Buffer.from(sampleEntry);
    badChecksum[0] = badChecksum[0]! ^ 0x01;

    const badUtf8 = Buffer.from(sampleEntry);
    badUtf8[0] = 0xff;
    refreshTarChecksum(badUtf8.subarray(0, 512));

    const badOctal = Buffer.from(sampleEntry);
    badOctal.write('0000008\0', 100, 8, 'ascii');
    refreshTarChecksum(badOctal.subarray(0, 512));

    const base256 = Buffer.from(sampleEntry);
    base256[124] = 0x80;
    refreshTarChecksum(base256.subarray(0, 512));

    for (const entry of [badChecksum, badUtf8, badOctal, base256]) {
      await expectArchiveRejected(
        archiveFromTar(Buffer.concat([entry, Buffer.alloc(1024)])),
        'ARCHIVE_INVALID',
      );
    }
  });

  it('supports a validated USTAR prefix and harmless root directory entries', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const executable = tarEntry({ name: 'codex', data: binaryPayload('codex', '1.1.0') });
    executable.subarray(0, 512).write('bin', 345, 155, 'utf8');
    refreshTarChecksum(executable.subarray(0, 512));
    const prefixed = archiveFromTar(
      Buffer.concat([tarEntry({ name: './', type: '5' }), executable, Buffer.alloc(1024)]),
    );

    const result = await harness.store.install(
      'codex',
      harness.putArchive('codex', '1.1.0', prefixed),
    );

    expect(result.state.activeVersion).toBe('1.1.0');
    expect(fs.readFileSync(result.state.executablePath, 'utf8')).toBe('codex@1.1.0');
  });

  it('handles NUL type flags, full-width names, empty octal fields, and non-executable assets', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const exactWidthName = tarEntry({
      name: 'x'.repeat(100),
      data: Buffer.from('notice'),
      mode: 0o644,
    });
    const executable = tarEntry({ name: 'bin/codex', data: binaryPayload('codex', '1.1.0') });
    executable[156] = 0;
    refreshTarChecksum(executable.subarray(0, 512));
    const emptyOctalDirectory = tarEntry({ name: 'empty', type: '5' });
    emptyOctalDirectory.fill(0, 100, 108);
    emptyOctalDirectory.fill(0, 124, 136);
    refreshTarChecksum(emptyOctalDirectory.subarray(0, 512));
    const input = archiveFromTar(
      Buffer.concat([exactWidthName, emptyOctalDirectory, executable, Buffer.alloc(1024)]),
    );

    const result = await harness.store.install(
      'codex',
      harness.putArchive('codex', '1.1.0', input),
    );

    expect(result.state.activeVersion).toBe('1.1.0');
    expect(fs.readFileSync(result.state.executablePath, 'utf8')).toBe('codex@1.1.0');
    expect(
      fs.statSync(path.join(harness.runtimeRoot, 'codex', 'versions', '1.1.0', 'x'.repeat(100)))
        .mode & 0o777,
    ).toBe(0o444);
  });

  it('rejects malformed PAX keys and returns clean EOF only before an archive header', async () => {
    const malformedPax = [
      Buffer.from('path=bin/codex'),
      paxRecord('', 'empty-key'),
      Buffer.from('1 x\n'),
    ];
    for (const payload of malformedPax) {
      await expectArchiveRejected(
        archive([{ name: 'pax', type: 'x', data: payload }]),
        'ARCHIVE_INVALID',
      );
    }

    await expectArchiveRejected(archiveFromTar(Buffer.alloc(0)), 'ARCHIVE_INVALID');
    await expectArchiveRejected(
      archiveFromTar(
        Buffer.concat([
          tarEntry({ name: 'bin/codex', data: binaryPayload('codex', '1.1.0') }),
          Buffer.alloc(512),
          Buffer.from('not a zero end block'),
        ]),
      ),
      'ARCHIVE_INVALID',
    );
  });

  it.each([
    ['global PAX header', [{ name: 'global', type: 'g', data: Buffer.alloc(0) }]],
    [
      'stacked local PAX headers',
      [
        { name: 'pax-1', type: 'x', data: paxRecord('path', 'bin/codex') },
        { name: 'pax-2', type: 'x', data: paxRecord('path', 'bin/codex') },
      ],
    ],
    ['malformed PAX length', [{ name: 'pax', type: 'x', data: Buffer.from('x path=bin/codex\n') }]],
    [
      'truncated PAX record',
      [{ name: 'pax', type: 'x', data: Buffer.from('99 path=bin/codex\n') }],
    ],
    [
      'duplicate PAX keys',
      [
        {
          name: 'pax',
          type: 'x',
          data: Buffer.concat([paxRecord('path', 'bin/codex'), paxRecord('path', 'bin/codex')]),
        },
      ],
    ],
    [
      'invalid PAX member size',
      [
        { name: 'pax', type: 'x', data: paxRecord('size', '-1') },
        { name: 'bin/codex', data: binaryPayload('codex', '1.1.0') },
      ],
    ],
  ])('rejects unsupported or malformed archive metadata: %s', async (_label, entries) => {
    await expectArchiveRejected(archive(entries), 'ARCHIVE_INVALID');
  });

  it('rejects archive limits, incomplete terminators, trailing data, and missing executables', async () => {
    const longPaxPath = paxRecord('path', `x`.repeat(4100));
    await expectArchiveRejected(
      archive([
        { name: 'pax', type: 'x', data: longPaxPath },
        { name: 'ignored', data: binaryPayload('codex', '1.1.0') },
      ]),
      'ARCHIVE_INVALID',
    );
    await expectArchiveRejected(
      archive([{ name: 'pax', type: 'x', data: paxRecord('path', 'bin/codex') }]),
      'ARCHIVE_INVALID',
    );
    await expectArchiveRejected(
      archive([{ name: 'bin/codex', type: '5', data: Buffer.from('not-empty') }]),
      'ARCHIVE_INVALID',
    );
    await expectArchiveRejected(
      archive([{ name: 'bin/codex', data: binaryPayload('codex', '1.1.0') }]),
      'ARCHIVE_LIMIT_EXCEEDED',
      { maxFileBytes: 2 },
    );
    await expectArchiveRejected(
      archive([{ name: 'bin/codex', data: binaryPayload('codex', '1.1.0') }]),
      'ARCHIVE_LIMIT_EXCEEDED',
      { maxExpandedBytes: 512 },
    );
    await expectArchiveRejected(
      archive([{ name: 'pax', type: 'x', data: paxRecord('path', 'bin/codex') }]),
      'ARCHIVE_LIMIT_EXCEEDED',
      { maxPaxHeaderBytes: 2 },
    );

    const onlyOneEndMarker = Buffer.concat([
      tarEntry({ name: 'bin/codex', data: binaryPayload('codex', '1.1.0') }),
      Buffer.alloc(512),
    ]);
    await expectArchiveRejected(archiveFromTar(onlyOneEndMarker), 'ARCHIVE_INVALID');

    const nonzeroTrailer = Buffer.concat([
      tarEntry({ name: 'bin/codex', data: binaryPayload('codex', '1.1.0') }),
      Buffer.alloc(1024),
      Buffer.from('unexpected trailing bytes'),
    ]);
    await expectArchiveRejected(archiveFromTar(nonzeroTrailer), 'ARCHIVE_INVALID');
    await expectArchiveRejected(
      archive([{ name: 'LICENSE', data: Buffer.from('safe') }]),
      'ARCHIVE_INVALID',
    );
  });

  it.each([
    [
      'duplicate file path',
      [
        { name: 'bin/codex', data: binaryPayload('codex', '1.1.0') },
        { name: 'bin/codex', data: binaryPayload('codex', '1.1.0') },
      ],
    ],
    [
      'duplicate directory path',
      [
        { name: 'bin', type: '5' },
        { name: 'bin', type: '5' },
        { name: 'bin/codex', data: binaryPayload('codex', '1.1.0') },
      ],
    ],
    [
      'file used as a parent directory',
      [
        { name: 'bin', data: Buffer.from('not a directory') },
        { name: 'bin/codex', data: binaryPayload('codex', '1.1.0') },
      ],
    ],
  ])('rejects archive member conflicts: %s', async (_label, entries) => {
    await expectArchiveRejected(archive(entries), 'ARCHIVE_INVALID');
  });

  it('rejects empty, unreadable, or streamed-over-limit archive files', async () => {
    const empty = makeHarness();
    await empty.store.initialize();
    const emptyCandidate = empty.putArchive('codex', '1.1.0', Buffer.alloc(0));
    await expectStoreError(empty.store.install('codex', emptyCandidate), 'ARCHIVE_INVALID');

    const streamFailure = makeHarness();
    const failingFs = {
      ...nodeRuntimeStoreFileSystem,
      createReadStream: (pathname: string) => {
        if (pathname.endsWith('candidate.tar.gz')) {
          return (async function* () {
            yield Buffer.alloc(0);
            await Promise.resolve();
            throw new Error('synthetic read failure');
          })();
        }
        return nodeRuntimeStoreFileSystem.createReadStream(pathname);
      },
    };
    const readFailureStore = new ProviderClientRuntimeStore({
      runtimeRoot: streamFailure.runtimeRoot,
      packagedClients: {
        codex: {
          packagedExecutablePath: streamFailure.packagedCodex,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'bin/codex',
        },
        antigravity: {
          packagedExecutablePath: streamFailure.packagedAgy,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'antigravity',
        },
      },
      downloadArchive: (request, destinationPath) => {
        fs.writeFileSync(destinationPath, runtimeArchive(request.providerId, request.version));
        return Promise.resolve();
      },
      runProcess: (executablePath) => {
        const contents = fs.readFileSync(executablePath, 'utf8');
        const version = contents.slice(contents.indexOf('@') + 1);
        return Promise.resolve({
          exitCode: 0,
          stdout: executablePath === streamFailure.packagedCodex ? `codex-cli ${version}` : version,
          stderr: '',
        });
      },
      compatibilityProbe: () => Promise.resolve(),
      fileSystem: failingFs,
    });
    await readFailureStore.initialize();
    await expectStoreError(
      readFailureStore.install('codex', { version: '1.1.0', sha256: 'a'.repeat(64) }),
      'ARCHIVE_INVALID',
    );

    const streamedOverLimit = makeHarness();
    const overLimitFs = {
      ...nodeRuntimeStoreFileSystem,
      async lstat(pathname: string) {
        const info = await nodeRuntimeStoreFileSystem.lstat(pathname);
        return pathname.endsWith('candidate.tar.gz') ? { ...info, size: 1 } : info;
      },
      createReadStream: (pathname: string) => {
        if (pathname.endsWith('candidate.tar.gz')) {
          return (async function* () {
            yield Buffer.alloc(17);
            await Promise.resolve();
          })();
        }
        return nodeRuntimeStoreFileSystem.createReadStream(pathname);
      },
    };
    const overLimitStore = new ProviderClientRuntimeStore({
      runtimeRoot: streamedOverLimit.runtimeRoot,
      packagedClients: {
        codex: {
          packagedExecutablePath: streamedOverLimit.packagedCodex,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'bin/codex',
        },
        antigravity: {
          packagedExecutablePath: streamedOverLimit.packagedAgy,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'antigravity',
        },
      },
      downloadArchive: (request, destinationPath) => {
        fs.writeFileSync(destinationPath, runtimeArchive(request.providerId, request.version));
        return Promise.resolve();
      },
      runProcess: (executablePath) => {
        const contents = fs.readFileSync(executablePath, 'utf8');
        const version = contents.slice(contents.indexOf('@') + 1);
        return Promise.resolve({
          exitCode: 0,
          stdout:
            executablePath === streamedOverLimit.packagedCodex ? `codex-cli ${version}` : version,
          stderr: '',
        });
      },
      compatibilityProbe: () => Promise.resolve(),
      fileSystem: overLimitFs,
      limits: { maxCompressedBytes: 16 },
    });
    await overLimitStore.initialize();
    await expectStoreError(
      overLimitStore.install('codex', { version: '1.1.0', sha256: 'a'.repeat(64) }),
      'ARCHIVE_LIMIT_EXCEEDED',
    );
  });

  it('rejects a candidate whose executable is a directory or whose --version is invalid', async () => {
    await expectArchiveRejected(archive([{ name: 'bin/codex', type: '5' }]), 'ARCHIVE_INVALID');

    const badOutput = makeHarness({
      processRunner: () => Promise.resolve({ exitCode: 0, stdout: 'not a version', stderr: '' }),
    });
    await expectStoreError(badOutput.store.initialize(), 'PACKAGED_RUNTIME_INVALID');

    const failedExit = makeHarness({
      processRunner: () => Promise.resolve({ exitCode: 2, stdout: 'codex-cli 1.0.0', stderr: '' }),
    });
    await expectStoreError(failedExit.store.initialize(), 'PACKAGED_RUNTIME_INVALID');
  });

  it('recovers directory pointers and refuses corrupt packaged fallbacks', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const currentPath = path.join(harness.runtimeRoot, 'codex', 'current');
    fs.unlinkSync(currentPath);
    fs.mkdirSync(currentPath);

    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      activeVersion: '1.0.0',
      activeSource: 'packaged',
    });
    expect(fs.lstatSync(currentPath).isSymbolicLink()).toBe(true);

    const corrupt = makeHarness();
    fs.chmodSync(corrupt.packagedCodex, 0o755);
    fs.writeFileSync(corrupt.packagedCodex, 'not-the-declared-version');
    await expectStoreError(corrupt.store.initialize(), 'PACKAGED_RUNTIME_INVALID');

    const packagedDirectory = makeHarness();
    fs.rmSync(packagedDirectory.packagedCodex);
    fs.mkdirSync(packagedDirectory.packagedCodex);
    await expectStoreError(packagedDirectory.store.initialize(), 'PACKAGED_RUNTIME_INVALID');
  });

  it('serializes same-provider concurrent installs and retains one previous runtime', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    const candidate = harness.putArchive('codex', '1.1.0');

    const results = await Promise.all([
      harness.store.install('codex', candidate),
      harness.store.install('codex', candidate),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['already_active', 'installed']);
    expect(harness.downloaded).toHaveLength(1);
    expect(runtimeVersions(harness.runtimeRoot, 'codex')).toEqual(['1.1.0']);
  });

  it('keeps active and previous pointers unchanged when rollback compatibility fails', async () => {
    let rejectPrevious = false;
    const harness = makeHarness({
      probe: (_providerId, version) => {
        if (rejectPrevious && version === '1.1.0') throw new Error('read-only probe failed');
      },
    });
    await harness.store.initialize();
    await harness.store.install('codex', harness.putArchive('codex', '1.1.0'));
    await harness.store.install('codex', harness.putArchive('codex', '1.2.0'));
    rejectPrevious = true;

    await expectStoreError(harness.store.rollback('codex'), 'ROLLBACK_VALIDATION_FAILED');

    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      activeVersion: '1.2.0',
      previousVersion: '1.1.0',
    });
  });

  it('restores the previous pointer if activation or rollback cannot replace current', async () => {
    let rejectCurrentReplacement = false;
    const fileSystem = {
      ...nodeRuntimeStoreFileSystem,
      async rename(oldPath: string, newPath: string) {
        if (
          rejectCurrentReplacement &&
          newPath.endsWith(path.join('codex', 'current')) &&
          path.basename(oldPath).startsWith('.staging-pointer-')
        ) {
          throw new Error('synthetic current pointer failure');
        }
        await nodeRuntimeStoreFileSystem.rename(oldPath, newPath);
      },
    };
    const harness = makeHarness({ fileSystem });
    await harness.store.initialize();
    await harness.store.install('codex', harness.putArchive('codex', '1.1.0'));

    rejectCurrentReplacement = true;
    await expectStoreError(
      harness.store.install('codex', harness.putArchive('codex', '1.2.0')),
      'FILESYSTEM_ERROR',
    );
    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      activeVersion: '1.1.0',
      previousVersion: '1.0.0',
    });
    expect(runtimeVersions(harness.runtimeRoot, 'codex')).toEqual(['1.1.0']);

    rejectCurrentReplacement = false;
    await harness.store.install('codex', harness.putArchive('codex', '1.2.0'));
    rejectCurrentReplacement = true;
    await expectStoreError(
      harness.store.install('codex', harness.putArchive('codex', '1.3.0')),
      'FILESYSTEM_ERROR',
    );
    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      activeVersion: '1.2.0',
      previousVersion: '1.1.0',
    });

    rejectCurrentReplacement = false;
    await harness.store.install('codex', harness.putArchive('codex', '1.3.0'));
    rejectCurrentReplacement = true;
    await expectStoreError(harness.store.rollback('codex'), 'FILESYSTEM_ERROR');
    await expect(harness.store.getState('codex')).resolves.toMatchObject({
      activeVersion: '1.3.0',
      previousVersion: '1.2.0',
    });
  });

  it('classifies cancellation during download and read-only compatibility checks', async () => {
    const downloadController = new AbortController();
    const duringDownload = makeHarness({
      downloadArchive: () => {
        downloadController.abort();
        return Promise.reject(new Error('download cancelled'));
      },
    });
    await duringDownload.store.initialize();
    await expectStoreError(
      duringDownload.store.install(
        'codex',
        { version: '1.1.0', sha256: 'a'.repeat(64) },
        downloadController.signal,
      ),
      'OPERATION_ABORTED',
    );

    const probeController = new AbortController();
    const duringProbe = makeHarness({
      downloadArchive: (request, destinationPath) => {
        fs.writeFileSync(destinationPath, runtimeArchive(request.providerId, request.version));
        return Promise.resolve();
      },
      probe: () => {
        probeController.abort();
      },
    });
    await duringProbe.store.initialize();
    await expectStoreError(
      duringProbe.store.install(
        'codex',
        { version: '1.1.0', sha256: sha256(runtimeArchive('codex', '1.1.0')) },
        probeController.signal,
      ),
      'OPERATION_ABORTED',
    );
    expect(runtimeVersions(duringProbe.runtimeRoot, 'codex')).toEqual([]);

    const afterDownloadController = new AbortController();
    const afterDownload = makeHarness({
      downloadArchive: (request, destinationPath) => {
        fs.writeFileSync(destinationPath, runtimeArchive(request.providerId, request.version));
        afterDownloadController.abort();
        return Promise.resolve();
      },
    });
    await afterDownload.store.initialize();
    await expectStoreError(
      afterDownload.store.install(
        'codex',
        { version: '1.1.0', sha256: sha256(runtimeArchive('codex', '1.1.0')) },
        afterDownloadController.signal,
      ),
      'OPERATION_ABORTED',
    );

    const beforeProbeController = new AbortController();
    const beforeProbe = makeHarness({
      processRunner: (executablePath) => {
        const contents = fs.readFileSync(executablePath, 'utf8');
        const version = contents.slice(contents.indexOf('@') + 1);
        if (executablePath.includes('.staging-')) beforeProbeController.abort();
        return Promise.resolve({
          exitCode: 0,
          stdout: executablePath.includes('antigravity') ? version : `codex-cli ${version}`,
          stderr: '',
        });
      },
    });
    await beforeProbe.store.initialize();
    const beforeProbeCandidate = beforeProbe.putArchive('codex', '1.1.0');
    await expectStoreError(
      beforeProbe.store.install('codex', beforeProbeCandidate, beforeProbeController.signal),
      'OPERATION_ABORTED',
    );
  });

  it('rejects unstable versions, malformed constructor settings, and unsafe pointers', async () => {
    const harness = makeHarness();
    await harness.store.initialize();
    await expectStoreError(
      harness.store.install('codex', {
        version: '9007199254740992.0.0',
        sha256: 'a'.repeat(64),
      }),
      'INVALID_CANDIDATE',
    );

    const clients = {
      codex: {
        packagedExecutablePath: harness.packagedCodex,
        packagedVersion: '1.0.0',
        archiveExecutablePath: 'bin/codex',
      },
      antigravity: {
        packagedExecutablePath: harness.packagedAgy,
        packagedVersion: '1.0.0',
        archiveExecutablePath: 'antigravity',
      },
    };
    const construct = (overrides: Record<string, unknown>) =>
      new ProviderClientRuntimeStore({
        runtimeRoot: path.join(harness.directory, 'invalid-runtime'),
        packagedClients: clients,
        downloadArchive: () => Promise.resolve(),
        compatibilityProbe: () => Promise.resolve(),
        ...overrides,
      });

    expect(() => construct({ runtimeRoot: 'relative/path' })).toThrowError(
      ProviderClientRuntimeStoreError,
    );
    expect(() => construct({ packagedClients: null })).toThrowError(
      ProviderClientRuntimeStoreError,
    );
    expect(() => construct({ packagedClients: { codex: clients.codex } })).toThrowError(
      ProviderClientRuntimeStoreError,
    );
    expect(() => construct({ packagedClients: { ...clients, other: clients.codex } })).toThrowError(
      ProviderClientRuntimeStoreError,
    );
    expect(() =>
      construct({
        packagedClients: {
          ...clients,
          antigravity: { ...clients.antigravity, packagedVersion: 'v1' },
        },
      }),
    ).toThrowError(ProviderClientRuntimeStoreError);
    expect(() =>
      construct({
        packagedClients: {
          ...clients,
          codex: { ...clients.codex, packagedExecutablePath: 'codex' },
        },
      }),
    ).toThrowError(ProviderClientRuntimeStoreError);
    expect(() =>
      construct({
        packagedClients: {
          ...clients,
          codex: { ...clients.codex, archiveExecutablePath: '/bin/codex' },
        },
      }),
    ).toThrowError(ProviderClientRuntimeStoreError);
    expect(() =>
      construct({
        packagedClients: {
          ...clients,
          codex: { ...clients.codex, archiveExecutablePath: 'bin\\codex' },
        },
      }),
    ).toThrowError(ProviderClientRuntimeStoreError);
    expect(() => construct({ downloadArchive: undefined })).toThrowError(
      ProviderClientRuntimeStoreError,
    );
    expect(() => construct({ compatibilityProbe: undefined })).toThrowError(
      ProviderClientRuntimeStoreError,
    );
    expect(() => construct({ limits: { maxEntries: 0 } })).toThrowError(
      ProviderClientRuntimeStoreError,
    );

    for (const target of [
      path.join(harness.directory, 'outside'),
      'somewhere/else',
      path.join('versions', '01.2.3', 'bin', 'codex'),
    ]) {
      fs.unlinkSync(path.join(harness.runtimeRoot, 'codex', 'current'));
      fs.symlinkSync(target, path.join(harness.runtimeRoot, 'codex', 'current'));
      await expect(harness.store.getState('codex')).resolves.toMatchObject({
        activeVersion: '1.0.0',
        activeSource: 'packaged',
      });
    }
  });

  it('handles filesystem EEXIST races and reports an invalid runtime root', async () => {
    const harness = makeHarness();
    const fileSystem = {
      ...nodeRuntimeStoreFileSystem,
      async mkdir(pathname: string, mode: number, recursive: boolean) {
        await nodeRuntimeStoreFileSystem.mkdir(pathname, mode, recursive);
        const error = new Error('already exists') as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      },
    };
    const raceStore = new ProviderClientRuntimeStore({
      runtimeRoot: harness.runtimeRoot,
      packagedClients: {
        codex: {
          packagedExecutablePath: harness.packagedCodex,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'bin/codex',
        },
        antigravity: {
          packagedExecutablePath: harness.packagedAgy,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'antigravity',
        },
      },
      downloadArchive: () => Promise.resolve(),
      runProcess: (executablePath) =>
        Promise.resolve({
          exitCode: 0,
          stdout: executablePath === harness.packagedCodex ? 'codex-cli 1.0.0' : '1.0.0',
          stderr: '',
        }),
      compatibilityProbe: () => Promise.resolve(),
      fileSystem,
    });
    await expect(raceStore.initialize()).resolves.toBeUndefined();

    const invalidRoot = makeHarness();
    fs.writeFileSync(invalidRoot.runtimeRoot, 'not a directory');
    await expectStoreError(invalidRoot.store.initialize(), 'FILESYSTEM_ERROR');

    const genericFailure = makeHarness();
    const failingFs = {
      ...nodeRuntimeStoreFileSystem,
      mkdir: () => Promise.reject(new Error('synthetic mkdir failure')),
    };
    const failedStore = new ProviderClientRuntimeStore({
      runtimeRoot: genericFailure.runtimeRoot,
      packagedClients: {
        codex: {
          packagedExecutablePath: genericFailure.packagedCodex,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'bin/codex',
        },
        antigravity: {
          packagedExecutablePath: genericFailure.packagedAgy,
          packagedVersion: '1.0.0',
          archiveExecutablePath: 'antigravity',
        },
      },
      downloadArchive: () => Promise.resolve(),
      runProcess: () => Promise.resolve({ exitCode: 0, stdout: 'codex-cli 1.0.0', stderr: '' }),
      compatibilityProbe: () => Promise.resolve(),
      fileSystem: failingFs,
    });
    await expect(failedStore.initialize()).rejects.toThrow('synthetic mkdir failure');
  });
});
