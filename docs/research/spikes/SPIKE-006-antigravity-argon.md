# SPIKE-006 — Gemini 4 Argon quota identity and CLI compatibility

**Research checked:** 2026-10-19

**Status:** Incomplete — official model availability is documented, but the current authenticated `/usage` output for the target account has not been collected.

**Scope:** Official documentation and release metadata; no provider prompt, credential access, or quota action.

## Conclusion

Argon is an officially supported Antigravity CLI model on eligible plans. The
public documentation does not establish a distinct Argon quota group, its
window type, its reset semantics, or whether its usage is accounted separately
from the existing Gemini group. The documentation's usage example still shows
only the Gemini and Claude/GPT groups.

Do not add an Argon `WindowSnapshot`, fixture, policy target, or trigger mapping
until a sanitized read-only `/usage` result from the target account identifies
the actual bucket. Argon prompt dispatch remains unvalidated and must remain
disabled by default.

## Official documentation reviewed

The [model availability page](https://www.antigravity.google/docs/models/)
lists Gemini 4 Argon for the Antigravity App and CLI. It marks availability for
paid, non-trial Google AI Pro, Google AI Ultra, and Enterprise; the page says
Argon is unavailable in Antigravity IDE. These are documented plan-level facts,
not evidence that a specific account is entitled to the model.

The [headless CLI guide](https://www.antigravity.google/docs/cli/headless/)
documents `agy models` and lists `gemini-4-argon-high` and
`gemini-4-argon-medium`. It also says that an unknown model supplied to
headless `--model` fails rather than silently falling back. This establishes
documented slugs, not the output of `agy models` on the operator's account or
the behavior of an Argon request against quota.

The [Plans page](https://www.antigravity.google/docs/plans) describes general
plan quota behavior: Ultra receives five-hour refreshes and weekly limits, Pro
receives five-hour refreshes until its weekly limit, and other plans receive
weekly refreshes. It does not describe Argon-specific quota buckets or reset
semantics.

The model page's `/usage` illustration lists `Gemini Models` and `Claude and
GPT models`, each with weekly and five-hour limits. It does not show a separate
Argon quota. This omission is not proof that Argon shares Gemini quota or is
absent from a particular account.

## CLI release compatibility

The repository pins Antigravity CLI 1.3.3. The project's read-only
`pnpm provider-clients:check` command resolved official stable release 1.4.2,
published 2026-10-18. The same project's official-release resolver returned
these GitHub-published asset digests:

| Architecture | Asset                        | SHA-256                                                            |
| ------------ | ---------------------------- | ------------------------------------------------------------------ |
| amd64        | `agy_cli_linux_x64.tar.gz`   | `6395837ac0e193dd3fe50f1228e1c4aea345ca99636d54404ab7e74397d4091c` |
| arm64        | `agy_cli_linux_arm64.tar.gz` | `08dd4a2ca52d531fef1dfae4ec2fbafcd56342bfa694c8193a60da2b26fb1898` |

The current host has neither a packaged `agy` executable nor a Docker daemon.
The existing provider-client update-related offline suite passed 104 tests
across seven files, but those synthetic tests do not install or execute the
1.4.2 artifact. Therefore `agy --version`, `agy --help`, `agy models`, and
authenticated `/usage` compatibility remain unverified here. No artifact was
downloaded or installed, and the lockfile was not changed.

## Evidence matrix

| Property                             | Evidence                                           | Confidence / limit                                                                               |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Argon model availability             | Official model page                                | Documented for eligible plans; target-account entitlement unknown                                |
| Documented model slugs               | Official headless guide                            | `gemini-4-argon-high` and `gemini-4-argon-medium`; target-account `agy models` output unverified |
| Separate quota family                | No target-account `/usage` evidence                | Unknown                                                                                          |
| Provider-issued group and bucket IDs | No target-account `/usage` evidence                | Unknown                                                                                          |
| Weekly window                        | No target-account `/usage` evidence                | Unknown                                                                                          |
| Exactly one Argon bucket             | No target-account `/usage` evidence                | Unknown                                                                                          |
| No five-hour Argon bucket            | Documentation example omits Argon                  | Unknown; omission is not proof                                                                   |
| Relationship to Gemini quota         | No target-account `/usage` evidence                | Unknown                                                                                          |
| Reset timestamp meaning              | Plans page gives only general refresh descriptions | Unknown for Argon                                                                                |
| Argon request's quota effect         | No authorized live request                         | Unknown; no request was sent                                                                     |

## Required next evidence

Use the official authenticated CLI after it has been updated through AWM's
existing verified runtime-update path. Run only the version, model-list, and
read-only usage operations:

```text
agy --version
agy models
agy -p '/usage' --output-format json
```

Return only the CLI version; Argon model-list lines; and the usage groups,
bucket IDs, window values, remaining fractions, and reset timestamps. Replace
account/user identifiers and any authentication or session values before
sharing. Do not send a model prompt.

The sanitized result must establish whether Argon is a distinct bucket and
which `window` value the CLI reports. If it does not distinguish Argon from
Gemini, stop normalization work at safe discovery and document the remaining
ambiguity. Do not create a representative Argon fixture until this evidence
exists; fixture ratios and timestamps can then be synthetic while preserving
the observed field names and bucket structure.

## Trigger and lifecycle limits

The official documentation supplies candidate Argon model slugs, but does not
prove that the selected account's CLI accepts them or that an Argon request
independently changes an Argon quota window. Existing Gemini and Claude/GPT
trigger experiments do not establish Argon behavior. No live trigger request
is authorized by this research, and no Argon trigger capability should be
enabled by default.

Even after the read-only quota identity is established, any claim that an
Argon request starts or affects a particular window requires separate explicit
authorization and controlled live evidence. Offline tests and model-list
output cannot prove that side effect.
