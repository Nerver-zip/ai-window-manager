import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { openDatabase } from '../dist/src/storage/database.js';
import { createRepositories } from '../dist/src/storage/repositories.js';
import { FakeProvider } from '../dist/src/providers/fake-provider.js';
import { ProviderInspectionCoordinator } from '../dist/src/providers/inspection-coordinator.js';
import { FakeClock } from '../dist/src/scheduler/clock.js';
import { processUsageAggregationBatch, readUsagePageData } from '../dist/src/usage/service.js';

const nowMs = Date.parse('2026-10-02T15:00:00.000Z');
const dayMs = 24 * 60 * 60 * 1_000;
const intervalMs = 15 * 60 * 1_000;
const syntheticFanIn = 8;
const syntheticChildBytes = 8 * 1024 * 1024;
const syntheticChildDelayMs = 100;
const historyDays = 400;
const intervalsPerDay = 96;
const heatmapIterations = 8;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function createSyntheticAdapter(id) {
  const clock = new FakeClock('2026-10-02T15:00:00.000Z');
  const fake = new FakeProvider(clock, { id });
  const metrics = {
    inspections: 0,
    activeChildren: 0,
    maxConcurrentChildren: 0,
    childRssBytes: [],
    childCpuMicros: [],
  };
  const startListeners = [];
  const childProgram = `
    const { getHeapStatistics } = require('node:v8');
    const payload = Buffer.alloc(${syntheticChildBytes}, 0x5a);
    setTimeout(() => {
      const cpu = process.cpuUsage();
      process.stdout.write(JSON.stringify({
        rssBytes: process.memoryUsage().rss,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system
      }));
      void payload;
    }, ${syntheticChildDelayMs});
  `;

  const adapter = {
    id,
    capabilities: () => fake.capabilities(),
    health: (context) => fake.health(context),
    inspect: async (context = {}) => {
      if (context.signal?.aborted) {
        throw Object.assign(new Error('synthetic inspection aborted'), { name: 'AbortError' });
      }
      metrics.inspections += 1;
      metrics.activeChildren += 1;
      metrics.maxConcurrentChildren = Math.max(
        metrics.maxConcurrentChildren,
        metrics.activeChildren,
      );
      startListeners.shift()?.resolve();
      const startedAt = performance.now();
      try {
        const childMetrics = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', childProgram], {
            cwd: os.tmpdir(),
            env: { PATH: process.env.PATH ?? '' },
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          let stdout = '';
          let settled = false;
          const cleanup = () => {
            context.signal?.removeEventListener('abort', abortChild);
          };
          const abortChild = () => child.kill('SIGTERM');
          const fail = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };
          context.signal?.addEventListener('abort', abortChild, { once: true });
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
          });
          child.once('error', fail);
          child.once('close', (code) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (code !== 0) {
              reject(new Error(`synthetic child exited with code ${String(code)}`));
              return;
            }
            try {
              resolve(JSON.parse(stdout));
            } catch {
              reject(new Error('synthetic child returned invalid benchmark output'));
            }
          });
        });
        metrics.childRssBytes.push(childMetrics.rssBytes);
        metrics.childCpuMicros.push(childMetrics.cpuUserMicros + childMetrics.cpuSystemMicros);
        metrics.childDurationsMs ??= [];
        metrics.childDurationsMs.push(performance.now() - startedAt);
        metrics.syntheticChildHeapLimitBytes = childMetrics.heapLimitBytes;
        return await fake.inspect(context);
      } finally {
        metrics.activeChildren -= 1;
      }
    },
  };

  return {
    adapter,
    metrics,
    waitForNextChildStart() {
      const latch = deferred();
      startListeners.push(latch);
      return latch.promise;
    },
  };
}

function summarizeSyntheticMetrics(metrics) {
  return {
    adapter_inspections: metrics.inspections,
    max_concurrent_children: metrics.maxConcurrentChildren,
    child_rss_median_mib: round(percentile(metrics.childRssBytes, 0.5) / 1024 / 1024),
    child_rss_peak_mib: round(Math.max(0, ...metrics.childRssBytes) / 1024 / 1024),
    child_cpu_total_ms: round(
      metrics.childCpuMicros.reduce((sum, value) => sum + value, 0) / 1_000,
    ),
    child_duration_p95_ms: round(percentile(metrics.childDurationsMs ?? [], 0.95)),
    child_heap_limit_mib: round((metrics.syntheticChildHeapLimitBytes ?? 0) / 1024 / 1024),
  };
}

