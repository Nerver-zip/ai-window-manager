# Performance investigation

## Changes in this revision

- Provider inspections are coordinated per provider. Concurrent callers share
  one in-flight read; completed reads are not cached. An ordinary reconciliation
  read started after action completion may satisfy confirmation. A read that
  predates the action is followed by a fresh sequential inspection.
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

## Inspection call-site audit

The daemon shares one coordinator and one adapter map across reconciliation,
execution and authentication. Compatibility probes construct separate adapters.

| Consumer                    | Inspection path                              | Cadence and safety boundary                                                                                                                       |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconciliation              | `Reconciler.inspect` → coordinator `inspect` | Only due provider polls; canonical validation precedes persistence.                                                                               |
| Executor preflight          | Coordinator `inspectFresh`                   | Fresh eligibility read; retryable pre-dispatch failures respect `notBeforeMs`, with the runtime retry delay aligned to the reconcile interval.    |
| Confirmation and recovery   | Coordinator `inspectFresh`                   | Persisted confirmation claim/deadline; exact target and observed cycle must still match. Only a read begun after action completion can be shared. |
| Authentication verification | Coordinator `inspectFresh`                   | Shared adapter identity; canceling one caller does not abort another caller's inspection.                                                         |
| Client compatibility probe  | Direct inspection of a temporary adapter     | Intentionally isolated, trigger disabled, bounded official-client probe; results are never shared across executable identities.                   |
| Operator inspection command | `POST /api/v1/providers/:id/inspect`         | Persists an inspection-request event and requests reconciliation; the HTTP handler performs no provider inspection.                               |

The local executor previously revisited succeeded/uncertain intents every five
seconds without a dedicated confirmation deadline. Tests reproduce that
condition and now prove intervening ticks perform no inspection. This confirms
a local source-level cause of redundant reads; production intent state was not
inspected, so it remains a hypothesis for the operator's process samples.

## Isolated full-daemon comparison

At measurement time, the baseline image was
`ai-window-manager:perf-baseline-cc2cd2e` (`sha256:0e2580789bfa6624c6276184e29c49a95537e6405ed6e705b638fb5623f08969`),
containing source `cc2cd2e`. The candidate was
`ai-window-manager:perf-candidate-20261002` (`sha256:ff3ba7d609d9d46b47ce4b345ac3462467f72a96caf1a2856fa10bcaad01c23f`),
containing the performance implementation and post-action reconciliation reuse.
Both samples used the same resolved base images and Node v24.21.0; temporary
tags may later be rebuilt or removed. Each received one 60-second idle sample
in a disposable container with `--network none`, a read-only root, temporary
`/data` and `/tmp`, synthetic operator credentials, all providers disabled and
an empty provider-client runtime root. Authenticated `/metrics` supplied process
memory/CPU readings. After the sampler exited, `docker stats --no-stream` and
`docker top` showed only `tini` and the daemon, with no provider CLI children.

| Measurement                         |            Baseline |           Candidate |
| ----------------------------------- | ------------------: | ------------------: |
| Daemon RSS, start → end             | 108.56 → 109.98 MiB | 110.98 → 111.77 MiB |
| V8 heap used, start → end           |   21.91 → 23.18 MiB |   22.16 → 23.18 MiB |
| External allocations, start/end     |            4.03 MiB |            4.03 MiB |
| CPU user + system over 60 seconds   |            0.2860 s |            0.2628 s |
| Container memory after sampler exit |           58.29 MiB |           59.36 MiB |

The one-shot CPU difference is too small and noisy to establish a significant
idle improvement. RSS did not decrease. Process RSS, external allocations and
container memory have different accounting and must not be summed or treated
as interchangeable. This run covers an idle daemon without provider children;
it does not establish GC headroom under an authenticated provider workload.

## Synthetic Node 24 benchmark

`scripts/performance-benchmark.mjs` uses a disposable SQLite database with 400
days of synthetic 15-minute contribution intervals (38,400 rows, 5.31 MiB),
reads a 365-day heatmap, and compares direct versus coordinated fan-in of eight
synthetic Node child processes. The child processes allocate an 8 MiB buffer,
run for 100 ms, and receive only `PATH`; no provider executable, credential,
network, login or quota-affecting request is used. The post-action check verifies
that the coordinator performs a second sequential inspection rather than
reusing pre-action data, and that a reconciliation read begun after action
completion satisfies confirmation with one inspection. Heatmap timing covers
the persisted UI data path, not complete HTML rendering or browser interaction.

After building a disposable candidate image, reproduce a runtime-matched
profile with the benchmark script mounted read-only:

