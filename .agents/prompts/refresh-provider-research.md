# Prompt: refresh provider research

Refresh one provider section in `docs/providers.md` and `docs/research/sources.md`.

Required procedure:

1. prioritize current official provider docs;
2. inspect official client source only where public docs are insufficient;
3. classify every finding as Supported / Observed-Internal / Inferred / Unknown;
4. check current Terms/FAQ language;
5. never treat an internal endpoint as stable public API;
6. update capability flags only if evidence changes;
7. add or update sanitized parser/contract fixtures if the official client output changed;
8. create a spike instead of guessing when semantics remain unknown.

Do not execute a live trigger merely to satisfy research unless the issue explicitly authorizes quota-consuming testing.
