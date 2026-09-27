# Contributing

AI Window Manager is a small self-hosted usage-window monitor and scheduler.
Read [the product boundaries](docs/product-boundaries.md) and
[agent instructions](AGENTS.md) before proposing changes.

## Local checks

Use Node.js 24 or newer and the pnpm version declared in `package.json`:

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm audit
docker compose config --quiet
docker build -t ai-window-manager:dev .
```

Changes to Docker/runtime behavior should also run the disposable smoke test in
[`docs/deployment.md`](docs/deployment.md#smoke-test-checklist). Do not use the
operator's persistent Compose project for tests.

## Provider and security boundaries

- Normal tests must use FakeProvider or sanitized fixtures; never use real
  provider credentials or spend quota in CI.
- Do not add undocumented provider endpoints, token extraction, account
  rotation, or blind retries of uncertain actions.
- Provider interactions may consume quota. The fresh-install example enables
  automatic starts for configured providers; explicitly opt out when testing
  unless a live action is deliberately authorized.
- Never commit `.env`, provider state, account data, transcripts, tokens, or
  real credentials. Gitleaks is a required gate.
- Keep lines, statements, functions, and branches coverage at or above 90%; do
  not lower a threshold or exclude relevant production code to pass CI.

## Pull requests

- Keep a change focused and describe its user-visible and operational impact,
  including security or migration implications where relevant.
- Report the checks actually run and any remaining limitations. CI must pass;
  do not remove or skip tests, weaken a gate, or claim unrun provider acceptance.
- Never include real provider credentials, account data, transcripts, or quota-
  consuming live-test results that expose private account information.

By submitting a contribution, you agree that the contribution is provided under
the repository's MIT license.
