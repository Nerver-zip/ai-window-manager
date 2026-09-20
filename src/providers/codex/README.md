# Codex adapter

The adapter uses the official `codex app-server` stdio JSONL protocol:

1. `initialize`;
2. `initialized` notification;
3. `account/rateLimits/read`.

For the explicit opt-in action path it additionally uses the official
app-server lifecycle:

1. `thread/start` with an ephemeral thread, `approvalPolicy=never` and
   read-only sandbox;
2. `turn/start` with the fixed minimal message `Hi!`;
3. wait for the matching `turn/completed` notification;
4. close the child process cleanly.

The action path is disabled until both `AWM_CODEX_TRIGGER_ENABLED=true` and the
provider's persisted mode is `automation`. It never calls `/api/codex/usage` or
`/wham/usage`, accepts `chatgptAuthTokens`, parses cookies or JWTs, or copies
credentials from a workstation. The caller must provide a dedicated persistent
`CODEX_HOME` directory owned by the official Codex client.

When the trigger gate is enabled, a reset timestamp is used as an explicitly
inferred phase (`INACTIVE` after reset, `ACTIVE` before reset) so target-reset
policies can become actionable. The inference is not claimed as an official
lifecycle field; operators should review it before enabling quota consumption.

The parser preserves primary/secondary windows and multiple
`rateLimitsByLimitId` buckets. Missing reset or duration fields remain missing;
no window start or phase is invented from partial usage data. Protocol and
authentication failures return a bounded normalized observation with no raw
provider payload or error text.

## Manual live acceptance

Live acceptance is intentionally not part of CI. In an explicitly authorized
disposable environment, provide a dedicated `CODEX_HOME`, authenticate through
the official Codex login/device flow, enable the trigger gate and provider
automation, and run exactly one controlled action. The only message sent by
AWM is `Hi!`; verify the matching `turn/completed`, the persisted intent state,
and the next rate-limit observation. Never retry a timeout, use reset credits,
or copy the temporary state into this repository.
