# Testing and quality gates

## Canonical local gate

Run the complete reproducible gate with:

```bash
pnpm validate
```

The command checks formatting, lint, strict TypeScript, the coverage-enforced test suite, the production build, and Gitleaks. CI runs these checks as explicit required steps and also validates Docker.

## Coverage baseline

```bash
pnpm test:coverage
```

The global minimum is 90% for all four metrics:

- lines
- statements
- functions
- branches

Coverage includes production TypeScript under `src/`. The only exclusions are compile-time-only contract modules and `src/index.ts`, whose process/listening side effects are validated by the container startup smoke test. Text, LCOV, and JSON summary reports are written to the ignored `coverage/` directory.

## Test isolation

Tests are offline and use FakeProvider, FakeClock, temporary SQLite databases, and local fixtures. They must not use provider credentials, real quota, network services, or the machine's persistent application state.

Action execution tests cover atomic claim, preflight rejection, dispatch result
mapping, ambiguous transport outcomes, confirmation, persisted executing
recovery, retryable versus terminal failures, and overlapping executor ticks.
Web tests verify settings/schedule validation, CSRF/Origin enforcement and that
HTTP reads remain provider-I/O free. The FakeProvider vertical slice asserts
that planned/confirmed tests perform zero quota-consuming trigger calls unless a
test explicitly invokes the executor with a synthetic non-quota action.

Additional offline coverage validates Codex thread cleanup registration and
official deletion protocol, Antigravity stream-JSON conversation-ID capture and
authorized exact-ID filesystem cleanup using temporary directories, cleanup
retry/restart behavior, independent Antigravity family policies with
provider-wide claim serialization, and provider-client archive digest/version/
compatibility/rollback paths. No provider account or quota is used by these
tests.

## Secret scanning

Install Gitleaks and run `pnpm secret:scan` before review. CI checks out full
history for the security job, installs the pinned Gitleaks CLI release after
verifying its published checksum, and runs the same `pnpm secret:scan` command
on pushes and pull requests. The Docker job runs an isolated authenticated
Compose smoke test with synthetic credentials, including anonymous-route
rejection, login, CSRF, restart invalidation and SQLite persistence. Real
secrets must never be committed, including in fixtures or examples.

The regression suite covers fresh dispatch authorization after async
preparation, exact deadlines, unknown-outcome closure, multi-batch retention,
loop progress, coalesced wakeups and persisted read backoff. Migrations are
tested on empty DBs and previous schemas, preserving legacy unresolved intents,
dedupe, cleanup and explicit preferences. FakeClock controls timing/jitter;
no real provider or quota is used.

`tests/web/runtime-metrics-smoke.test.ts` starts the actual offline daemon with
FakeProvider and temporary DB/auth, verifies graceful restart, technical metrics
revocation and bounded credential-free captured logs. The disposable Docker
smoke additionally exercises actual index wiring for inspect wakeup, deferred
hints, persisted backoff, private loop diagnostics and safe legacy resolution
after recovering an executing intent. No existing container/volume is used.

Validate the documented Prometheus example separately with
`node scripts/prometheus-config-smoke.mjs`. It runs fixed-version promtool in a
temporary network-disabled, capability-dropped container using only a synthetic private
credentials file. Docker may download the official validator image first.
