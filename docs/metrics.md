# Metrics and deterministic statistics

## Prometheus metrics

### Dedicated scraper authentication

Operator sessions remain supported. For unattended collection, run
`pnpm metrics:token` locally: copy the once-displayed token into a private
file owned by the Prometheus process (mode `0600`), and configure only the
displayed digest as `AWM_METRICS_TOKEN_SHA256` in the AWM environment.
Never put the raw token in server `.env`, Git, URLs or logs; protect terminal
scrollback too. Empty digest preserves session-only access.

The credential authorizes only exact `GET`/`HEAD /metrics` without query
parameters. It grants no UI, diagnostics, API or mutation access. Use TLS
with certificate verification or a trusted private VPN: HTTP exposes Bearer
credentials just as it exposes session cookies. Example for an existing TLS
proxy (replace the synthetic hostname, not the authentication mechanism):

```yaml
scrape_configs:
  - job_name: awm
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/awm-metrics-token
    static_configs:
      - targets: ['awm.example.invalid:443']
```

`authorization.credentials_file` is supported by the
[official Prometheus configuration](https://prometheus.io/docs/prometheus/latest/configuration/#http_config).
Rotate by provisioning a new private file and digest, then restart AWM and
reload the scraper configuration. Revoke by clearing the digest and restarting.
There is no hot reload of AWM environment configuration. Restart invalidates
browser sessions but does not invalidate an unchanged metrics credential.

Low-cardinality labels only (`provider`, `window`, bounded enums):

```text
ai_window_provider_up{provider}
ai_window_usage_ratio{provider,window}
ai_window_remaining_ratio{provider,window}
ai_window_seconds_until_reset{provider,window}
ai_window_age_seconds{provider,window}
ai_window_inspection_total{provider,result}
ai_window_trigger_total{provider,result}
ai_window_scheduler_decisions_total{provider,decision}
ai_window_action_intents{provider,state}
ai_window_last_successful_inspection_timestamp_seconds{provider}
ai_window_retention_backlog_rows{bucket}
ai_window_retention_backlog_capped{bucket}
ai_window_retention_oldest_age_seconds{bucket}
ai_window_retention_measured_timestamp_seconds
ai_window_retention_duration_seconds
ai_window_retention_deleted_rows
ai_window_retention_pending
ai_window_storage_bytes{file}
```

Do **not** label with account ID, email, model prompt, error message, timestamp, dedupe key or request ID.

Metrics are current/operational state; historical analysis reads SQLite.

Retention measurements are cached after each maintenance pass, not queried on
scrapes. The seven fixed buckets are samples, intervals, ordinary, lifecycle,
action, security and intents. Eligible-row counts saturate at 1,000 per bucket;
`backlog_capped=1` means a lower estimate, not an exact total. Oldest age reflects
the measured instant (consult `measured_timestamp_seconds` for freshness).
Unaggregated samples and unresolved intents are excluded from eligible backlog.
Database and WAL file sizes use only the fixed `database`/`wal` labels; unavailable
sizes are omitted, and no filename or path is exported. A large database file
can contain reusable pages even after backlog reaches zero.

## Daemon loop progress

The fixed loop labels are `reconcile`, `executor`, `cleanup`, `aggregation` and
`retention`. Gauges report running state, current/last duration, consecutive
unhandled failures and started/completed/last-success timestamps. Timestamp
series are omitted until the corresponding event occurred. `ai_window_loop_healthy`
is zero for stalled, overdue or repeatedly failing loops. Collection reads only
the in-memory monitor; it does not inspect providers or query SQLite.

The authenticated `GET /api/v1/diagnostics` returns operational readiness and
bounded loop details, plus provider health as a separate dimension. It returns
503 for missing supervision, unavailable SQLite or unhealthy loop progress.
Provider outage/authentication requirements alone do not make daemon progress
unhealthy: a completed attempt with a handled external failure still progresses.
Public `/healthz` remains a minimal HTTP/SQLite liveness probe, not readiness.

Startup and idle tolerance is two configured loop intervals plus the maximum
legitimate runtime budget; running work becomes stalled only beyond that budget.
Three consecutive unhandled local failures mark a loop failing; a successful
completion resets the streak. Elapsed calculations use a monotonic injected
clock, independently of wall-clock timestamps. Runtime budgets include sequential
official-client reads and bounded cleanup batches; aggregation/retention allow
60 seconds. Retention's configured idle sweep and aggregation's 60-second fallback
are included, so long operator-configured intervals are not false alarms.

These are diagnostics, not a new container restart policy. Docker `unhealthy`
does not itself restart containers, and provider outages must not trigger restart
loops. This change does not alter the existing Compose liveness healthcheck.

## MVP statistics

SQL/deterministic aggregation only:

- quota consumed per observed window;
- usage per day;
- mean/median consumption per completed window where samples permit it;
- observed window lifetime;
- windows used per day/week;
- trigger attempt/success/uncertain rate;
- usage by local hour bucket;
- typical high-usage period using histogram/threshold heuristics.

Recommendations remain deterministic. Example: if a stable fraction of recent consumption occurs in 14:00–20:00, propose a reset target near the start of that interval and show the data behind the suggestion.

The runtime updates inspection, observation, scheduler, trigger and intent-state
metrics from the reconciler/executor path. Opening `/` or `/api/v1/providers` is
not required to populate quota gauges. Age gauges are refreshed from persisted
timestamps, and labels remain bounded to provider/window/result/decision/state.
