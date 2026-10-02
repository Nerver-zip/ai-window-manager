# Performance investigation

## Changes in this revision

- Provider inspections are coordinated per provider. Concurrent callers share
  one in-flight read; completed reads are not cached. A read started after an
  action waits for any older read and is a real fresh inspection.
- Post-action confirmation attempts are claimed and persisted before inspection.
  The initial check is prompt; subsequent read-only confirmation retries use a
  persisted exponential delay based on the reconcile interval, capped at five
  minutes. The executor may continue its separate five-second wake-up cadence,
  but those intervening ticks no longer launch another provider inspection.
  This does not retry a provider action.
- Usage aggregation is requested after an observation and its samples commit,
  runs a startup recovery pass, processes bounded 500-sample batches, and keeps a
  60-second idle fallback with bounded error retry. There is no one-second
  aggregation poll.

These changes bound redundant concurrent work and idle database wakeups. They do
not change provider polling cadence, provider action semantics, D-Bus/keyring
setup, SQLite WAL, or the observed quota-cycle identity used for automatic
schedule deduplication.

## Synthetic Node 24 benchmark

`scripts/performance-benchmark.mjs` uses a disposable SQLite database with 400
days of synthetic 15-minute contribution intervals (38,400 rows, 5.31 MiB),
reads a 365-day heatmap, and compares direct versus coordinated fan-in of eight
synthetic Node child processes. The child processes allocate an 8 MiB buffer,
run for 100 ms, and receive only `PATH`; no provider executable, credential,
network, login or quota-affecting request is used. The post-action check verifies
that the coordinator performs a second sequential inspection rather than
reusing pre-action data.

The benchmark was run in isolated read-only containers with `--network none`
using Node v24.21.0. Each SQLite cache profile received four warm-up reads and
eight alternating measured reads. Each heap profile was run once, so these
figures are a noisy local sample, not a portable performance guarantee:

| Node old-space cap | V8 heap limit reported | Heap used after run | Process RSS after run | Event-loop delay p95 |
| -----------------: | ---------------------: | ------------------: | --------------------: | -------------------: |
|             96 MiB |                288 MiB |            8.63 MiB |            290.28 MiB |              1.41 ms |
|            128 MiB |                320 MiB |            8.70 MiB |            311.02 MiB |              1.20 ms |
|            192 MiB |                384 MiB |           10.39 MiB |            340.00 MiB |              1.15 ms |

These are benchmark-process readings, not measurements of the complete daemon.
The old-space cap is not an RSS cap, and these results do not justify setting
`NODE_OPTIONS` or promising a 50–80 MiB service footprint. Keep the runtime
heap uncapped until measurements cover the full daemon and its real supported
provider-client workload.

| Old-space cap |     Cache setting | Heatmap median | Heatmap p95 | CPU for 8 reads |
| ------------: | ----------------: | -------------: | ----------: | --------------: |
|        96 MiB |  current `-16000` |      347.59 ms |   576.96 ms |     3,201.85 ms |
|        96 MiB | candidate `-4096` |      335.48 ms |   442.86 ms |     3,029.10 ms |
|       128 MiB |  current `-16000` |      211.82 ms |   240.35 ms |     1,811.42 ms |
|       128 MiB | candidate `-4096` |      220.20 ms |   259.33 ms |     1,981.16 ms |
|       192 MiB |  current `-16000` |      207.93 ms |   247.39 ms |     1,771.27 ms |
|       192 MiB | candidate `-4096` |      226.35 ms |   240.73 ms |     2,009.27 ms |

The reduced-cache candidate produced mixed latency and CPU results across the
three one-shot profiles. Eight iterations do not isolate native SQLite cache
allocation or establish a representative production memory saving. Retain the
existing `cache_size = -16000` and `mmap_size = 0` settings pending a longer,
isolated memory measurement.

| Synthetic inspection load       | Adapter inspections | Maximum concurrent children | Child CPU total |                       Elapsed |
| ------------------------------- | ------------------: | --------------------------: | --------------: | ----------------------------: |
| Eight direct concurrent callers |                   8 |                           8 |       727.96 ms |                     316.98 ms |
| Eight coalesced callers         |                   1 |                           1 |        84.00 ms |                     214.35 ms |
| Fresh post-action barrier       |                   2 |                           1 |       135.04 ms | second read follows the first |

The direct/coalesced comparison is a concurrency stress fixture, not the normal
polling pattern. It shows that overlap can be collapsed without collapsing the
required post-action confirmation read. It does not imply an eight-fold
reduction in real Codex or Antigravity invocations.

An idle-minute source-level comparison measured 60 empty-batch calls with the
former one-second poll (60 checkpoint and 60 sample-page reads), versus one
idle fallback call with the worker. That is 98.33% fewer idle empty-batch
invocations in this model; live committed samples still trigger aggregation.

## Reading operator-supplied telemetry

The operator-provided one-minute Beszel data and short PID samples are useful
clues, not a controlled attribution of the CPU or memory peaks. The sampling
resolution can miss brief spikes; the pasted `c`/`m` fields did not include their
unit metadata; and per-process RSS can count shared pages more than once. A
short-lived provider child observed during a sample does not by itself prove
that AWM launched it, that it leaked, or that it consumed quota. Do not infer a
50–80 MiB daemon target or a provider-side cause from those excerpts.

For a future operator-authorized live investigation, capture timestamped
cgroup/container memory and CPU alongside process-tree executable, PID, parent,
elapsed time, CPU time and RSS at sub-minute resolution. Keep provider action
logs and fresh `/status` quota observations separate from resource telemetry.
This implementation did not connect to or change production.
