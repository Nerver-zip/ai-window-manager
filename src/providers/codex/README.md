# Codex adapter

The adapter uses the official `codex app-server` stdio JSONL protocol:

1. `initialize`;
2. `initialized` notification;
3. `account/rateLimits/read`.

For the quota-consuming action path it additionally uses the official
app-server lifecycle:

1. `thread/start` with an ephemeral thread, `approvalPolicy=never` and
   read-only sandbox;
2. `turn/start` with the fixed minimal message `Hi!`;
3. wait for the matching `turn/completed` notification;
4. close the child process cleanly.

The application defaults `AWM_CODEX_TRIGGER_ENABLED` to `true`; set it to
`false` to explicitly disable quota-consuming actions. Dispatch also requires
the provider's persisted mode to be `automation` and a supported exact target.
It never calls `/api/codex/usage` or
`/wham/usage`, accepts `chatgptAuthTokens`, parses cookies or JWTs, or copies
credentials from a workstation. The caller must provide a dedicated persistent
`CODEX_HOME` directory owned by the official Codex client.

When the trigger gate is enabled, a reset timestamp is used as an explicitly
inferred phase (`INACTIVE` after reset, `ACTIVE` before reset) so activation
policies can become actionable. A zero-usage window is treated as inactive by
the same bounded inference. The inference is not claimed as an official
lifecycle field; operators should review it before enabling quota consumption.

The parser preserves primary/secondary windows and multiple
`rateLimitsByLimitId` buckets. Missing reset or duration fields remain missing;
no window start or phase is invented from partial usage data. Protocol and
authentication failures return a bounded normalized observation with no raw
provider payload or error text.

## Manual live acceptance

Live acceptance is intentionally not part of CI. It was exercised once in an
explicitly authorized disposable runtime: the only message sent by AWM was
`Hi!`, and the persisted before/after observations showed the reset become
anchored. The app-server response exceeded the local five-second deadline and
was correctly classified as uncertain; never retry such a timeout blindly,
use reset credits, or copy provider state into this repository.
