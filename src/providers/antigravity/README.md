# Antigravity provider adapter

This directory contains the adapter for the pinned official `agy` CLI. Usage
inspection invokes the headless command:

```text
agy -p /usage --output-format json --print-timeout 30s
```

The executable path is injected and commands use direct argv (`shell: false`).
The adapter validates bounded JSON, keeps Gemini and Claude/GPT quota families
separate, and normalizes the CLI's five-hour/weekly duration labels as inferred
facts. Phase is inferred from the remaining fraction with a bounded `0.00001`
endpoint tolerance: near-full allowance is `INACTIVE`, near-zero allowance is
`EXHAUSTED`, and intermediate allowance is `ACTIVE`. These are project
operational states, not lifecycle fields reported by Google. A `99.95%`
remaining window stays `ACTIVE`.

An injected trigger gate defaults to off. If enabled with a model configured
for a quota family, only that family's exact window targets are advertised and
the adapter can send exactly `Hi!` via official `agy -p`, selecting the model
by the exact requested `windowKind`. It uses
JSON output, a bounded timeout and the CLI sandbox; it never uses
`--dangerously-skip-permissions`. The action consumes quota and is classified
as `observed_undocumented`, not as a documented window-start operation. The
operator-reported experiment observed the 5-hour window anchoring for
`gemini-3.8-flash-low` and `claude-sonnet-4-6` on one account/CLI; this is
experimental evidence, not a universal guarantee.
The JSON envelope follows the official [headless CLI output contract](https://antigravity.google/docs/cli/headless/);
the successful sample is validated offline with a sanitized fixture.

Before a child starts, invalid configuration or a process-start failure is a
definite failure. Once the child has started, timeout, EOF, malformed output,
authentication errors, or an unexpected exit is `uncertain`; the adapter does
not retry. Fresh observation and target-window confirmation belong to the
application executor, not this provider adapter.

Authentication remains owned by the official CLI and its dedicated state /
keyring. This adapter never reads credentials, parses tokens, or calls
provider endpoints. Tests use synthetic fixtures and fake child processes;
they do not authenticate or spend quota.
