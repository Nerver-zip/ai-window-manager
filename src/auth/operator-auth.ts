import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyOperatorPassword } from './operator-password.js';
import type { Clock } from '../scheduler/clock.js';

export const OPERATOR_SESSION_COOKIE_NAME = 'awm_session';
export const OPERATOR_SESSION_TOKEN_BYTES = 32;
export const OPERATOR_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SESSIONS = 16;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const MAX_GLOBAL_FAILED_LOGINS = 60;
const MAX_LOGIN_SOURCES = 256;
const MAX_CONCURRENT_PASSWORD_CHECKS = 2;
const MAX_PASSWORD_BYTES = 1024;
const OPERATOR_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

export interface OperatorSession {
  token: string;
  expiresAtMs: number;
}

interface StoredSession {
  createdAtMs: number;
  expiresAtMs: number;
}

export class OperatorSessionStore {
  private readonly sessionsByDigest = new Map<string, StoredSession>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number,
    private readonly randomSource: (size: number) => Buffer = randomBytes,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('Invalid operator session lifetime');
    }
  }

  create(): OperatorSession {
    const now = this.clock.now().getTime();
    this.removeExpired(now);
    if (this.sessionsByDigest.size >= MAX_SESSIONS) {
      const oldest = [...this.sessionsByDigest.entries()].sort(
        (left, right) => left[1].createdAtMs - right[1].createdAtMs,
      )[0];
      if (oldest) this.sessionsByDigest.delete(oldest[0]);
    }

    const token = this.randomSource(OPERATOR_SESSION_TOKEN_BYTES).toString('base64url');
    if (!SESSION_TOKEN_PATTERN.test(token)) throw new Error('Invalid session token source');
    const expiresAtMs = now + this.ttlMs;
    this.sessionsByDigest.set(digestToken(token), { createdAtMs: now, expiresAtMs });
    return { token, expiresAtMs };
  }

  has(token: string | null | undefined): boolean {
    if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) return false;
    const digest = digestToken(token);
    const session = this.sessionsByDigest.get(digest);
    if (!session) return false;
    if (session.expiresAtMs <= this.clock.now().getTime()) {
      this.sessionsByDigest.delete(digest);
      return false;
    }
    return true;
  }

  destroy(token: string | null | undefined): boolean {
    if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) return false;
    return this.sessionsByDigest.delete(digestToken(token));
  }

  clear(): void {
    this.sessionsByDigest.clear();
  }

  private removeExpired(now: number): void {
    for (const [digest, session] of this.sessionsByDigest) {
      if (session.expiresAtMs <= now) this.sessionsByDigest.delete(digest);
    }
  }
}

export interface OperatorAuthInput {
  username: string;
  passwordHash: string;
  sessionTtlMs: number;
  clock: Clock;
  verifyPassword?: (password: string, passwordHash: string) => Promise<boolean>;
}

export type OperatorLoginResult =
  | { status: 'authenticated'; session: OperatorSession }
  | { status: 'invalid_credentials' }
  | { status: 'too_many_attempts'; retryAfterSeconds: number };

interface FailureBucket {
  failuresMs: number[];
  lastSeenMs: number;
}

/** Single-operator local authentication; session tokens are never persisted. */
export class OperatorAuthService {
  readonly sessions: OperatorSessionStore;
  private readonly failureBuckets = new Map<string, FailureBucket>();
  private readonly globalFailuresMs: number[] = [];
  private readonly verifyingBySource = new Set<string>();
  private concurrentChecks = 0;
  private readonly verifyPassword: (password: string, passwordHash: string) => Promise<boolean>;

  constructor(private readonly input: OperatorAuthInput) {
    this.sessions = new OperatorSessionStore(input.clock, input.sessionTtlMs);
    this.verifyPassword = input.verifyPassword ?? verifyOperatorPassword;
  }