async function benchmarkInspectionCoordination() {
  const direct = createSyntheticAdapter('synthetic-direct');
  const directStartedAt = performance.now();
  await Promise.all(Array.from({ length: syntheticFanIn }, () => direct.adapter.inspect({})));
  const directElapsedMs = performance.now() - directStartedAt;

  const coordinated = createSyntheticAdapter('synthetic-coalesced');
  const coordinator = new ProviderInspectionCoordinator();
  const coordinatedStartedAt = performance.now();
  await Promise.all(
    Array.from({ length: syntheticFanIn }, () => coordinator.inspect(coordinated.adapter)),
  );
  const coordinatedElapsedMs = performance.now() - coordinatedStartedAt;
  await coordinator.close();

  const barrier = createSyntheticAdapter('synthetic-barrier');
  const barrierCoordinator = new ProviderInspectionCoordinator();
  const firstStart = barrier.waitForNextChildStart();
  const beforeAction = barrierCoordinator.inspect(barrier.adapter);
  await firstStart;
  barrierCoordinator.markActionCompleted('synthetic-barrier');
  const secondStart = barrier.waitForNextChildStart();
  const afterAction = barrierCoordinator.inspectFresh(barrier.adapter);
  await Promise.all([beforeAction, afterAction]);
  await secondStart;
  await barrierCoordinator.close();

  const reconciliation = createSyntheticAdapter('synthetic-reconciliation-reuse');
  const reconciliationCoordinator = new ProviderInspectionCoordinator();
  reconciliationCoordinator.markActionCompleted('synthetic-reconciliation-reuse');
  const reconciliationStart = reconciliation.waitForNextChildStart();
  const reconciliationStartedAt = performance.now();
  const reconciledObservation = reconciliationCoordinator.inspect(reconciliation.adapter);
  const reconciledConfirmation = reconciliationCoordinator.inspectFresh(reconciliation.adapter);
  await reconciliationStart;
  await Promise.all([reconciledObservation, reconciledConfirmation]);
  const reconciliationElapsedMs = performance.now() - reconciliationStartedAt;
  await reconciliationCoordinator.close();

  assert.equal(direct.metrics.inspections, syntheticFanIn);
  assert.equal(coordinated.metrics.inspections, 1);
  assert.equal(barrier.metrics.inspections, 2);
  assert.equal(reconciliation.metrics.inspections, 1);
  assert.equal(coordinated.metrics.maxConcurrentChildren, 1);
  assert.equal(barrier.metrics.maxConcurrentChildren, 1);
  assert.equal(reconciliation.metrics.maxConcurrentChildren, 1);
  return {
    synthetic_child: {
      buffer_mib: syntheticChildBytes / 1024 / 1024,
      runtime_ms: syntheticChildDelayMs,
      fan_in: syntheticFanIn,
      environment: 'PATH only; no provider credentials or NODE_OPTIONS',
    },
    direct_fan_in: {
      ...summarizeSyntheticMetrics(direct.metrics),
      elapsed_ms: round(directElapsedMs),
    },
    coalesced_fan_in: {
      ...summarizeSyntheticMetrics(coordinated.metrics),
      elapsed_ms: round(coordinatedElapsedMs),
    },
    fresh_post_action_barrier: summarizeSyntheticMetrics(barrier.metrics),
    post_action_reconciliation_reuse: {
      ...summarizeSyntheticMetrics(reconciliation.metrics),
      elapsed_ms: round(reconciliationElapsedMs),
    },
  };
}

function benchmarkEmptyAggregation(db, repositories) {
  const reads = { checkpoints: 0, samplePages: 0 };
  const aggregation = repositories.usageAggregation;
  const samples = repositories.windowSamples;
  const checkpoint = aggregation.checkpoint.bind(aggregation);
  const listForAggregation = samples.listForUsageAggregation.bind(samples);
  aggregation.checkpoint = (...args) => {
    reads.checkpoints += 1;
    return checkpoint(...args);
  };
  samples.listForUsageAggregation = (...args) => {
    reads.samplePages += 1;
    return listForAggregation(...args);
  };

  processUsageAggregationBatch(db, repositories, nowMs);
  const measure = (batchCalls) => {
    reads.checkpoints = 0;
    reads.samplePages = 0;
    const cpuStart = process.cpuUsage();
    const startedAt = performance.now();
    for (let index = 0; index < batchCalls; index += 1) {
      processUsageAggregationBatch(db, repositories, nowMs);
    }
    const elapsedMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuStart);
    return {
      empty_batch_calls: batchCalls,
      checkpoint_reads: reads.checkpoints,
      sample_page_reads: reads.samplePages,
      elapsed_ms: round(elapsedMs, 3),
      cpu_ms: round((cpu.user + cpu.system) / 1_000, 3),
    };
  };

  return {
    modeled_idle_minute: {
      legacy_one_second_polling: measure(60),
      worker_one_minute_fallback: measure(1),
      modeled_empty_batch_reduction_percent: round((1 - 1 / 60) * 100, 2),
    },
  };
}

function seedRetainedIntervals(db) {
  const insert = db.prepare(
    `INSERT INTO usage_intervals (
      source_sample_id, provider_id, window_kind, from_ms, to_ms,
      usage_delta_ratio, quality, reason_code
    ) VALUES (?, 'codex', 'weekly', ?, ?, 0.001, 'observed', NULL)`,
  );
  const transaction = db.transaction(() => {
    let id = 1;
    const firstMs = nowMs - historyDays * dayMs;
    for (let index = 0; index < historyDays * intervalsPerDay; index += 1) {
      const fromMs = firstMs + index * intervalMs;
      insert.run(id, fromMs, fromMs + intervalMs);
      id += 1;
    }
  });
  transaction();
  return historyDays * intervalsPerDay;
}

