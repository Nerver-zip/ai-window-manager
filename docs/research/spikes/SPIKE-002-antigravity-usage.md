# SPIKE-002 — Antigravity quota output contract

**Research date:** 2026-09-19
**CLI observed:** official `agy` CLI 1.2.7
**Scope:** read-only quota inspection only; no token extraction, backend calls, trigger, or adapter implementation.

## Conclusion

`VIABLE_OFFICIAL_READ_PATH`

The official CLI exposes `/usage` (alias `/quota`) and, when invoked through its
documented headless mode with `--output-format json` or `--output-format
stream-json`, the observed output contains a structured quota command result.
The path is suitable for a monitor-only adapter if it pins a tested CLI version,
validates the complete boundary strictly, and fails closed on schema changes.

This is not evidence for a trigger. No trigger capability is proposed, and no
inactive-window start semantics were established.

## Official surface and evidence

The official documentation says that `/usage` (alias `/quota`) refreshes quota
status and opens the Model Quotas panel. It also documents headless/print mode,
the `json` envelope, and `stream-json` NDJSON output:

- [Model Quotas (`/usage`)](https://antigravity.google/docs/cli/commands/usage)
- [Headless mode and output formats](https://antigravity.google/docs/cli/headless/)

Local evidence, using only the installed official CLI:

```text
$ agy --version
1.2.7

$ agy -p '/usage' --output-format text --print-timeout 30s
Gemini Models  Weekly Limit Remaining       94%   2026-09-23T03:59:46Z
Gemini Models  Five Hour Limit Remaining    100%  2026-09-19T22:47:03Z
Claude and GPT models  Weekly Limit Remaining     100%  2026-09-26T17:47:03Z
Claude and GPT models  Five Hour Limit Remaining  100%  2026-09-19T22:47:03Z
```

The JSON mode returned exit code 0, zero turns, zero token usage, and a
`command.name` of `usage` with structured `command.data.groups[].buckets[]`.
Three consecutive JSON runs all passed this validation:

```text
jq -e '.status == "SUCCESS"
  and (.command.name == "usage")
  and (.command.data.groups | type == "array")'
json_contract=ok
json_contract=ok
json_contract=ok
```

The `/quota` alias returned the same `command.name` and bucket structure. The
streaming mode emitted a `command_result` event followed by a terminal
`result` event, both carrying the structured quota data.

## Observed output contract

The observed JSON shape is:

```text
{
  "status": "SUCCESS",
  "response": "tab-delimited human-readable rows",
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 },
  "command": {
    "name": "usage",
    "data": {
      "description": "...",
      "groups": [
        {
          "name": "Gemini Models",
          "description": "...",
          "buckets": [
            {
              "id": "gemini-weekly",
              "name": "Weekly Limit Remaining",
              "description": "...",
              "window": "weekly",
              "remaining_fraction": 0.9426959156990051,
              "reset_time": "2026-09-23T03:59:46Z"
            }
          ]
        }
      ]
    }
  }
}
```

The documented headless JSON envelope is machine-readable. The nested
`command.data` quota object was observed from the official command, but the
public `/usage` page does not present it as a separately versioned schema. It
must therefore be treated as an official-client output contract with version
drift risk, not as a public Antigravity API.

## States and parseability

### Active / available evidence

The authenticated local CLI returned successful quota data containing both
weekly and five-hour buckets. A successful inspection can truthfully establish
that the CLI was able to refresh and return quota data at `observedAt`.

The sample included a partially consumed weekly bucket (`remaining_fraction`
approximately `0.943`) and full five-hour buckets (`1.0`). This demonstrates a
non-empty/available state and a partial-consumption state without spending
quota during the spike.

### Inactive and limited states

They were not manufactured. Intentionally spending quota or altering the
account to force a limit would violate the research boundary. The CLI output
does not expose an explicit `phase`, `inactive`, or `limited` field in the
observed contract. A future adapter must not infer those states from text
descriptions alone.

If a bucket is returned with `remaining_fraction == 0`, the adapter may expose
zero remaining quota as a usage fact, but should not invent a phase or window
start time unless a later official contract proves those semantics.

### Parseability

- `--output-format json` is a single JSON object and was parsed with `jq`.
- `--output-format stream-json` is NDJSON and emitted a structured
  `command_result` event plus a terminal `result` event.
- The plain text output is tab-delimited and should be treated as display-only.
- The nested quota object is currently parseable but not documented as a stable
  public schema; pin the CLI and validate required fields/types.
- Missing optional descriptions must be accepted; missing IDs, window kind,
  remaining fraction, or reset time should fail closed for that bucket.
- Unknown bucket/window values must be retained only as unavailable/unsupported,
  not coerced into a known domain value.

## Facts suitable for `ProviderObservation`

Subject to boundary validation, an official-CLI adapter could normalize:

| CLI fact                                         | Normalized fact                      | Provenance/limits                                                 |
| ------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------- |
| `command.data.groups[].name` and bucket identity | provider window/group identity       | observed; provider grouping is CLI-defined                        |
| `window: "5h"` or `"weekly"`                     | window kind/duration class           | observed label; no exact start timestamp                          |
| `remaining_fraction` in `[0, 1]`                 | remaining ratio                      | observed; `1 - remaining_fraction` is only an inferred used ratio |
| `reset_time` ISO-8601 `Z` timestamp              | reset fact                           | observed UTC instant; validate timestamp and retain source        |
| successful command + valid payload               | provider health / inspection success | observed at invocation time                                       |
| CLI version and parser contract version          | adapter diagnostics                  | bounded metadata only; never credentials                          |

The following must remain unknown unless a future supported output proves them:

- window start time;
- exact duration beyond the CLI's `5h`/`weekly` labels;
- active/inactive/limited phase;
- exact token/request allowance or consumption cost;
- semantics of when an inactive five-hour window starts;
- trigger capability or whether any action is quota-safe.

## Sanitized fixture

`tests/fixtures/providers/antigravity/usage/usage-json.success.json` contains
the observed shape with synthetic timestamps and no account identifiers,
credentials, conversation IDs, or raw transport data. It is a contract-shape
fixture only, not a claim that the nested object is permanently stable.

## Reproduction and safety notes

Commands used:

```bash
agy --version
agy -p '/usage' --output-format text --print-timeout 30s
agy -p '/usage' --output-format json --print-timeout 30s
agy -p '/quota' --output-format json --print-timeout 30s
agy -p '/usage' --output-format stream-json --print-timeout 30s
```

No normal prompt was sent. The successful `/usage` executions reported zero
turns and zero input/output/total tokens. No token, cookie, authorization
header, internal endpoint, or credential file was read or extracted.

The report deliberately does not claim coverage of inactive or exhausted
account states. Those states require a separately authorized, non-destructive
official test account or future official fixtures.

## Adapter recommendation

`ANT-001` may proceed only as a monitor-only, official-CLI adapter after the
implementation pins the tested CLI version and adds strict fixture tests for:

1. successful JSON output;
2. multiple groups and windows;
3. missing optional descriptions;
4. missing/malformed reset times and ratios;
5. unknown bucket/window values;
6. command failure/auth-required output;
7. changed `command.data` shape.

Any mismatch should produce unavailable/degraded health and retain the last
known-good observation. Do not parse the plain text table as the primary
contract, call a backend directly, or add trigger behavior.
