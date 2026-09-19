# Codex read-only adapter

The adapter uses the official `codex app-server` stdio JSONL protocol:

1. `initialize`;
2. `initialized` notification;
3. `account/rateLimits/read`.

It is deliberately monitor-only. It does not implement a trigger method, call
`/api/codex/usage` or `/wham/usage`, accept `chatgptAuthTokens`, parse cookies or
JWTs, or copy credentials from a workstation. The caller must provide a
dedicated persistent `CODEX_HOME` directory owned by the official Codex client.

The parser preserves primary/secondary windows and multiple
`rateLimitsByLimitId` buckets. Missing reset or duration fields remain missing;
no window start or phase is invented from partial usage data. Protocol and
authentication failures return a bounded normalized observation with no raw
provider payload or error text.

## Manual live acceptance

Live acceptance is intentionally not part of CI and was not performed by the
offline test suite. In an explicitly authorized disposable environment, provide
a dedicated `CODEX_HOME`, authenticate through the official Codex login/device
flow, and run the daemon with the pinned official `codex` binary. Verify only
that initialization and `account/rateLimits/read` normalize into the overview;
do not start a thread/turn or consume quota. Remove the temporary state after
the test and never copy it into this repository.
