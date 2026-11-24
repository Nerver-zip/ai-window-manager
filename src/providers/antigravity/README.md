# Antigravity provider adapter

This directory contains the adapter for the pinned official `agy` CLI. Usage
inspection invokes the headless command:

```text
agy -p /usage --output-format json --print-timeout 30s
```

The executable path is injected and commands use direct argv (`shell: false`).
The adapter normalizes two quota families: Gemini and Claude/GPT, each with a
five-hour and weekly window. Google documents that models within a group share
those limits. Its current [plans page](https://antigravity.google/docs/plans)
places Gemini 4 Argon within the shared Gemini quota. The
[CLI usage docs](https://antigravity.google/docs/cli/commands/usage/) describe
the model groups and their shared five-hour and weekly limits. The nested
machine-readable bucket identifiers remain an official-client output detail,
not a published versioned API; AWM does not claim live verification of any
current bucket ID.

The adapter validates bounded JSON and normalizes the CLI's five-hour/weekly
duration labels as inferred facts. Phase is inferred from the remaining
fraction with a bounded `0.00001` endpoint tolerance: near-full allowance is
`INACTIVE`, near-zero allowance is `EXHAUSTED`, and intermediate allowance is
`ACTIVE`. These are project operational states, not lifecycle fields reported
by Google. A `99.95%` remaining window stays `ACTIVE`.

An injected trigger gate defaults to off. If enabled with a model configured
for a quota family, only that family's exact window targets are advertised.
The adapter sends one prompt via official `agy -p`, selecting the model by the
exact requested `windowKind`. It uses JSON output, a bounded timeout and the
CLI sandbox; it never uses `--dangerously-skip-permissions`. The action consumes
quota and is classified as `observed_undocumented`, not as a documented
window-start operation. Operator-reported experiments observed the five-hour
window anchoring for Gemini and Claude/GPT on one account/CLI; this is
experimental evidence, not a universal guarantee.

Gemini 4 Argon is a selectable Gemini model while available in the official
CLI, not an independent quota family. The old `antigravity_argon_weekly`
target, policy scope and `AWM_ANTIGRAVITY_ARGON_*` configuration are retired.
Historical samples are retained and labeled as retired. When the Gemini model
setting selects one of the Argon slugs, the adapter verifies the configured
model from the stream's `init.model` before sending the prompt and uses the
short tool-free `ANTIGRAVITY_ARGON_MODEL_TRIGGER_MESSAGE`. This model-specific
verification and prompt are retained from historical account/client evidence;
they do not prove the current machine-readable quota identity. A missing or
mismatched model before prompt dispatch is a definite pre-dispatch failure. If
the model mismatch appears after possible dispatch, the outcome remains
uncertain and is never retried.

The official [models page](https://antigravity.google/docs/models), checked
2026-11-24, listed Gemini 4 Argon as leaving on November 30, 2026. Model
availability is plan- and time-dependent; administrators should use the model
only while the official client offers it.

Before prompt dispatch, invalid configuration or a process-start failure is a
definite failure. An authentication marker before dispatch is reported as
`AUTH_REQUIRED`. Once the prompt has been written, timeout, EOF, malformed
output, authentication errors, or an unexpected exit is `uncertain`; the
adapter does not retry. Fresh observation and target-window confirmation belong
to the application executor, not this provider adapter.

Authentication remains owned by the official CLI and its dedicated state /
keyring. This adapter never reads credentials, parses tokens, or calls provider
endpoints. Tests use synthetic fixtures and fake child processes; they do not
authenticate or spend quota.
