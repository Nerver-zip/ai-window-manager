import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../src/storage/database.js';
import {
  createRepositories,
  type ProviderRecord,
  type StorageRepositories,
  withTransaction,
} from '../../src/storage/repositories.js';
import { processUsageAggregationBatch, readUsagePageData } from '../../src/usage/service.js';
import type { WindowSnapshot } from '../../src/domain/types.js';
import { chartContinuityGapMs } from '../../src/usage/chart-continuity.js';
import { USAGE_CHART_BUCKETS } from '../../src/usage/service.js';

const dirs: string[] = [];
const openDbs: SqliteDatabase[] = [];
const now = Date.parse('2026-09-23T12:00:00.000Z');

afterEach(() => {
  for (const db of openDbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function database(): {
  dir: string;
  file: string;
  db: SqliteDatabase;
  repositories: StorageRepositories;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-usage-'));
  dirs.push(dir);
  const file = path.join(dir, 'usage.db');
  const db = openDatabase(file);
  openDbs.push(db);
  const repositories = createRepositories(db);
  repositories.providers.upsert(provider());
  return { dir, file, db, repositories };
}

function provider(): ProviderRecord {
  return {
    id: 'codex',
    kind: 'codex',
    enabled: true,
    mode: 'monitor_only',
    pollIntervalSeconds: 30,
    config: {},
    configVersion: 1,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function weeklySample(atMs: number, ratio: number): WindowSnapshot {
  const observedAt = new Date(atMs).toISOString();
  const resetAt = new Date(atMs + 3 * 24 * 60 * 60 * 1000).toISOString();
  return {
    providerId: 'codex',
    windowKind: 'weekly',
    observedAt,
    phase: { value: 'ACTIVE', source: 'observed', confidence: 'exact', observedAt },
    durationSeconds: {
      value: 7 * 24 * 60 * 60,
      source: 'official_supported',
      confidence: 'exact',
      observedAt,
    },
    resetAt: { value: resetAt, source: 'official_supported', confidence: 'exact', observedAt },
    usageRatio: { value: ratio, source: 'official_supported', confidence: 'exact', observedAt },
  };
}

function fiveHourSample(atMs: number, ratio: number): WindowSnapshot {
  const sample = weeklySample(atMs, ratio);
  return {
    ...sample,
    windowKind: 'five_hour',
    resetAt: {
      value: new Date(atMs + 5 * 60 * 60 * 1000).toISOString(),
      source: 'official_supported',
      confidence: 'exact',
      observedAt: sample.observedAt,
    },
    durationSeconds: {
      value: 5 * 60 * 60,
      source: 'official_supported',
      confidence: 'exact',
      observedAt: sample.observedAt,
    },
  };
}

function unknownUsageSample(atMs: number): WindowSnapshot {
  const { usageRatio: _omitted, ...snapshot } = weeklySample(atMs, 0);
  void _omitted;
  return snapshot;
}

describe('usage aggregation persistence', () => {
  it('processes backfill in bounded batches and resumes idempotently after reopening SQLite', () => {
    const first = database();
    const base = now - 30 * 60_000;
    first.repositories.windowSamples.insert(weeklySample(base, 0.2));
    first.repositories.windowSamples.insert(weeklySample(base + 5 * 60_000, 0.25));
    first.repositories.windowSamples.insert(weeklySample(base + 10 * 60_000, 0.31));

    expect(processUsageAggregationBatch(first.db, first.repositories, now, 2)).toMatchObject({
      processed: 2,
      pending: true,
    });
    first.db.close();

    const reopenedDb = openDatabase(first.file);
    openDbs.push(reopenedDb);
    const reopenedRepositories = createRepositories(reopenedDb);
    expect(processUsageAggregationBatch(reopenedDb, reopenedRepositories, now, 2)).toMatchObject({
      processed: 1,
      pending: false,
    });
    const aggregate = reopenedDb
      .prepare('SELECT SUM(usage_delta_ratio) AS total, COUNT(*) AS n FROM usage_intervals')
      .get() as { total: number; n: number };
    expect(aggregate.total).toBeCloseTo(0.11);
    expect(aggregate.n).toBe(2);
    expect(processUsageAggregationBatch(reopenedDb, reopenedRepositories, now)).toMatchObject({
      processed: 0,
      pending: false,
    });
    expect(
      (
        reopenedDb.prepare('SELECT last_sample_id FROM usage_aggregation_checkpoint').get() as {
          last_sample_id: number;
        }
      ).last_sample_id,
    ).toBe(3);
  });

  it('coalesces adjacent unchanged observations without losing their covered time', () => {
    const { db, repositories } = database();
    const start = now - 30 * 60_000;
    [0.2, 0.2, 0.2, 0.21].forEach((usage, index) =>
      repositories.windowSamples.insert(weeklySample(start + index * 5 * 60_000, usage)),
    );
    processUsageAggregationBatch(db, repositories, now);
    const intervals = db
      .prepare(
        'SELECT source_sample_id, from_ms, to_ms, usage_delta_ratio FROM usage_intervals ORDER BY from_ms',
      )
      .all() as Array<{
      source_sample_id: number;
      from_ms: number;
      to_ms: number;
      usage_delta_ratio: number | null;
    }>;
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual({
      source_sample_id: 3,
      from_ms: start,
      to_ms: start + 10 * 60_000,
      usage_delta_ratio: 0,
    });
    expect(intervals[1]?.usage_delta_ratio).toBeCloseTo(0.01);
  });

  it('projects persisted intervals in the requested local timezone and leaves the fake provider filterable', () => {
    const { db, repositories } = database();
    const base = Date.parse('2026-09-21T12:00:00.000Z');
    repositories.windowSamples.insert(weeklySample(base, 0.2));
    repositories.windowSamples.insert(weeklySample(base + 5 * 60_000, 0.25));
    processUsageAggregationBatch(db, repositories, now);
    const data = readUsagePageData({
      repositories,
      now: new Date(now),
      timezone: 'America/Sao_Paulo',
      providerId: 'codex',
      windowKind: 'weekly',
      localDay: '2026-09-21',
      visibleProviderIds: new Set(['codex']),
    });
    expect(data.timezone).toBe('America/Sao_Paulo');
    expect(data.selectedProviderId).toBe('codex');
    expect(data.selectedWindowKind).toBe('weekly');
    expect(data.selectedDay?.usagePercentagePoints).toBeCloseTo(5);
    expect(data.days).toHaveLength(365);
    expect(data.providers.map((item) => item.id)).toEqual(['codex']);
  });

  it('recognizes a weekly window at its first baseline without inventing prior daily use', () => {
    const { db, repositories } = database();
    repositories.windowSamples.insert(weeklySample(now - 60_000, 0.69));
    processUsageAggregationBatch(db, repositories, now);
    const data = readUsagePageData({
      repositories,
      now: new Date(now),
      timezone: 'UTC',
      providerId: 'codex',
      visibleProviderIds: new Set(['codex']),
    });
    expect(data.selectedWindowKind).toBe('weekly');
    expect(
      data.days.every((day) => day.status === 'no_data' && day.usagePercentagePoints === null),
    ).toBe(true);
  });

  it('defaults the daily heatmap source to a weekly window when several cadences exist', () => {
    const { db, repositories } = database();
    const base = now - 60_000;
    const fiveHourSampleId = repositories.windowSamples.insert(fiveHourSample(base, 0.1));
    repositories.usageAggregation.insertInterval({
      sourceSampleId: fiveHourSampleId,
      providerId: 'codex',
      windowKind: 'five_hour',
      fromMs: base,
      toMs: base + 5 * 60_000,
      usageDeltaRatio: null,
      quality: 'unknown',
      reasonCode: 'WINDOW_DURATION_CHANGED',
    });
    repositories.windowSamples.insert(weeklySample(base, 0.3));
    repositories.windowSamples.insert(weeklySample(base + 5 * 60_000, 0.32));
    processUsageAggregationBatch(db, repositories, now);

    const data = readUsagePageData({
      repositories,
      now: new Date(now),
      timezone: 'UTC',
      providerId: 'codex',
      visibleProviderIds: new Set(['codex']),
    });

    expect(data.windows.map(({ windowKind }) => windowKind)).toEqual(['five_hour', 'weekly']);
    expect(data.selectedWindowKind).toBe('weekly');
  });

  it('bounds chart query output while retaining temporal endpoints and extrema', () => {
    const { repositories } = database();
    const start = now - 60 * 60_000;
    const values = [0.2, 0.25, 0.3, 0.9, 0.4, 0.35, 0.2, 0.15, 0.2, 0.4, 0.5, 0.6];
    values.forEach((value, index) =>
      repositories.windowSamples.insert(weeklySample(start + index * 5 * 60_000, value)),
    );
    const points = repositories.windowSamples.chartPoints('codex', 'weekly', start, now, 3);
    expect(points.length).toBeLessThanOrEqual(12);
    expect(points[0]?.observedAtMs).toBe(start);
    expect(points.at(-1)?.observedAtMs).toBe(start + 11 * 5 * 60_000);
    expect(points.some((point) => point.usageRatio === 0.9)).toBe(true);
    expect(points.some((point) => point.usageRatio === 0.15)).toBe(true);
  });

  it('keeps an explicit break after a long outage even inside one downsample bucket', () => {
    const { repositories } = database();
    const start = now - 2 * 60 * 60_000;
    [0, 60_000, 40 * 60_000, 41 * 60_000].forEach((offset, index) =>
      repositories.windowSamples.insert(weeklySample(start + offset, 0.2 + index * 0.01)),
    );

    const points = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start,
      start + 50 * 60_000,
      1,
      10 * 60_000,
    );
    expect(points).toHaveLength(4);
    expect(points.filter((point) => point.gapBefore).map((point) => point.observedAtMs)).toEqual([
      start + 40 * 60_000,
    ]);
  });

  it('does not draw a line across repeated outages within a single bucket', () => {
    const { repositories } = database();
    const start = now - 2 * 60 * 60_000;
    [0, 60_000, 40 * 60_000, 41 * 60_000, 80 * 60_000, 81 * 60_000].forEach((offset, index) =>
      repositories.windowSamples.insert(weeklySample(start + offset, 0.2 + index * 0.01)),
    );

    const points = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start,
      start + 90 * 60_000,
      1,
      10 * 60_000,
    );
    const breaks = points.filter((point) => point.gapBefore).map((point) => point.observedAtMs);
    expect(breaks).toEqual([start + 40 * 60_000, start + 80 * 60_000]);
    expect(points.some((point) => point.observedAtMs === start + 41 * 60_000)).toBe(true);
  });

  it('keeps normal jitter within the polling-aware grace period connected', () => {
    const { repositories } = database();
    const start = now - 60 * 60_000;
    [0, 30_000, 90_000, 120_000].forEach((offset) =>
      repositories.windowSamples.insert(weeklySample(start + offset, 0.6)),
    );

    const points = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start,
      start + 121_000,
      1,
      120_000,
    );
    expect(points.map((point) => point.gapBefore)).toEqual(Array(points.length).fill(false));
    expect(points[0]?.observedAtMs).toBe(start);
    expect(points.at(-1)?.observedAtMs).toBe(start + 120_000);
  });

  it.each([
    [-1, false],
    [0, false],
    [1, true],
  ])('classifies two readings at G %+i ms', (offset, breaks) => {
    const { repositories } = database();
    const start = now - 60 * 60_000;
    const gap = chartContinuityGapMs(30, 30);
    repositories.windowSamples.insert(weeklySample(start, 0.6));
    repositories.windowSamples.insert(weeklySample(start + gap + offset, 0.7));
    const points = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start,
      start + gap + 2,
      1,
      gap,
    );
    expect(points).toHaveLength(2);
    expect(points[1]?.gapBefore).toBe(breaks);
  });

  it('uses the exact continuity boundary between valid readings across missing samples', () => {
    const { repositories } = database();
    const start = now - 60 * 60_000;
    const gap = chartContinuityGapMs(30, 30);
    repositories.windowSamples.insert(weeklySample(start, 0.6));
    repositories.windowSamples.insert(unknownUsageSample(start + 30_000));
    repositories.windowSamples.insert(weeklySample(start + gap - 1, 0.61));
    repositories.windowSamples.insert(weeklySample(start + gap, 0.62));
    repositories.windowSamples.insert(weeklySample(start + 2 * gap + 1, 0.63));

    const points = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start,
      start + 3 * gap,
      4,
      gap,
    );
    expect(points.map((point) => point.observedAtMs)).toEqual([
      start,
      start + gap - 1,
      start + gap,
      start + 2 * gap + 1,
    ]);
    expect(points.filter((point) => point.gapBefore).map((point) => point.observedAtMs)).toEqual([
      start + 2 * gap + 1,
    ]);
  });

  it('treats long missing clusters as unknown and keeps the last raw remaining value', () => {
    const { repositories } = database();
    const start = now - 60 * 60_000;
    repositories.windowSamples.insert(weeklySample(start, 0.6));
    repositories.windowSamples.insert(unknownUsageSample(start + 60_000));
    repositories.windowSamples.insert(weeklySample(start + 121_000, 0.7));
    repositories.windowSamples.insert({
      ...unknownUsageSample(start + 150_000),
      remainingRatio: {
        value: 0.3,
        source: 'official_supported',
        confidence: 'exact',
        observedAt: new Date(start + 150_000).toISOString(),
      },
    });
    const points = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start,
      start + 151_000,
      1,
      120_000,
    );
    expect(points.map((point) => point.usageRatio)).toEqual([0.6, 0.7, null]);
    expect(points[1]?.gapBefore).toBe(true);
    expect(points[2]?.remainingRatio).toBe(0.3);
  });

  it('uses the last sample at a duplicate timestamp and keeps all-null input explicit', () => {
    const { repositories } = database();
    const start = now - 60 * 60_000;
    repositories.windowSamples.insert(weeklySample(start, 0.8));
    repositories.windowSamples.insert(weeklySample(start, 0.3));
    repositories.windowSamples.insert(unknownUsageSample(start + 30_000));
    const points = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start,
      start + 31_000,
      1,
      120_000,
    );
    expect(points.map((point) => point.usageRatio)).toEqual([0.3, null]);
    const unknown = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start + 1,
      start + 31_000,
      1,
      120_000,
    );
    expect(unknown.map((point) => point.usageRatio)).toEqual([null]);
  });

  it('bounds a dense selected month while retaining both time ends and reset boundaries', () => {
    const { db, repositories } = database();
    const start = now - 30 * 24 * 60 * 60_000;
    const count = 2_000;
    const insert = db.prepare(
      `INSERT INTO window_samples (
        provider_id, window_kind, observed_at_ms, phase, usage_ratio
      ) VALUES ('codex', 'weekly', ?, 'ACTIVE', ?)`,
    );
    withTransaction(db, () => {
      for (let index = 0; index < count; index += 1) {
        const ratio = index < 1_000 ? index / 1_000 : (index - 1_000) / 1_000;
        insert.run(start + index * 60_000, ratio);
      }
    });
    const points = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start,
      now + 1,
      USAGE_CHART_BUCKETS,
      120_000,
    );
    expect(points.length).toBeLessThanOrEqual(384);
    expect(points[0]?.observedAtMs).toBe(start);
    expect(points.at(-1)?.observedAtMs).toBe(start + (count - 1) * 60_000);
    expect(points.some((point) => point.smoothingBreakBefore)).toBe(true);
    expect(points.every((point) => !point.gapBefore)).toBe(true);
  });

  it('keeps endpoints and conservative breaks when outages exceed the point budget', () => {
    const { repositories } = database();
    const start = now - 30 * 24 * 60 * 60_000;
    const count = 800;
    for (let index = 0; index < count; index += 1) {
      repositories.windowSamples.insert(weeklySample(start + index * 30 * 60_000, 0.6));
    }
    const points = repositories.windowSamples.chartPoints(
      'codex',
      'weekly',
      start,
      now + 1,
      USAGE_CHART_BUCKETS,
      120_000,
    );
    expect(points.length).toBeLessThanOrEqual(384);
    expect(points[0]?.observedAtMs).toBe(start);
    expect(points.at(-1)?.observedAtMs).toBe(start + (count - 1) * 30 * 60_000);
    expect(points.slice(1).every((point) => point.gapBefore)).toBe(true);
  });
});