  async login(username: unknown, password: unknown, source: string): Promise<OperatorLoginResult> {
    const now = this.input.clock.now().getTime();
    const sourceKey = normalizeSource(source);
    const blockedFor = Math.max(
      this.blockedSeconds(sourceKey, now),
      this.globalBlockedSeconds(now),
    );
    if (blockedFor > 0) return { status: 'too_many_attempts', retryAfterSeconds: blockedFor };
    if (
      this.concurrentChecks >= MAX_CONCURRENT_PASSWORD_CHECKS ||
      this.verifyingBySource.has(sourceKey)
    ) {
      return { status: 'too_many_attempts', retryAfterSeconds: 2 };
    }

    const usernameValid =
      typeof username === 'string' &&
      username.length > 0 &&
      Buffer.byteLength(username, 'utf8') <= 64 &&
      OPERATOR_USERNAME_PATTERN.test(username);
    const passwordValid =
      typeof password === 'string' &&
      password.length > 0 &&
      Buffer.byteLength(password, 'utf8') <= MAX_PASSWORD_BYTES;
    const boundedUsername = usernameValid ? username : '';
    const boundedPassword = passwordValid ? password : '';

    this.concurrentChecks += 1;
    this.verifyingBySource.add(sourceKey);
    try {
      let passwordMatches = false;
      if (usernameValid && passwordValid) {
        try {
          passwordMatches = await this.verifyPassword(boundedPassword, this.input.passwordHash);
        } catch {
          // An invalid credential/hash failure is intentionally indistinguishable at the route.
        }
      }
      const usernameMatches = fixedTimeStringEqual(boundedUsername, this.input.username);
      if (usernameValid && passwordValid && usernameMatches && passwordMatches) {
        this.failureBuckets.delete(sourceKey);
        return { status: 'authenticated', session: this.sessions.create() };
      }

      this.recordFailure(sourceKey, this.input.clock.now().getTime());
      return { status: 'invalid_credentials' };
    } finally {
      this.concurrentChecks -= 1;
      this.verifyingBySource.delete(sourceKey);
    }
  }

  clearSessions(): void {
    this.sessions.clear();
  }

  private blockedSeconds(source: string, now: number): number {
    const bucket = this.failureBuckets.get(source);
    if (!bucket) return 0;
    bucket.failuresMs = bucket.failuresMs.filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
    bucket.lastSeenMs = now;
    if (bucket.failuresMs.length < MAX_FAILED_LOGINS) return 0;
    return Math.max(1, Math.ceil((bucket.failuresMs[0]! + LOGIN_WINDOW_MS - now) / 1000));
  }

  private globalBlockedSeconds(now: number): number {
    this.pruneGlobalFailures(now);
    if (this.globalFailuresMs.length < MAX_GLOBAL_FAILED_LOGINS) return 0;
    return Math.max(1, Math.ceil((this.globalFailuresMs[0]! + LOGIN_WINDOW_MS - now) / 1000));
  }

  private recordFailure(source: string, now: number): void {
    this.pruneBuckets(now);
    this.pruneGlobalFailures(now);
    this.globalFailuresMs.push(now);
    let bucket = this.failureBuckets.get(source);
    if (!bucket) {
      if (this.failureBuckets.size >= MAX_LOGIN_SOURCES) {
        const oldest = [...this.failureBuckets.entries()].sort(
          (left, right) => left[1].lastSeenMs - right[1].lastSeenMs,
        )[0];
        if (oldest) this.failureBuckets.delete(oldest[0]);
      }
      bucket = { failuresMs: [], lastSeenMs: now };
      this.failureBuckets.set(source, bucket);
    }
    bucket.failuresMs.push(now);
    bucket.lastSeenMs = now;
  }

  private pruneBuckets(now: number): void {
    for (const [source, bucket] of this.failureBuckets) {
      bucket.failuresMs = bucket.failuresMs.filter(
        (timestamp) => now - timestamp < LOGIN_WINDOW_MS,
      );
      if (bucket.failuresMs.length === 0) this.failureBuckets.delete(source);
    }
  }

  private pruneGlobalFailures(now: number): void {
    let expiredCount = 0;
    while (
      expiredCount < this.globalFailuresMs.length &&
      now - this.globalFailuresMs[expiredCount]! >= LOGIN_WINDOW_MS
    ) {
      expiredCount += 1;
    }
    if (expiredCount > 0) this.globalFailuresMs.splice(0, expiredCount);
  }
}

function normalizeSource(source: string): string {
  if (typeof source !== 'string' || source.length === 0) return 'unknown';
  return source.slice(0, 128);
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function fixedTimeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
