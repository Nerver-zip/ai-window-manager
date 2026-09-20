# Metrics and deterministic statistics

## Prometheus metrics

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
```

Do **not** label with account ID, email, model prompt, error message, timestamp, dedupe key or request ID.

Metrics are current/operational state; historical analysis reads SQLite.

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
