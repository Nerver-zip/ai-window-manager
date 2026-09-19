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

## Secret scanning

Install Gitleaks and run `pnpm secret:scan` before review. CI runs the pinned Gitleaks Action on pushes and pull requests; real secrets must never be committed, including in fixtures or examples.
