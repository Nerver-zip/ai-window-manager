import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('retiring the Antigravity Argon quota migration', () => {
  it('preserves active families and history while terminalizing obsolete intents exactly once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-retire-argon-'));
    dirs.push(dir);
    const previousMigrations = path.join(dir, 'v15');
    fs.mkdirSync(previousMigrations);
    for (const name of fs
      .readdirSync('migrations')
      .filter((name) => Number(name.slice(0, 3)) <= 15)) {
      fs.copyFileSync(path.join('migrations', name), path.join(previousMigrations, name));
    }

    const file = path.join(dir, 'awm.db');
    const previous = openDatabase(file, { migrationsDir: previousMigrations, now: () => 100 });
    previous.exec(`
      INSERT INTO providers (id, kind, enabled, mode, poll_interval_seconds, config_json, config_version, created_at_ms, updated_at_ms)
      VALUES ('antigravity', 'antigravity', 1, 'automation', 30, '{}', 1, 1, 1);
      INSERT INTO schedule_policies (
        id, provider_id, scope, requires_review, kind, kind_explicit, enabled,
        timezone, config_json, created_at_ms, updated_at_ms
      ) VALUES
        ('activation-antigravity-gemini', 'antigravity', 'gemini', 0, 'manual', 1, 1, 'UTC', '{"windowKind":"antigravity_gemini_weekly"}', 1, 1),
        ('activation-antigravity-claude-gpt', 'antigravity', 'claude_gpt', 0, 'auto', 1, 0, 'America/Sao_Paulo', '{"windowKind":"antigravity_claude_gpt_weekly"}', 2, 2),
        ('retired-argon-enabled', 'antigravity', 'argon', 0, 'auto', 1, 1, 'UTC', '{"windowKind":"antigravity_argon_weekly"}', 3, 3),
        ('retired-argon-disabled', 'antigravity', 'argon', 1, 'manual', 0, 0, 'UTC', '{}', 4, 4);
      INSERT INTO settings (key, value_json, updated_at_ms)
      VALUES ('operator-preference', '{"enabled":false}', 5);
    `);

    const addIntent = (
      id: string,
      state: string,
      policyId: string | null,
      windowKind: string,
      attemptCount: number,
      startedAtMs: number | null = null,
      finishedAtMs: number | null = null,
    ) =>
      previous
        .prepare(
          `INSERT INTO action_intents (
            id, provider_id, policy_id, action_type, dedupe_key, state, scheduled_for_ms,
            attempt_count, reason_code, explanation_json, started_at_ms, finished_at_ms,
            created_at_ms, updated_at_ms
          ) VALUES (?, 'antigravity', ?, 'trigger_window', ?, ?, 10, ?, 'SYNTHETIC_TEST', ?, ?, ?, 10, 10)`,
        )
        .run(
          id,
          policyId,
          `dedupe-${id}`,
          state,
          attemptCount,
          JSON.stringify({ windowKind }),
          startedAtMs,
          finishedAtMs,
        );

    addIntent('unsent', 'planned', 'retired-argon-enabled', 'antigravity_argon_weekly', 0);
    addIntent('retried', 'planned', null, 'antigravity_argon_weekly', 1, 11);
    addIntent(
      'failed',
      'failed_retryable',
      'retired-argon-disabled',
      'antigravity_argon_weekly',
      2,
      12,
    );
    addIntent('executing', 'executing', null, 'antigravity_argon_weekly', 1, 13);
    addIntent(
      'succeeded',
      'succeeded',
      'retired-argon-enabled',
      'antigravity_argon_weekly',
      1,
      14,
      15,
    );
    addIntent('uncertain', 'uncertain', 'retired-argon-enabled', 'antigravity_argon_weekly', 1, 16);
    addIntent(
      'confirmed',
      'confirmed',
      'retired-argon-enabled',
      'antigravity_argon_weekly',
      1,
      17,
      18,
    );
    addIntent(
      'gemini-pending',
      'planned',
      'activation-antigravity-gemini',
      'antigravity_gemini_weekly',
      0,
    );

    previous.exec(`
      INSERT INTO action_resolution_requests (intent_id, generation, state, reason_code, requested_at_ms, checked_at_ms)
      VALUES ('uncertain', 2, 'checked', 'SYNTHETIC_RESOLUTION', 20, 21);
      INSERT INTO observed_cycle_closures (intent_id, provider_id, window_kind, cycle_at_ms, ended_at_ms, observed_at_ms, evidence_kind)
      VALUES ('uncertain', 'antigravity', 'antigravity_argon_weekly', 20, 21, 22, 'anchored_boundary');
      INSERT INTO events (provider_id, type, severity, reason_code, occurred_at_ms, data_json)
      VALUES ('antigravity', 'provider_inspected', 'info', 'SYNTHETIC_HISTORY', 23, '{"retained":true}');
      INSERT INTO provider_cleanup_jobs (
        id, provider_id, artifact_kind, external_id, state, not_before_ms, created_at_ms, updated_at_ms
      ) VALUES ('cleanup-argon', 'antigravity', 'antigravity_conversation', 'synthetic-conversation-id', 'pending', 24, 24, 24);
    `);
    const validWindow = (windowKind: string) => ({
      providerId: 'antigravity',
      windowKind,
      observedAt: '2026-11-24T00:00:00.000Z',
      phase: {
        value: 'ACTIVE',
        source: 'inferred',
        confidence: 'high',
        observedAt: '2026-11-24T00:00:00.000Z',
      },
    });
    previous
      .prepare(
        `INSERT INTO provider_state (
          provider_id, health, observed_at_ms, stale_after_ms, observation_json,
          last_success_at_ms, last_error_code, updated_at_ms
        ) VALUES ('antigravity', 'UP', 25, 30025, ?, 25, NULL, 25)`,
      )
      .run(
        JSON.stringify({
          providerId: 'antigravity',
          health: 'UP',
          observedAt: '2026-11-24T00:00:00.000Z',
          staleAfterSeconds: 300,
          windows: [
            validWindow('antigravity_gemini_weekly'),
            validWindow('antigravity_claude_gpt_weekly'),
            validWindow('antigravity_argon_weekly'),
          ],
        }),
      );
    const historySample = previous
      .prepare(
        `INSERT INTO window_samples (
          provider_id, window_kind, observed_at_ms, phase, phase_source, phase_confidence,
          phase_observed_at_ms, usage_ratio, usage_source, usage_confidence, usage_observed_at_ms
        ) VALUES ('antigravity', 'antigravity_argon_weekly', 26, 'ACTIVE', 'observed', 'exact', 26, 0.5, 'observed', 'exact', 26)`,
      )
      .run();
    previous
      .prepare(
        `INSERT INTO usage_intervals (
          source_sample_id, provider_id, window_kind, from_ms, to_ms, usage_delta_ratio, quality, reason_code
        ) VALUES (?, 'antigravity', 'antigravity_argon_weekly', 25, 26, 0.5, 'observed', NULL)`,
      )
      .run(Number(historySample.lastInsertRowid));
    previous
      .prepare(
        'INSERT INTO usage_series_state(provider_id, window_kind, state_json, updated_at_ms) VALUES (?, ?, ?, ?)',
      )
      .run('antigravity', 'antigravity_argon_weekly', '{"usageRatio":0.5}', 27);

    const originalHistoryEvent = previous
      .prepare(
        "SELECT type, reason_code, data_json FROM events WHERE reason_code = 'SYNTHETIC_HISTORY'",
      )
      .get();
    previous.close();

    const upgraded = openDatabase(file);
    const policyRows = upgraded
      .prepare('SELECT id, scope, enabled, kind, config_json FROM schedule_policies ORDER BY id')
      .all();
    expect(policyRows).toEqual([
      {
        id: 'activation-antigravity-claude-gpt',
        scope: 'claude_gpt',
        enabled: 0,
        kind: 'auto',
        config_json: '{"windowKind":"antigravity_claude_gpt_weekly"}',
      },
      {
        id: 'activation-antigravity-gemini',
        scope: 'gemini',
        enabled: 1,
        kind: 'manual',
        config_json: '{"windowKind":"antigravity_gemini_weekly"}',
      },
    ]);
    expect(
      upgraded
        .prepare(
          "SELECT state, policy_id, attempt_count, finished_at_ms FROM action_intents WHERE id = 'unsent'",
        )
        .get(),
    ).toMatchObject({ state: 'skipped', policy_id: null, attempt_count: 0 });
    expect(
      upgraded
        .prepare('SELECT id, state, policy_id, attempt_count FROM action_intents ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'confirmed', state: 'confirmed', policy_id: null, attempt_count: 1 },
      { id: 'executing', state: 'resolved_unknown', policy_id: null, attempt_count: 1 },
      { id: 'failed', state: 'failed_terminal', policy_id: null, attempt_count: 2 },
      {
        id: 'gemini-pending',
        state: 'planned',
        policy_id: 'activation-antigravity-gemini',
        attempt_count: 0,
      },
      { id: 'retried', state: 'resolved_unknown', policy_id: null, attempt_count: 1 },
      { id: 'succeeded', state: 'resolved_unknown', policy_id: null, attempt_count: 1 },
      { id: 'uncertain', state: 'resolved_unknown', policy_id: null, attempt_count: 1 },
      { id: 'unsent', state: 'skipped', policy_id: null, attempt_count: 0 },
    ]);
    expect(
      upgraded
        .prepare(
          "SELECT type, data_json FROM events WHERE type = 'schedule_policy_retired' ORDER BY id",
        )
        .all(),
    ).toHaveLength(2);
    expect(
      upgraded
        .prepare("SELECT type FROM events WHERE reason_code = 'ANTIGRAVITY_ARGON_SCOPE_RETIRED'")
        .all(),
    ).toHaveLength(6);
    expect(
      upgraded
        .prepare(
          "SELECT type, reason_code, data_json FROM events WHERE reason_code = 'SYNTHETIC_HISTORY'",
        )
        .get(),
    ).toEqual(originalHistoryEvent);
    expect(
      upgraded.prepare("SELECT value_json FROM settings WHERE key = 'operator-preference'").get(),
    ).toEqual({ value_json: '{"enabled":false}' });
    expect(
      upgraded
        .prepare("SELECT state, external_id FROM provider_cleanup_jobs WHERE id = 'cleanup-argon'")
        .get(),
    ).toEqual({ state: 'pending', external_id: 'synthetic-conversation-id' });
    expect(
      upgraded
        .prepare('SELECT window_kind, COUNT(*) AS count FROM window_samples GROUP BY window_kind')
        .get(),
    ).toEqual({ window_kind: 'antigravity_argon_weekly', count: 1 });
    expect(
      upgraded
        .prepare('SELECT window_kind, COUNT(*) AS count FROM usage_intervals GROUP BY window_kind')
        .get(),
    ).toEqual({ window_kind: 'antigravity_argon_weekly', count: 1 });
    expect(
      upgraded
        .prepare('SELECT window_kind FROM usage_series_state WHERE provider_id = ?')
        .get('antigravity'),
    ).toEqual({ window_kind: 'antigravity_argon_weekly' });
    const observation = JSON.parse(
      (
        upgraded
          .prepare("SELECT observation_json FROM provider_state WHERE provider_id = 'antigravity'")
          .get() as { observation_json: string }
      ).observation_json,
    ) as { health: string; windows: Array<{ windowKind: string }> };
    expect(observation.health).toBe('UP');
    expect(observation.windows.map((window) => window.windowKind).sort()).toEqual([
      'antigravity_claude_gpt_weekly',
      'antigravity_gemini_weekly',
    ]);
    expect(
      upgraded
        .prepare(
          "SELECT data_json FROM events WHERE type = 'schedule_policy_retired' AND data_json LIKE '%retired-argon-disabled%'",
        )
        .get(),
    ).toBeDefined();
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
    expect(upgraded.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(() =>
      upgraded
        .prepare(
          `INSERT INTO schedule_policies (
            id, provider_id, scope, kind, enabled, timezone, config_json, created_at_ms, updated_at_ms
          ) VALUES ('no-argon', 'antigravity', 'argon', 'manual', 1, 'UTC', '{}', 30, 30)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    upgraded.close();

    const reopened = openDatabase(file);
    expect(
      reopened
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE reason_code = 'ANTIGRAVITY_ARGON_SCOPE_RETIRED'",
        )
        .get(),
    ).toEqual({ count: 6 });
    expect(reopened.pragma('foreign_key_check')).toEqual([]);
    reopened.close();
  });
});
