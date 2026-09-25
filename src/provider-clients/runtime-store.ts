import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  chmod as chmodFile,
  lstat as lstatFile,
  mkdir as mkdirDirectory,
  open as openFile,
  readdir as readDirectory,
  readlink as readSymbolicLink,
  rename as renamePath,
  rm as removePath,
  symlink as createSymbolicLink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

export const PROVIDER_CLIENT_IDS = ['codex', 'antigravity'] as const;
export type ProviderClientId = (typeof PROVIDER_CLIENT_IDS)[number];

export type RuntimeStoreErrorCode =
  | 'INVALID_PROVIDER'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_CANDIDATE'
  | 'OPERATION_ABORTED'
  | 'PACKAGED_RUNTIME_INVALID'
  | 'ARCHIVE_DOWNLOAD_FAILED'
  | 'ARCHIVE_INVALID'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'ARCHIVE_DIGEST_MISMATCH'
  | 'CANDIDATE_VERSION_MISMATCH'
  | 'COMPATIBILITY_PROBE_FAILED'
  | 'CANDIDATE_NOT_NEWER'
  | 'RUNTIME_VERSION_EXISTS'
  | 'NO_PREVIOUS_RUNTIME'
  | 'ROLLBACK_VALIDATION_FAILED'
  | 'FILESYSTEM_ERROR'
  | 'PROCESS_FAILED';

export class ProviderClientRuntimeStoreError extends Error {
  constructor(
    readonly code: RuntimeStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderClientRuntimeStoreError';
  }
}

export interface PackagedProviderClient {
  /** Absolute path to the immutable, image-packaged fallback executable. */
  readonly packagedExecutablePath: string;
  readonly packagedVersion: string;
  /** Executable path inside the official release archive, using POSIX separators. */
  readonly archiveExecutablePath: string;
}

export type PackagedProviderClients = Readonly<Record<ProviderClientId, PackagedProviderClient>>;

export interface RuntimeClientCandidate {
  readonly version: string;
  /** SHA-256 digest obtained from the trusted official-release resolver. */
  readonly sha256: string;
}

export interface RuntimeArchiveRequest extends RuntimeClientCandidate {
  readonly providerId: ProviderClientId;
}

export type RuntimeArchiveDownloader = (
  request: RuntimeArchiveRequest,
  destinationPath: string,
  signal: AbortSignal,
) => Promise<void>;

export interface RuntimeProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RuntimeProcessOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type RuntimeProcessRunner = (
  executablePath: string,
  args: readonly string[],
  options: RuntimeProcessOptions,
) => Promise<RuntimeProcessResult>;

export interface ReadOnlyCompatibilityProbeRequest {
  readonly providerId: ProviderClientId;
  readonly executablePath: string;
  readonly expectedVersion: string;
  readonly purpose: 'read-only-compatibility-probe';
  readonly quotaConsumptionAllowed: false;
}

/** Must use read-only protocol/runtime checks and must never dispatch provider actions. */
export type ReadOnlyCompatibilityProbe = (
  request: ReadOnlyCompatibilityProbeRequest,
  signal: AbortSignal,
) => Promise<void>;

export type RuntimePathKind = 'file' | 'directory' | 'symlink' | 'other';

export interface RuntimePathInfo {
  readonly kind: RuntimePathKind;
  readonly size: number;
}