function readHeatmapPage(repositories) {
  return readUsagePageData({
    repositories,
    now: new Date(nowMs),
    timezone: 'UTC',
    providerId: 'codex',
    windowKind: 'weekly',
    localDay: '2026-10-02',
  });
}

function benchmarkHeatmap(defaultRepositories, reducedCacheRepositories) {
  const initial = readHeatmapPage(defaultRepositories);
  assert.equal(initial.days.length, 365);
  assert.equal(initial.selectedProviderId, 'codex');

  const configurations = [
    { key: 'default', repositories: defaultRepositories, latencies: [], cpuMs: 0 },
    {
      key: 'reduced',
      repositories: reducedCacheRepositories,
      latencies: [],
      cpuMs: 0,
    },
  ];
  for (let index = 0; index < 4; index += 1) {
    for (const configuration of configurations) {
      readHeatmapPage(configuration.repositories);
    }
  }
  for (let index = 0; index < heatmapIterations; index += 1) {
    const order = index % 2 === 0 ? configurations : [...configurations].reverse();
    for (const configuration of order) {
      const cpuStart = process.cpuUsage();
      const startedAt = performance.now();
      const page = readHeatmapPage(configuration.repositories);
      configuration.latencies.push(performance.now() - startedAt);
      const cpu = process.cpuUsage(cpuStart);
      configuration.cpuMs += (cpu.user + cpu.system) / 1_000;
      assert.equal(page.days.length, 365);
    }
  }
  const summarize = (configuration) => ({
    cache_size_setting: configuration.key === 'default' ? undefined : -4096,
    iterations: heatmapIterations,
    heatmap_days: 365,
    latency_median_ms: round(percentile(configuration.latencies, 0.5)),
    latency_p95_ms: round(percentile(configuration.latencies, 0.95)),
    cpu_ms: round(configuration.cpuMs),
  });
  return {
    default_cache: summarize(configurations[0]),
    reduced_cache_candidate: summarize(configurations[1]),
  };
}

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'awm-performance-benchmark-'));
const databasePath = path.join(tempDir, 'benchmark.db');
const db = openDatabase(databasePath);
let reducedCacheDb;
const repositories = createRepositories(db);
const providerNow = nowMs;
repositories.providers.upsert({
  id: 'codex',
  kind: 'codex',
  enabled: true,
  mode: 'monitor_only',
  pollIntervalSeconds: 30,
  config: {},
  configVersion: 1,
  createdAtMs: providerNow,
  updatedAtMs: providerNow,
});

const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
eventLoopDelay.enable();
try {
  const aggregation = benchmarkEmptyAggregation(db, repositories);
  const retainedIntervalCount = seedRetainedIntervals(db);
  reducedCacheDb = openDatabase(databasePath);
  reducedCacheDb.pragma('cache_size = -4096');
  const databaseSize = {
    page_size_bytes: db.pragma('page_size', { simple: true }),
    page_count: db.pragma('page_count', { simple: true }),
    cache_size_setting: db.pragma('cache_size', { simple: true }),
    mmap_size_bytes: db.pragma('mmap_size', { simple: true }),
  };
  const heatmap = benchmarkHeatmap(repositories, createRepositories(reducedCacheDb));
  const inspection = await benchmarkInspectionCoordination();
  eventLoopDelay.disable();

  console.log(
    JSON.stringify(
      {
        benchmark: 'synthetic, local-only; no official provider executable is invoked',
        node_version: process.version,
        v8_heap_limit_mib: round(getHeapStatistics().heap_size_limit / 1024 / 1024),
        process_memory_after_benchmark_mib: {
          heap_used: round(process.memoryUsage().heapUsed / 1024 / 1024),
          rss: round(process.memoryUsage().rss / 1024 / 1024),
        },
        event_loop_delay_p95_ms: round(eventLoopDelay.percentile(95) / 1e6),
        empty_usage_aggregation: aggregation,
        retained_history_heatmap: {
          retained_days: historyDays,
          derived_intervals: retainedIntervalCount,
          database_size_mib: round(
            (databaseSize.page_size_bytes * databaseSize.page_count) / 1024 / 1024,
          ),
          sqlite_before: databaseSize,
          current_cache_setting: databaseSize.cache_size_setting,
          ...heatmap,
        },
        inspection_coordination: inspection,
        interpretation: [
          'The empty-batch comparison models source-level cadence: the former timer invoked the batch 60 times/minute; the worker has one startup recovery and at most one idle fallback per minute.',
          'Synthetic child RSS and CPU describe this Node subprocess fixture, not Codex or Antigravity client footprints.',
          'Heap-cap runs exercise this benchmark process and the persisted heatmap read path, not the complete daemon or authenticated provider integrations.',
          'Keep memory defaults unchanged unless representative full-daemon evidence demonstrates headroom and acceptable GC/latency behavior.',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  eventLoopDelay.disable();
  if (reducedCacheDb?.open) reducedCacheDb.close();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
}
