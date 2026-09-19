# Prompt: implement one backlog issue

Implement issue `<ID>` from `docs/BACKLOG.md`.

Before editing:

1. read `/AGENTS.md`;
2. read the relevant canonical docs/ADRs;
3. read the relevant skill;
4. restate scope, acceptance criteria, dependencies, risks, and out-of-scope items;
5. identify the smallest vertical slice.

During implementation:

- preserve architecture boundaries;
- use FakeProvider/fixtures, not live quota, in ordinary tests;
- add negative/failure-path tests;
- update docs when a contract/invariant changes.

Finish by running the relevant checks and, if feasible, `pnpm validate`. Report commands honestly.