export interface RuntimeStoreWritableFile {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Narrow filesystem seam. The production implementation uses only Node built-ins. */
export interface RuntimeStoreFileSystem {
  mkdir(pathname: string, mode: number, recursive: boolean): Promise<void>;
  readdir(pathname: string): Promise<string[]>;
  lstat(pathname: string): Promise<RuntimePathInfo>;
  readlink(pathname: string): Promise<string>;
  symlink(target: string, pathname: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(pathname: string): Promise<void>;
  chmod(pathname: string, mode: number): Promise<void>;
  openExclusive(pathname: string, mode: number): Promise<RuntimeStoreWritableFile>;
  createReadStream(pathname: string): AsyncIterable<Uint8Array>;
}

export interface ProviderClientRuntimeStoreOptions {
  /** Dedicated writable runtime volume root, e.g. `/provider-clients`. */
  readonly runtimeRoot: string;
  /** Trusted, fixed descriptors for both packaged provider clients. */
  readonly packagedClients: PackagedProviderClients;
  /** Resolves official assets internally; callers must not accept URLs from a browser. */
  readonly downloadArchive: RuntimeArchiveDownloader;
  /** Injected so tests never need to execute a provider binary. */
  readonly runProcess?: RuntimeProcessRunner;
  /** Injected read-only compatibility checks; this API exposes no action/trigger callback. */
  readonly compatibilityProbe: ReadOnlyCompatibilityProbe;
  readonly fileSystem?: RuntimeStoreFileSystem;
  readonly limits?: Partial<RuntimeStoreLimits>;
}

export interface RuntimeStoreLimits {
  readonly maxCompressedBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxFileBytes: number;
  readonly maxEntries: number;
  readonly maxPaxHeaderBytes: number;
  readonly versionTimeoutMs: number;
  readonly processOutputBytes: number;
}

export interface ProviderClientRuntimeState {
  readonly providerId: ProviderClientId;
  /** Stable path suitable for provider adapter configuration. */
  readonly executablePath: string;
  readonly packagedVersion: string;
  readonly activeVersion: string;
  readonly activeSource: 'packaged' | 'runtime';
  readonly previousVersion: string | null;
}

export interface ProviderClientRuntimeInstallResult {
  readonly status: 'installed' | 'already_active';
  readonly state: ProviderClientRuntimeState;
}

interface RuntimePointer {
  version: string;
  source: 'packaged' | 'runtime';
  executablePath: string;
}

const DEFAULT_LIMITS: RuntimeStoreLimits = Object.freeze({
  maxCompressedBytes: 256 * 1024 * 1024,
  maxExpandedBytes: 768 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
  maxEntries: 4096,
  maxPaxHeaderBytes: 64 * 1024,
  versionTimeoutMs: 10_000,
  processOutputBytes: 16 * 1024,
});

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TAR_BLOCK_SIZE = 512;
const ARCHIVE_READ_CHUNK_SIZE = 64 * 1024;

function makeNodeFileSystem(): RuntimeStoreFileSystem {
  return {
    async mkdir(pathname, mode, recursive) {
      await mkdirDirectory(pathname, { mode, recursive });
    },
    async readdir(pathname) {
      return readDirectory(pathname);
    },
    async lstat(pathname) {
      const stat = await lstatFile(pathname);
      return {
        kind: stat.isFile()
          ? 'file'
          : stat.isDirectory()
            ? 'directory'
            : stat.isSymbolicLink()
              ? 'symlink'
              : 'other',
        size: stat.size,
      };
    },
    async readlink(pathname) {
      return readSymbolicLink(pathname);
    },
    async symlink(target, pathname) {
      await createSymbolicLink(target, pathname);
    },
    async rename(oldPath, newPath) {
      await renamePath(oldPath, newPath);
    },
    async rm(pathname) {
      // Node removes a symlink itself rather than following its target.
      await removePath(pathname, { recursive: true, force: true });
    },
    async chmod(pathname, mode) {
      await chmodFile(pathname, mode);
    },
    async openExclusive(pathname, mode) {
      const handle = await openFile(pathname, 'wx', mode);
      return {
        async write(bytes) {
          let offset = 0;
          while (offset < bytes.byteLength) {
            const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
            if (result.bytesWritten <= 0) throw new Error('short write');
            offset += result.bytesWritten;
          }
        },
        async close() {
          await handle.close();
        },
      };
    },
    createReadStream(pathname) {
      return createReadStream(pathname);
    },
  };
}

export const nodeRuntimeStoreFileSystem = makeNodeFileSystem();

const defaultProcessRunner: RuntimeProcessRunner = (executablePath, args, options) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executablePath, [...args], {
        cwd: tmpdir(),
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: tmpdir() },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(
        new ProviderClientRuntimeStoreError('PROCESS_FAILED', 'Provider version check failed'),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    timer.unref();

    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      capturedBytes += bytes.byteLength;
      if (capturedBytes > options.maxOutputBytes) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      target.push(bytes);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    child.once('error', () => {
      clearTimeout(timer);
      reject(
        new ProviderClientRuntimeStoreError('PROCESS_FAILED', 'Provider version check failed'),
      );
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (timedOut || outputExceeded) {
        reject(
          new ProviderClientRuntimeStoreError('PROCESS_FAILED', 'Provider version check failed'),
        );
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });

function isProviderClientId(value: string): value is ProviderClientId {
  return (PROVIDER_CLIENT_IDS as readonly string[]).includes(value);
}

function parseStableVersion(version: string): [number, number, number] | undefined {
  if (!STABLE_VERSION_PATTERN.test(version)) return undefined;
  const components = version.split('.').map(Number);
  if (components.some((component) => !Number.isSafeInteger(component))) return undefined;
  return [components[0]!, components[1]!, components[2]!];
}

function compareStableVersions(left: string, right: string): number {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function fail(code: RuntimeStoreErrorCode, message: string): never {
  throw new ProviderClientRuntimeStoreError(code, message);
}

function safeArchivePath(input: string, directory: boolean): string | undefined {
  if (input.length === 0 || input.length > 4096 || input.includes('\0') || input.includes('\\')) {
    fail('ARCHIVE_INVALID', 'Provider archive contains an invalid member path');
  }
  if (input.startsWith('/') || path.posix.isAbsolute(input)) {
    fail('ARCHIVE_INVALID', 'Provider archive contains an absolute member path');
  }

  let normalized = input;
  if (directory && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized === '.' || normalized === '') {
    if (directory) return undefined;
    fail('ARCHIVE_INVALID', 'Provider archive contains an empty file path');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail('ARCHIVE_INVALID', 'Provider archive contains a path traversal member');
  }
  return segments.join(path.sep);
}

function validateArchiveExecutablePath(input: string): string {
  if (input.includes('\\') || path.posix.isAbsolute(input)) {
    fail('INVALID_CONFIGURATION', 'Archive executable path must be a relative POSIX path');
  }
  const normalized = safeArchivePath(input, false);
  if (!normalized) fail('INVALID_CONFIGURATION', 'Archive executable path is empty');
  return normalized;
}

function validatePackagedClients(input: PackagedProviderClients): PackagedProviderClients {
  if (!input || typeof input !== 'object') {
    fail('INVALID_CONFIGURATION', 'Both packaged provider client descriptors are required');
  }
  const keys = Object.keys(input).sort();
  if (keys.join(',') !== [...PROVIDER_CLIENT_IDS].sort().join(',')) {
    fail(
      'INVALID_CONFIGURATION',
      'Packaged provider client descriptors must be codex and antigravity',
    );
  }

  const result = {} as Record<ProviderClientId, PackagedProviderClient>;
  for (const providerId of PROVIDER_CLIENT_IDS) {
    const descriptor = input[providerId];
    if (
      !descriptor ||
      !path.isAbsolute(descriptor.packagedExecutablePath) ||
      !parseStableVersion(descriptor.packagedVersion) ||
      typeof descriptor.archiveExecutablePath !== 'string'
    ) {
      fail('INVALID_CONFIGURATION', `Invalid packaged ${providerId} descriptor`);
    }
    result[providerId] = Object.freeze({
      packagedExecutablePath: path.resolve(descriptor.packagedExecutablePath),
      packagedVersion: descriptor.packagedVersion,
      archiveExecutablePath: validateArchiveExecutablePath(descriptor.archiveExecutablePath),
    });
  }
  return Object.freeze(result);
}

function validateCandidate(candidate: RuntimeClientCandidate): RuntimeClientCandidate {
  if (
    !candidate ||
    !parseStableVersion(candidate.version) ||
    typeof candidate.sha256 !== 'string' ||
    !SHA256_PATTERN.test(candidate.sha256)
  ) {
    fail('INVALID_CANDIDATE', 'Candidate must include a stable version and SHA-256 digest');
  }
  return Object.freeze({ version: candidate.version, sha256: candidate.sha256 });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

interface TarHeader {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly mode: number;
}

class TarStreamReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffered = Buffer.alloc(0);
  private ended = false;
  private expandedBytes = 0;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly maxExpandedBytes: number,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async readExact(length: number, allowCleanEof = false): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let received = 0;
    while (received < length) {
      if (this.buffered.byteLength > 0) {
        const take = Math.min(length - received, this.buffered.byteLength);
        chunks.push(this.buffered.subarray(0, take));
        this.buffered = this.buffered.subarray(take);
        received += take;
        continue;
      }
      if (this.ended) {
        if (received === 0 && allowCleanEof) return undefined;
        fail('ARCHIVE_INVALID', 'Provider archive ended unexpectedly');
      }
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        if (received === 0 && allowCleanEof) return undefined;
        fail('ARCHIVE_INVALID', 'Provider archive ended unexpectedly');
      }
      const chunk = Buffer.from(next.value);
      this.expandedBytes += chunk.byteLength;
      if (this.expandedBytes > this.maxExpandedBytes) {
        fail('ARCHIVE_LIMIT_EXCEEDED', 'Provider archive expands beyond the configured limit');
      }
      this.buffered = chunk;
    }
    return Buffer.concat(chunks, length);
  }

  async readSmallPayload(size: number, maximum: number): Promise<Buffer> {
    if (size > maximum) fail('ARCHIVE_LIMIT_EXCEEDED', 'Provider archive metadata is too large');
    return (await this.readExact(size))!;
  }

  async discardPadding(size: number): Promise<void> {
    const padding = (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) await this.readExact(padding);
  }

  async drainZeroPadding(): Promise<void> {
    let current = this.buffered;
    this.buffered = Buffer.alloc(0);
    while (true) {
      if (current.some((byte) => byte !== 0)) {
        fail('ARCHIVE_INVALID', 'Provider archive contains data after its end marker');
      }
      if (this.ended) return;
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        return;
      }
      current = Buffer.from(next.value);
      this.expandedBytes += current.byteLength;
      if (this.expandedBytes > this.maxExpandedBytes) {
        fail('ARCHIVE_LIMIT_EXCEEDED', 'Provider archive expands beyond the configured limit');
      }
    }
  }
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('ARCHIVE_INVALID', `Provider archive contains an invalid ${label}`);
  }
}

function readTarString(bytes: Buffer, label: string): string {
  const end = bytes.indexOf(0);
  const content = end === -1 ? bytes : bytes.subarray(0, end);
  return decodeUtf8(content, label);
}

function parseOctal(bytes: Buffer, label: string): number {
  if (bytes.byteLength > 0 && (bytes[0]! & 0x80) !== 0) {
    fail('ARCHIVE_INVALID', `Provider archive uses unsupported ${label} encoding`);
  }
  const text = bytes
    .toString('ascii')
    .replace(/[\0 ]+$/g, '')
    .replace(/^ +/g, '');
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) fail('ARCHIVE_INVALID', `Provider archive has invalid ${label}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('ARCHIVE_LIMIT_EXCEEDED', `Provider archive ${label} is out of range`);
  }
  return value;
}

function parseTarHeader(block: Buffer): TarHeader | undefined {
  if (block.every((byte) => byte === 0)) return undefined;
  const expectedChecksum = parseOctal(block.subarray(148, 156), 'header checksum');
  let actualChecksum = 0;
  for (let index = 0; index < block.byteLength; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 32 : block[index]!;
  }
  if (actualChecksum !== expectedChecksum) {
    fail('ARCHIVE_INVALID', 'Provider archive has an invalid header checksum');
  }

  const name = readTarString(block.subarray(0, 100), 'member name');
  const prefix = readTarString(block.subarray(345, 500), 'member prefix');
  const magic = block.subarray(257, 263).toString('ascii');
  const fullName =
    (magic === 'ustar\0' || magic === 'ustar ') && prefix ? `${prefix}/${name}` : name;
  const typeFlag = block[156]!;
  const type = typeFlag === 0 ? '0' : String.fromCharCode(typeFlag);
  return {
    name: fullName,
    type,
    size: parseOctal(block.subarray(124, 136), 'member size'),
    mode: parseOctal(block.subarray(100, 108), 'member mode'),
  };
}

function parsePaxRecords(payload: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < payload.byteLength) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0) fail('ARCHIVE_INVALID', 'Provider archive has malformed PAX metadata');
    const lengthText = payload.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/.test(lengthText)) {
      fail('ARCHIVE_INVALID', 'Provider archive has malformed PAX record length');
    }
    const recordLength = Number(lengthText);
    if (!Number.isSafeInteger(recordLength) || recordLength <= space - offset + 1) {
      fail('ARCHIVE_INVALID', 'Provider archive has malformed PAX record length');
    }
    const recordEnd = offset + recordLength;
    if (recordEnd > payload.byteLength || payload[recordEnd - 1] !== 0x0a) {
      fail('ARCHIVE_INVALID', 'Provider archive has a truncated PAX record');
    }
    const body = payload.subarray(space + 1, recordEnd - 1);
    const equals = body.indexOf(0x3d);
    if (equals <= 0) fail('ARCHIVE_INVALID', 'Provider archive has malformed PAX metadata');
    const key = decodeUtf8(body.subarray(0, equals), 'PAX key');
    const value = decodeUtf8(body.subarray(equals + 1), 'PAX value');
    if (records.has(key)) fail('ARCHIVE_INVALID', 'Provider archive repeats a PAX metadata key');
    records.set(key, value);
    offset = recordEnd;
  }
  return records;
}

function paxSize(records: ReadonlyMap<string, string>, headerSize: number): number {
  const value = records.get('size');
  if (value === undefined) return headerSize;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    fail('ARCHIVE_INVALID', 'Provider archive has invalid PAX member size');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail('ARCHIVE_LIMIT_EXCEEDED', 'Provider archive PAX member size is out of range');
  }
  return parsed;
}

function joinedPaxPath(header: TarHeader, records: ReadonlyMap<string, string>): string {
  return records.get('path') ?? header.name;
}

function assertWithin(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail('ARCHIVE_INVALID', 'Provider archive member escapes its staging directory');
  }
  return resolvedCandidate;
}

async function ensureDirectoryTree(
  fileSystem: RuntimeStoreFileSystem,
  root: string,
  relativeDirectory: string,
): Promise<void> {
  let current = root;
  const segments = relativeDirectory === '' ? [] : relativeDirectory.split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await fileSystem.lstat(current);
      if (info.kind !== 'directory') {
        fail('ARCHIVE_INVALID', 'Provider archive has conflicting file and directory paths');
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await fileSystem.mkdir(current, 0o755, false);
    }
  }
}

async function extractTarGzip(
  fileSystem: RuntimeStoreFileSystem,
  archivePath: string,
  destinationRoot: string,
  limits: RuntimeStoreLimits,
): Promise<void> {
  const compressed = Readable.from(fileSystem.createReadStream(archivePath));
  const gunzip = createGunzip();
  compressed.once('error', (error) => gunzip.destroy(error));
  const expanded = compressed.pipe(gunzip);
  const reader = new TarStreamReader(expanded, limits.maxExpandedBytes);
  const memberKinds = new Map<string, 'file' | 'directory'>();
  const explicitDirectories = new Set<string>();
  let entryCount = 0;
  let pendingPax: Map<string, string> | undefined;
  let foundEnd = false;

  try {
    await fileSystem.mkdir(destinationRoot, 0o700, false);
    while (true) {
      const block = await reader.readExact(TAR_BLOCK_SIZE, true);
      if (!block) break;
      const header = parseTarHeader(block);
      if (!header) {
        const secondEnd = await reader.readExact(TAR_BLOCK_SIZE);
        if (!secondEnd || !secondEnd.every((byte) => byte === 0)) {
          fail('ARCHIVE_INVALID', 'Provider archive has an incomplete end marker');
        }
        foundEnd = true;
        break;
      }

      if (header.type === 'x') {
        if (pendingPax) fail('ARCHIVE_INVALID', 'Provider archive stacks unsupported PAX headers');
        const payload = await reader.readSmallPayload(header.size, limits.maxPaxHeaderBytes);
        pendingPax = parsePaxRecords(payload);
        await reader.discardPadding(header.size);
        continue;
      }
      if (header.type === 'g') {
        fail('ARCHIVE_INVALID', 'Provider archive uses unsupported global PAX metadata');
      }
      if (header.type !== '0' && header.type !== '5') {
        fail('ARCHIVE_INVALID', 'Provider archive contains a link or special filesystem entry');
      }

      const isDirectory = header.type === '5';
      const rawName = joinedPaxPath(header, pendingPax ?? new Map());
      const relativePath = safeArchivePath(rawName, isDirectory);
      const actualSize = paxSize(pendingPax ?? new Map(), header.size);
      pendingPax = undefined;
      if (isDirectory && actualSize !== 0) {
        fail('ARCHIVE_INVALID', 'Provider archive directory entry contains file data');
      }
      if (actualSize > limits.maxFileBytes) {
        fail('ARCHIVE_LIMIT_EXCEEDED', 'Provider archive contains an oversized file');
      }
      if (relativePath === undefined) {
        await reader.discardPadding(actualSize);
        continue;
      }

      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        fail('ARCHIVE_LIMIT_EXCEEDED', 'Provider archive contains too many entries');
      }
      const outputPath = assertWithin(destinationRoot, path.join(destinationRoot, relativePath));
      const parentRelative = path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath);
      await ensureDirectoryTree(fileSystem, destinationRoot, parentRelative);

      if (isDirectory) {
        const existing = memberKinds.get(relativePath);
        if (existing === 'file' || explicitDirectories.has(relativePath)) {
          fail('ARCHIVE_INVALID', 'Provider archive repeats or conflicts with a member path');
        }
        memberKinds.set(relativePath, 'directory');
        explicitDirectories.add(relativePath);
        await ensureDirectoryTree(fileSystem, destinationRoot, relativePath);
        await reader.discardPadding(actualSize);
        continue;
      }

      if (memberKinds.has(relativePath)) {
        fail('ARCHIVE_INVALID', 'Provider archive repeats or conflicts with a member path');
      }
      memberKinds.set(relativePath, 'file');
      const file = await fileSystem.openExclusive(outputPath, 0o600);
      let remaining = actualSize;
      try {
        while (remaining > 0) {
          const chunkSize = Math.min(remaining, ARCHIVE_READ_CHUNK_SIZE);
          const chunk = await reader.readExact(chunkSize);
          await file.write(chunk!);
          remaining -= chunkSize;
        }
      } finally {
        await file.close();
      }
      await fileSystem.chmod(outputPath, (header.mode & 0o111) !== 0 ? 0o555 : 0o444);
      await reader.discardPadding(actualSize);
    }

    if (!foundEnd || pendingPax) {
      fail('ARCHIVE_INVALID', 'Provider archive is truncated or has dangling metadata');
    }
    await reader.drainZeroPadding();
  } catch (error) {
    expanded.destroy();
    compressed.destroy();
    if (error instanceof ProviderClientRuntimeStoreError) throw error;
    fail('ARCHIVE_INVALID', 'Provider archive could not be safely extracted');
  }
}

async function sha256File(
  fileSystem: RuntimeStoreFileSystem,
  pathname: string,
  maxBytes: number,
): Promise<string> {
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of fileSystem.createReadStream(pathname)) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        fail('ARCHIVE_LIMIT_EXCEEDED', 'Provider archive exceeds the compressed size limit');
      }
      digest.update(chunk);
    }
  } catch (error) {
    if (error instanceof ProviderClientRuntimeStoreError) throw error;
    fail('ARCHIVE_INVALID', 'Provider archive could not be read');
  }
  if (bytes === 0) fail('ARCHIVE_INVALID', 'Provider archive is empty');
  return digest.digest('hex');
}

function parseVersionOutput(providerId: ProviderClientId, output: string): string | undefined {
  const normalized = output.trim();
  const match =
    providerId === 'codex'
      ? /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(normalized)
      : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(normalized);
  if (!match) return undefined;
  const version = providerId === 'codex' ? normalized.slice('codex-cli '.length) : normalized;
  return parseStableVersion(version) ? version : undefined;
}

function abortError(): ProviderClientRuntimeStoreError {
  return new ProviderClientRuntimeStoreError(
    'OPERATION_ABORTED',
    'Provider runtime operation was aborted',
  );
}

export class ProviderClientRuntimeStore {
  private readonly runtimeRoot: string;
  private readonly packagedClients: PackagedProviderClients;
  private readonly fileSystem: RuntimeStoreFileSystem;
  private readonly runProcess: RuntimeProcessRunner;
  private readonly downloadArchive: RuntimeArchiveDownloader;
  private readonly compatibilityProbe: ReadOnlyCompatibilityProbe;
  private readonly limits: RuntimeStoreLimits;
  private readonly initialized = new Set<ProviderClientId>();
  private readonly lockTails = new Map<ProviderClientId, Promise<void>>();

  constructor(options: ProviderClientRuntimeStoreOptions) {
    if (!path.isAbsolute(options.runtimeRoot)) {
      fail('INVALID_CONFIGURATION', 'Provider runtime root must be an absolute path');
    }
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.packagedClients = validatePackagedClients(options.packagedClients);
    this.fileSystem = options.fileSystem ?? nodeRuntimeStoreFileSystem;
    this.runProcess = options.runProcess ?? defaultProcessRunner;
    if (
      typeof options.downloadArchive !== 'function' ||
      typeof options.compatibilityProbe !== 'function'
    ) {
      fail(
        'INVALID_CONFIGURATION',
        'Runtime downloader and read-only compatibility probe are required',
      );
    }
    this.downloadArchive = options.downloadArchive;
    this.compatibilityProbe = options.compatibilityProbe;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        fail('INVALID_CONFIGURATION', `Runtime store limit ${name} must be a positive integer`);
      }
    }
  }

  async initialize(): Promise<void> {
    for (const providerId of PROVIDER_CLIENT_IDS) {
      await this.withProviderLock(providerId, async () => {
        await this.initializeProvider(providerId);
      });
    }
  }

  async getState(providerId: ProviderClientId): Promise<ProviderClientRuntimeState> {
    this.assertProviderId(providerId);
    return this.withProviderLock(providerId, async () => {
      await this.ensureInitialized(providerId);
      return this.readStateAndRecover(providerId);
    });
  }

  async resolveExecutable(providerId: ProviderClientId): Promise<string> {
    const state = await this.getState(providerId);
    return state.executablePath;
  }

  async install(
    providerId: ProviderClientId,
    input: RuntimeClientCandidate,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderClientRuntimeInstallResult> {
    this.assertProviderId(providerId);
    const candidate = validateCandidate(input);
    return this.withProviderLock(providerId, async () => {
      await this.ensureInitialized(providerId);
      if (signal.aborted) throw abortError();
      const current = await this.readStateAndRecover(providerId);
      if (candidate.version === current.activeVersion) {
        return { status: 'already_active', state: current };
      }
      if (compareStableVersions(candidate.version, current.activeVersion) <= 0) {
        fail('CANDIDATE_NOT_NEWER', 'Runtime updates must be newer than the active client');
      }

      const paths = this.providerPaths(providerId);
      const stagingRoot = path.join(paths.providerRoot, `.staging-${randomUUID()}`);
      const payloadRoot = path.join(stagingRoot, 'payload');
      const archivePath = path.join(stagingRoot, 'candidate.tar.gz');
      const versionRoot = path.join(paths.versionsRoot, candidate.version);
      let movedToVersions = false;
      let activated = false;

      try {
        await this.fileSystem.mkdir(stagingRoot, 0o700, false);
        try {
          await this.downloadArchive(
            { providerId, version: candidate.version, sha256: candidate.sha256 },
            archivePath,
            signal,
          );
        } catch {
          if (signal.aborted) throw abortError();
          fail('ARCHIVE_DOWNLOAD_FAILED', 'Official provider archive download failed');
        }
        if (signal.aborted) throw abortError();
        const archiveInfo = await this.fileSystem.lstat(archivePath);
        if (archiveInfo.kind !== 'file' || archiveInfo.size > this.limits.maxCompressedBytes) {
          fail(
            'ARCHIVE_LIMIT_EXCEEDED',
            'Downloaded provider archive is not a bounded regular file',
          );
        }
        const actualDigest = await sha256File(
          this.fileSystem,
          archivePath,
          this.limits.maxCompressedBytes,
        );
        if (actualDigest !== candidate.sha256) {
          fail(
            'ARCHIVE_DIGEST_MISMATCH',
            'Provider archive digest did not match official metadata',
          );
        }

        await extractTarGzip(this.fileSystem, archivePath, payloadRoot, this.limits);
        const descriptor = this.packagedClients[providerId];
        const candidateExecutable = assertWithin(
          payloadRoot,
          path.join(payloadRoot, descriptor.archiveExecutablePath),
        );
        let executableInfo: RuntimePathInfo;
        try {
          executableInfo = await this.fileSystem.lstat(candidateExecutable);
        } catch (error) {
          if (isMissing(error)) {
            fail('ARCHIVE_INVALID', 'Provider archive is missing its expected executable');
          }
          throw error;
        }
        if (executableInfo.kind !== 'file') {
          fail('ARCHIVE_INVALID', 'Provider archive is missing its expected executable');
        }
        await this.fileSystem.chmod(candidateExecutable, 0o555);
        await this.assertExecutableVersion(providerId, candidateExecutable, candidate.version);

        if (signal.aborted) throw abortError();
        const probeController = new AbortController();
        const abortProbe = () => probeController.abort();
        signal.addEventListener('abort', abortProbe, { once: true });
        try {
          await this.compatibilityProbe(
            {
              providerId,
              executablePath: candidateExecutable,
              expectedVersion: candidate.version,
              purpose: 'read-only-compatibility-probe',
              quotaConsumptionAllowed: false,
            },
            probeController.signal,
          );
        } catch {
          fail('COMPATIBILITY_PROBE_FAILED', 'Provider runtime compatibility validation failed');
        } finally {
          signal.removeEventListener('abort', abortProbe);
        }
        if (signal.aborted) throw abortError();

        await this.fileSystem.rm(archivePath);
        try {
          await this.fileSystem.lstat(versionRoot);
          fail('RUNTIME_VERSION_EXISTS', 'Candidate runtime version already exists on disk');
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await this.fileSystem.rename(payloadRoot, versionRoot);
        movedToVersions = true;

        const currentPointer = await this.readPointer(providerId, 'current');
        const previousPointer = await this.readPointer(providerId, 'previous');
        if (!currentPointer)
          fail('FILESYSTEM_ERROR', 'Current provider runtime pointer disappeared');
        if (currentPointer?.source === 'runtime') {
          await this.replacePointer(
            providerId,
            'previous',
            this.runtimeLinkTarget(providerId, currentPointer.version),
          );
        } else {
          await this.replacePointer(
            providerId,
            'previous',
            this.packagedClients[providerId].packagedExecutablePath,
          );
        }
        try {
          await this.replacePointer(
            providerId,
            'current',
            this.runtimeLinkTarget(providerId, candidate.version),
          );
        } catch (error) {
          try {
            if (previousPointer) {
              await this.replacePointer(
                providerId,
                'previous',
                this.pointerTarget(providerId, previousPointer),
              );
            } else {
              await this.fileSystem.rm(this.pointerPath(providerId, 'previous'));
            }
          } catch {
            fail('FILESYSTEM_ERROR', 'Provider runtime pointers could not be restored safely');
          }
          throw error;
        }
        activated = true;
        const state: ProviderClientRuntimeState = {
          providerId,
          executablePath: this.pointerPath(providerId, 'current'),
          packagedVersion: this.packagedClients[providerId].packagedVersion,
          activeVersion: candidate.version,
          activeSource: 'runtime',
          previousVersion: currentPointer.version,
        };
        // Pointer replacement is the activation commit point. A pruning error must
        // not report an already-active version as a failed install.
        try {
          await this.pruneRuntimeVersions(providerId, state);
        } catch {
          // The next state read retries bounded version pruning.
        }
        return { status: 'installed', state };
      } catch (error) {
        if (movedToVersions && !activated) await this.fileSystem.rm(versionRoot);
        if (error instanceof ProviderClientRuntimeStoreError) throw error;
        fail('FILESYSTEM_ERROR', 'Provider runtime update could not be safely installed');
      } finally {
        await this.fileSystem.rm(stagingRoot);
      }
    });
  }

  async rollback(providerId: ProviderClientId): Promise<ProviderClientRuntimeState> {
    this.assertProviderId(providerId);
    return this.withProviderLock(providerId, async () => {
      await this.ensureInitialized(providerId);
      const current = await this.readStateAndRecover(providerId);
      const previous = await this.readPointer(providerId, 'previous');
      if (!previous || previous.version === current.activeVersion) {
        fail('NO_PREVIOUS_RUNTIME', 'No previous runtime version is available for rollback');
      }

      try {
        await this.assertExecutableVersion(providerId, previous.executablePath, previous.version);
        await this.compatibilityProbe(
          {
            providerId,
            executablePath: previous.executablePath,
            expectedVersion: previous.version,
            purpose: 'read-only-compatibility-probe',
            quotaConsumptionAllowed: false,
          },
          new AbortController().signal,
        );
      } catch {
        fail('ROLLBACK_VALIDATION_FAILED', 'Previous provider runtime failed validation');
      }

      if (current.activeSource === 'runtime') {
        await this.replacePointer(
          providerId,
          'previous',
          this.runtimeLinkTarget(providerId, current.activeVersion),
        );
        try {
          await this.replacePointer(
            providerId,
            'current',
            this.pointerTarget(providerId, previous),
          );
        } catch (error) {
          try {
            await this.replacePointer(
              providerId,
              'previous',
              this.pointerTarget(providerId, previous),
            );
          } catch {
            fail('FILESYSTEM_ERROR', 'Provider runtime pointers could not be restored safely');
          }
          if (error instanceof ProviderClientRuntimeStoreError) throw error;
          fail('FILESYSTEM_ERROR', 'Provider runtime rollback could not be safely applied');
        }
      } else {
        await this.replacePointer(providerId, 'current', this.pointerTarget(providerId, previous));
        await this.fileSystem.rm(this.pointerPath(providerId, 'previous'));
      }
      const state = await this.readStateAndRecover(providerId);
      await this.pruneRuntimeVersions(providerId, state);
      return state;
    });
  }

  private assertProviderId(providerId: string): asserts providerId is ProviderClientId {
    if (!isProviderClientId(providerId)) fail('INVALID_PROVIDER', 'Unsupported provider client id');
  }

  private async withProviderLock<T>(
    providerId: ProviderClientId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lockTails.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lockTails.set(providerId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lockTails.get(providerId) === tail) this.lockTails.delete(providerId);
    }
  }

  private providerPaths(providerId: ProviderClientId): {
    providerRoot: string;
    versionsRoot: string;
    currentPath: string;
    previousPath: string;
  } {
    const providerRoot = path.join(this.runtimeRoot, providerId);
    return {
      providerRoot,
      versionsRoot: path.join(providerRoot, 'versions'),
      currentPath: path.join(providerRoot, 'current'),
      previousPath: path.join(providerRoot, 'previous'),
    };
  }

  private pointerPath(providerId: ProviderClientId, pointer: 'current' | 'previous'): string {
    const paths = this.providerPaths(providerId);
    return pointer === 'current' ? paths.currentPath : paths.previousPath;
  }

  private async ensureDirectory(pathname: string, mode: number): Promise<void> {
    try {
      await this.fileSystem.mkdir(pathname, mode, true);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const info = await this.fileSystem.lstat(pathname);
    if (info.kind !== 'directory')
      fail('FILESYSTEM_ERROR', 'Provider runtime path is not a directory');
  }

  private async ensureLayout(providerId: ProviderClientId): Promise<void> {
    const paths = this.providerPaths(providerId);
    await this.ensureDirectory(this.runtimeRoot, 0o700);
    await this.ensureDirectory(paths.providerRoot, 0o700);
    await this.ensureDirectory(paths.versionsRoot, 0o700);
  }

  private async initializeProvider(providerId: ProviderClientId): Promise<void> {
    await this.ensureLayout(providerId);
    await this.removeAbandonedStaging(providerId);
    const descriptor = this.packagedClients[providerId];
    try {
      const info = await this.fileSystem.lstat(descriptor.packagedExecutablePath);
      if (info.kind !== 'file') throw new Error('not a regular file');
      await this.assertExecutableVersion(
        providerId,
        descriptor.packagedExecutablePath,
        descriptor.packagedVersion,
      );
    } catch {
      fail('PACKAGED_RUNTIME_INVALID', `Packaged ${providerId} fallback runtime failed validation`);
    }

    let current = await this.readPointer(providerId, 'current');
    if (!current || !(await this.pointerVersionIsValid(providerId, current))) {
      await this.assertPackagedFallback(providerId);
      await this.replacePointer(providerId, 'current', descriptor.packagedExecutablePath);
      current = await this.readPointer(providerId, 'current');
    }
    if (!current) fail('FILESYSTEM_ERROR', 'Could not create the provider fallback pointer');

    let previous = await this.readPointer(providerId, 'previous');
    if (
      !previous ||
      !(await this.pointerVersionIsValid(providerId, previous)) ||
      previous.version === current.version
    ) {
      await this.fileSystem.rm(this.pointerPath(providerId, 'previous'));
      previous = undefined;
    }
    const state: ProviderClientRuntimeState = {
      providerId,
      executablePath: this.pointerPath(providerId, 'current'),
      packagedVersion: descriptor.packagedVersion,
      activeVersion: current.version,
      activeSource: current.source,
      previousVersion: previous?.version ?? null,
    };
    await this.pruneRuntimeVersions(providerId, state);
    this.initialized.add(providerId);
  }

  private async ensureInitialized(providerId: ProviderClientId): Promise<void> {
    if (!this.initialized.has(providerId)) await this.initializeProvider(providerId);
  }

  private async assertPackagedFallback(providerId: ProviderClientId): Promise<void> {
    const descriptor = this.packagedClients[providerId];
    try {
      const info = await this.fileSystem.lstat(descriptor.packagedExecutablePath);
      if (info.kind !== 'file') throw new Error('not a regular file');
      await this.assertExecutableVersion(
        providerId,
        descriptor.packagedExecutablePath,
        descriptor.packagedVersion,
      );
    } catch {
      fail('PACKAGED_RUNTIME_INVALID', `Packaged ${providerId} fallback runtime failed validation`);
    }
  }

  private async removeAbandonedStaging(providerId: ProviderClientId): Promise<void> {
    const { providerRoot } = this.providerPaths(providerId);
    const entries = await this.fileSystem.readdir(providerRoot);
    for (const entry of entries) {
      if (entry.startsWith('.staging-')) await this.fileSystem.rm(path.join(providerRoot, entry));
    }
  }

  private async readPointer(
    providerId: ProviderClientId,
    pointer: 'current' | 'previous',
  ): Promise<RuntimePointer | undefined> {
    const pathname = this.pointerPath(providerId, pointer);
    let info: RuntimePathInfo;
    try {
      info = await this.fileSystem.lstat(pathname);
    } catch (error) {
      if (isMissing(error)) return undefined;
      return undefined;
    }
    if (info.kind !== 'symlink') return undefined;

    let target: string;
    try {
      target = await this.fileSystem.readlink(pathname);
    } catch {
      return undefined;
    }
    const descriptor = this.packagedClients[providerId];
    if (target === descriptor.packagedExecutablePath) {
      return {
        version: descriptor.packagedVersion,
        source: 'packaged',
        executablePath: descriptor.packagedExecutablePath,
      };
    }

    if (path.isAbsolute(target)) return undefined;
    const segments = target.split(path.sep);
    const version = segments[1];
    if (
      segments[0] !== 'versions' ||
      !version ||
      !parseStableVersion(version) ||
      segments.slice(2).join(path.sep) !== descriptor.archiveExecutablePath
    ) {
      return undefined;
    }
    const executablePath = path.join(
      this.providerPaths(providerId).versionsRoot,
      version,
      descriptor.archiveExecutablePath,
    );
    if (!(await this.isContainedRegularExecutable(providerId, version, executablePath)))
      return undefined;
    return { version, source: 'runtime', executablePath };
  }

  private runtimeLinkTarget(providerId: ProviderClientId, version: string): string {
    return path.join('versions', version, this.packagedClients[providerId].archiveExecutablePath);
  }

  private pointerTarget(providerId: ProviderClientId, pointer: RuntimePointer): string {
    return pointer.source === 'packaged'
      ? pointer.executablePath
      : this.runtimeLinkTarget(providerId, pointer.version);
  }

  private async isContainedRegularExecutable(
    providerId: ProviderClientId,
    version: string,
    executablePath: string,
  ): Promise<boolean> {
    if (!parseStableVersion(version)) return false;
    const { versionsRoot } = this.providerPaths(providerId);
    let current = versionsRoot;
    const segments = [
      version,
      ...this.packagedClients[providerId].archiveExecutablePath.split(path.sep),
    ];
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!);
      try {
        const info = await this.fileSystem.lstat(current);
        const isFinal = index === segments.length - 1;
        if (isFinal ? info.kind !== 'file' : info.kind !== 'directory') return false;
      } catch {
        return false;
      }
    }
    return path.resolve(current) === path.resolve(executablePath);
  }

  private async pointerVersionIsValid(
    providerId: ProviderClientId,
    pointer: { version: string; source: 'packaged' | 'runtime'; executablePath: string },
  ): Promise<boolean> {
    const expectedVersion =
      pointer.source === 'packaged'
        ? this.packagedClients[providerId].packagedVersion
        : pointer.version;
    try {
      await this.assertExecutableVersion(providerId, pointer.executablePath, expectedVersion);
      return true;
    } catch {
      return false;
    }
  }

  private async readStateAndRecover(
    providerId: ProviderClientId,
  ): Promise<ProviderClientRuntimeState> {
    const descriptor = this.packagedClients[providerId];
    let current = await this.readPointer(providerId, 'current');
    if (!current || !(await this.pointerVersionIsValid(providerId, current))) {
      await this.assertPackagedFallback(providerId);
      await this.replacePointer(providerId, 'current', descriptor.packagedExecutablePath);
      current = await this.readPointer(providerId, 'current');
    }
    if (!current) fail('FILESYSTEM_ERROR', 'Could not recover the packaged provider fallback');

    let previous = await this.readPointer(providerId, 'previous');
    if (
      !previous ||
      previous.version === current.version ||
      !(await this.pointerVersionIsValid(providerId, previous))
    ) {
      await this.fileSystem.rm(this.pointerPath(providerId, 'previous'));
      previous = undefined;
    }
    const state = {
      providerId,
      executablePath: this.pointerPath(providerId, 'current'),
      packagedVersion: descriptor.packagedVersion,
      activeVersion: current.version,
      activeSource: current.source,
      previousVersion: previous?.version ?? null,
    };
    await this.pruneRuntimeVersions(providerId, state);
    return state;
  }

  private async assertExecutableVersion(
    providerId: ProviderClientId,
    executablePath: string,
    expectedVersion: string,
  ): Promise<void> {
    let result: RuntimeProcessResult;
    try {
      result = await this.runProcess(executablePath, ['--version'], {
        timeoutMs: this.limits.versionTimeoutMs,
        maxOutputBytes: this.limits.processOutputBytes,
      });
    } catch {
      fail('PROCESS_FAILED', 'Provider version check failed');
    }
    if (result.exitCode !== 0) fail('PROCESS_FAILED', 'Provider version check failed');
    const actualVersion = parseVersionOutput(providerId, result.stdout);
    if (!actualVersion || actualVersion !== expectedVersion) {
      fail('CANDIDATE_VERSION_MISMATCH', 'Provider executable version did not match its release');
    }
  }

  private async replacePointer(
    providerId: ProviderClientId,
    pointer: 'current' | 'previous',
    target: string,
  ): Promise<void> {
    const providerRoot = this.providerPaths(providerId).providerRoot;
    const pointerPath = this.pointerPath(providerId, pointer);
    const temporaryPath = path.join(providerRoot, `.staging-pointer-${randomUUID()}`);
    await this.fileSystem.symlink(target, temporaryPath);
    try {
      try {
        await this.fileSystem.rename(temporaryPath, pointerPath);
      } catch (error) {
        let currentInfo: RuntimePathInfo | undefined;
        try {
          currentInfo = await this.fileSystem.lstat(pointerPath);
        } catch {
          currentInfo = undefined;
        }
        if (!currentInfo || currentInfo.kind !== 'directory') throw error;
        // `current` and `previous` are reserved names inside the private runtime volume.
        await this.fileSystem.rm(pointerPath);
        await this.fileSystem.rename(temporaryPath, pointerPath);
      }
    } finally {
      await this.fileSystem.rm(temporaryPath);
    }
  }

  private async pruneRuntimeVersions(
    providerId: ProviderClientId,
    state: ProviderClientRuntimeState,
  ): Promise<void> {
    const versionsRoot = this.providerPaths(providerId).versionsRoot;
    const keep = new Set<string>();
    if (state.activeSource === 'runtime') keep.add(state.activeVersion);
    if (state.previousVersion) keep.add(state.previousVersion);
    for (const entry of await this.fileSystem.readdir(versionsRoot)) {
      if (!keep.has(entry)) await this.fileSystem.rm(path.join(versionsRoot, entry));
    }
  }
}
