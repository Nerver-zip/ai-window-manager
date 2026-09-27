# SPIKE-005 — Antigravity quota-window activation through the official CLI

**Status:** The CLI experiment is recorded from operator-provided account
evidence. On 2026-09-27 the owner also confirmed end-to-end AWM trigger
acceptance for both model families, bringing the integrated action flow to
parity with Codex. This release-preparation run did not repeat a provider
request or consume quota.

**Observed:** 2026-09-24, UTC. One ordinary `Hi!` sent with the official
Antigravity CLI anchored the five-hour window for the selected quota family.
The action consumed normal provider quota and completed as one turn.

## Gemini Models

```text
model: gemini-3.8-flash-low
prompt: Hi!

before: 19:21:39 UTC; remaining 100%; projected reset about 00:21:38Z
after:  19:22:53 UTC; remaining 99.95%; reset 00:22:23Z
        same reset observed at 19:24:06 and 19:28:27 UTC
```

## Claude and GPT Models

```text
model: claude-sonnet-4-6
prompt: Hi!

before: 19:26:47 UTC; remaining 100%; projected reset about 00:26:45Z
after:  19:27:19 UTC; remaining 98.96%; reset 00:26:50Z
        same reset observed at 19:28:27 UTC
```

## Conclusion and limits

For the tested account, pinned CLI path, and selected model families, one normal
official prompt was sufficient to start/anchor the corresponding five-hour
window. This is experimental evidence, **not** a universal Google guarantee.
No dedicated window-start operation is documented, and a prompt can use quota
from more than one window in the same family. The adapter therefore describes
the action as `observed_undocumented`, declares quota consumption, requires an
explicit feature gate plus provider automation mode, and lets the user choose
one exact quota target. The other model family is never selected by that
request.

The application uses only the official `agy` interface, persists an
intent before dispatch, confirm the exact selected target from a fresh usage
observation, and leave post-dispatch ambiguity `uncertain` without retry.
Normal CI uses fake processes and sanitized fixtures. The integrated acceptance
is owner-confirmed evidence for the tested setup; it is not a guarantee across
accounts, plans, or future CLI versions. No quota-consuming request was made by
the implementation agent during this release-preparation run.