```bash
docker build -t ai-window-manager:perf-benchmark .
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$PWD/scripts/performance-benchmark.mjs,dst=/app/scripts/performance-benchmark.mjs,readonly" \
  --entrypoint node ai-window-manager:perf-benchmark \
  --max-old-space-size=96 /app/scripts/performance-benchmark.mjs
```

Repeat sequentially with 128 and 192 MiB caps. A host run after `pnpm build`
also works, but record its Node major version; heap limits from a different
major are not directly comparable to this runtime.

The benchmark was run in isolated read-only containers with `--network none`
using Node v24.21.0. Each SQLite cache profile received four warm-up reads and
eight alternating measured reads. Each heap profile was run once, so these
figures are a noisy local sample, not a portable performance guarantee:

| Node old-space cap | V8 heap limit reported | Heap used after run | Process RSS after run | Event-loop delay p95 |
| -----------------: | ---------------------: | ------------------: | --------------------: | -------------------: |
|             96 MiB |                288 MiB |            8.66 MiB |            296.25 MiB |              1.65 ms |
|            128 MiB |                320 MiB |            8.69 MiB |            312.06 MiB |              1.57 ms |
|            192 MiB |                384 MiB |            9.04 MiB |            339.27 MiB |              1.50 ms |

These are benchmark-process readings, not measurements of the complete daemon.
The old-space cap is not an RSS cap, and these results do not justify setting
`NODE_OPTIONS` or promising a 50–80 MiB service footprint. Keep the runtime
heap uncapped until measurements cover the full daemon and its real supported
provider-client workload.

| Old-space cap |     Cache setting | Heatmap median | Heatmap p95 | CPU for 8 reads |
| ------------: | ----------------: | -------------: | ----------: | --------------: |
|        96 MiB |  current `-16000` |      301.91 ms |   358.83 ms |     2,693.67 ms |
|        96 MiB | candidate `-4096` |      281.06 ms |   338.78 ms |     2,509.20 ms |
|       128 MiB |  current `-16000` |      334.35 ms |   598.29 ms |     3,426.82 ms |
|       128 MiB | candidate `-4096` |      309.47 ms |   634.57 ms |     3,250.24 ms |
|       192 MiB |  current `-16000` |      365.26 ms |   657.82 ms |     4,052.10 ms |
|       192 MiB | candidate `-4096` |      428.09 ms |   674.43 ms |     4,116.79 ms |

The reduced-cache candidate produced mixed latency and CPU results across the
three one-shot profiles. Eight iterations do not isolate native SQLite cache
allocation or establish a representative production memory saving. Retain the
existing `cache_size = -16000` and `mmap_size = 0` settings pending a longer,
isolated memory measurement.

The following subprocess figures are from the 96 MiB parent profile. Child
processes do not inherit that old-space cap.

| Synthetic inspection load          | Inspections | Concurrent children | Child RSS median / peak | Child CPU total |          Elapsed |
| ---------------------------------- | ----------: | ------------------: | ----------------------: | --------------: | ---------------: |
| Eight direct callers               |           8 |                   8 |       52.97 / 53.22 MiB |       649.84 ms |        287.88 ms |
| Eight coalesced callers            |           1 |                   1 |       53.38 / 53.38 MiB |        73.37 ms |        200.27 ms |
| Pre-action read plus fresh barrier |           2 |                   1 |       53.24 / 53.30 MiB |       132.03 ms | sequential reads |
| Post-action reconciliation reuse   |           1 |                   1 |       53.23 / 53.23 MiB |        56.59 ms |        172.32 ms |

The direct/coalesced comparison is a concurrency stress fixture, not the normal
polling pattern. It shows that overlap can be collapsed without collapsing the
required post-action confirmation read. It does not imply an eight-fold
reduction in real Codex or Antigravity invocations.

An idle-minute source-level comparison measured 60 empty-batch calls with the
former one-second poll (60 checkpoint and 60 sample-page reads), versus one
idle fallback call with the worker. That is 98.33% fewer idle empty-batch
invocations in this model; live committed samples still trigger aggregation.
The 96 MiB profile measured 4.965 ms elapsed / 5.145 ms CPU for the 60 calls,
and 0.157 ms elapsed / 0.167 ms CPU for one call. These calls execute together
in the harness; this is not a sustained-minute production CPU measurement.

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
Record the deployed revision, schema version and reconcile/executor intervals;
from a consistent read-only database snapshot, compare intent counts by
provider/state and, on schema v9, confirmation attempt counts/deadlines against
inspection event timestamps. This tests the pending-confirmation hypothesis.
Collect only sanitized event metadata and resource fields, excluding command
arguments, process environments, auth volumes, raw provider payloads and
transcripts.
This implementation did not connect to or change production.
