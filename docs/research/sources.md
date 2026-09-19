# Research sources

Research snapshot: **2026-09-14**. External behavior can change; refresh before implementing or materially changing a real provider adapter.

## OpenAI Codex

Primary official documentation:

- Managing usage with GPT-6 Astra in Work and Codex  
  https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex
- How banked Codex resets work  
  https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work
- Terms of Use (individual services)  
  https://openai.com/policies/row-terms-of-use/
- Service Terms  
  https://openai.com/policies/service-terms/

Official open-source client/protocol evidence:

- Codex repository  
  https://github.com/openai/codex
- app-server protocol account types  
  https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs
- rate-limit backend client implementation  
  https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs
- app-server rate-limit tests  
  https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/rate_limits.rs

Important research distinction: the official client source demonstrates `/api/codex/usage` / ChatGPT `wham` behavior, but those backend URLs are **not treated as a public stable API**. The preferred integration seam is the official Codex client/app-server protocol when feasible.

## Google Antigravity

Official documentation:

- Plans / quotas  
  https://antigravity.google/docs/plans
- Model Quotas `/usage` (`/quota`)  
  https://antigravity.google/docs/cli/commands/usage
- Headless mode  
  https://antigravity.google/docs/cli/headless/
- Installation & auth  
  https://antigravity.google/docs/cli/install/
- CLI troubleshooting/keyring  
  https://antigravity.google/docs/cli/troubleshooting/
- FAQ / third-party access warning  
  https://antigravity.google/docs/faq/
- Official CLI GitHub repository  
  https://github.com/google-antigravity/antigravity-cli

The FAQ says third-party software/tools/services must not access Antigravity using Antigravity login. Therefore this project must not extract/replay Antigravity tokens or directly impersonate the backend client. Any integration must stay on a documented official CLI surface and be reviewed again before enabling quota-affecting automation.

## User repository reconnaissance

Representative repositories inspected through the GitHub connector:

- `Nerver-zip/ghinfo`: small self-hosted service, strict `AGENTS.md`, `.agents/skills`, CMake/CI, hardened single-service Compose and multi-stage non-root Dockerfile.
- `Nerver-zip/chess-saas`: agent-native documentation, root `AGENTS.md` entrypoint, `.agents/skills`, implementation plans, pnpm/TypeScript validation gates, explicit product scope.
- `Nerver-zip/fisiotrack`: Docker-first deployment docs, Compose validation, backend/frontend tests and image smoke test in CI.

See `docs/PLAN.md` section B for conventions adopted and consciously rejected.
