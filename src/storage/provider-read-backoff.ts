import type { Clock } from '../scheduler/clock.js';
import {
  READ_PURPOSES,
  readBackoffDelay,
  type ReadFailureKind,
  type ReadPurpose,
} from '../providers/read-backoff-policy.js';
import type { SqliteDatabase } from './database.js';

export class ProviderReadDeferredError extends Error {
  readonly code = 'PROVIDER_READ_BACKOFF';
  constructor(readonly retryAtMs: number) {
    super('provider read is deferred');
  }
}

/** Purpose records share the normal read gate; explicit login probes have their own gate. */
export class ProviderReadBackoff {
  private readonly authProbePermits = new Set<string>();
  constructor(
    private readonly input: {
      db: SqliteDatabase;
      clock: Clock;
      random?: () => number;
      pollIntervalMs: (providerId: string) => number;
    },
  ) {}

  nowMs(): number {
    const nowMs = this.input.clock.now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      throw new RangeError('invalid read backoff clock');
    return nowMs;
  }

  retryAtMs(providerId: string, purpose: ReadPurpose): number {
    this.assertPurpose(purpose);
    const auth = purpose.startsWith('auth_');
    const row = this.input.db
      .prepare(
        `SELECT MAX(not_before_ms) AS retryAtMs FROM provider_read_backoff
      WHERE provider_id = ? AND ${auth ? 'purpose = ?' : "purpose NOT IN ('auth_check', 'auth_verify')"}`,
      )
      .get(...(auth ? [providerId, purpose] : [providerId])) as { retryAtMs: number | null };
    return row.retryAtMs ?? 0;
  }

  assertAllowed(providerId: string, purpose: ReadPurpose): void {
    this.nowMs();
    if (purpose.startsWith('auth_') && this.authProbePermits.delete(`${providerId}:${purpose}`))
      return;
    const retryAtMs = this.retryAtMs(providerId, purpose);
    if (this.nowMs() < retryAtMs) throw new ProviderReadDeferredError(retryAtMs);
  }

  failed(
    providerId: string,
    purpose: ReadPurpose,
    kind: ReadFailureKind,
    retryAfterSeconds?: unknown,
  ): void {
    this.assertPurpose(purpose);
    this.input.db.transaction(() => {
      const auth = purpose.startsWith('auth_');
      const previous = this.input.db
        .prepare(
          `SELECT MAX(failure_count) AS failures FROM provider_read_backoff
        WHERE provider_id = ? AND ${auth ? 'purpose = ?' : "purpose NOT IN ('auth_check', 'auth_verify')"}`,
        )
        .get(...(auth ? [providerId, purpose] : [providerId])) as { failures: number | null };
      const failures = Math.min(1_000_000, (previous.failures ?? 0) + 1);
      const nowMs = this.nowMs();
      const delay = readBackoffDelay({
        failures,
        kind,
        pollIntervalMs: this.input.pollIntervalMs(providerId),
        jitter: (this.input.random ?? Math.random)(),
        retryAfterSeconds,
      });
      this.input.db
        .prepare(
          `INSERT INTO provider_read_backoff
        (provider_id, purpose, failure_count, not_before_ms, failure_kind, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider_id, purpose) DO UPDATE SET
        failure_count = excluded.failure_count, not_before_ms = excluded.not_before_ms,
        failure_kind = excluded.failure_kind, updated_at_ms = excluded.updated_at_ms`,
        )
        .run(providerId, purpose, failures, nowMs + delay, kind, nowMs);
    })();
  }

  succeeded(providerId: string): void {
    this.input.db
      .prepare('DELETE FROM provider_read_backoff WHERE provider_id = ?')
      .run(providerId);
    this.revokeAuthenticationProbes(providerId);
  }

  /** One read for a new explicit login phase; failure history is not reset. */
  authorizeAuthenticationProbe(providerId: string, purpose: 'auth_check' | 'auth_verify'): void {
    if (purpose !== 'auth_check' && purpose !== 'auth_verify')
      throw new Error('invalid authentication read purpose');
    if (!this.input.db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId))
      throw new Error('authentication provider is not configured');
    const key = `${providerId}:${purpose}`;
    if (this.authProbePermits.size >= 128 && !this.authProbePermits.has(key))
      throw new Error('authentication probe capacity exceeded');
    this.authProbePermits.add(key);
  }

  revokeAuthenticationProbes(providerId: string): void {
    this.authProbePermits.delete(`${providerId}:auth_check`);
    this.authProbePermits.delete(`${providerId}:auth_verify`);
  }

  private assertPurpose(purpose: ReadPurpose): void {
    if (!READ_PURPOSES.includes(purpose)) throw new Error('invalid provider read purpose');
  }
}
