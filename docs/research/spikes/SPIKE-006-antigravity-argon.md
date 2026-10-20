# SPIKE-006 — Gemini 4 Argon quota identity and CLI compatibility

**Research checked:** 2026-10-20

**Status:** Incomplete — official model availability is documented, but the target account's `/usage` output and a supported basis for AWM's third-party CLI integration have not been established.

**Scope:** Official documentation and release metadata; no authenticated CLI use, provider prompt, credential access, or quota action.

## Conclusion

Argon is an officially supported Antigravity CLI model on eligible plans. The
public documentation does not establish a distinct Argon quota group, its
window type, its reset semantics, or whether its usage is accounted separately
from the existing Gemini group. The documentation's usage example still shows
only the Gemini and Claude/GPT groups.

Google's current FAQ also creates a terms gate for this project: it says that
using third-party software, tools, or services to access Antigravity violates
the Terms of Service, and that wrapping headless `agy -p` in a third-party app
is unsupported under consumer plans. AWM is a third-party app that invokes
`agy`. The FAQ does not establish whether this integration is permitted under
Enterprise terms. Do not extend the AWM Antigravity integration or collect
account-authenticated `/usage` evidence through AWM until an applicable
authorization or supported integration path is established.

As a fail-closed discovery safeguard, the adapter rejects a usage payload when
group or bucket identity metadata explicitly contains an Argon label. It
returns a bounded `PROVIDER_WINDOW_IDENTITY_UNSUPPORTED` reason and no windows,
so reconciliation retains last-known-good usage. This guard prevents a label
such as `Gemini 4 Argon` from being normalized as regular Gemini; it is not
evidence that Argon has a separate provider quota, and it adds no Argon window,
fixture, policy, or trigger target.

Do not add an Argon `WindowSnapshot`, fixture, policy target, or trigger mapping
until supported account evidence identifies the actual quota identity and its
window semantics. Argon prompt dispatch remains unvalidated and must remain
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

The [Antigravity FAQ](https://antigravity.google/docs/faq/) says that third-party
software, tools, or services accessing Antigravity violate its Terms of Service
and can result in account suspension or termination. Its separate headless-mode
answer says `agy -p` is intended for direct scripting and CI, while wrapping it
inside third-party coding agents or applications is unsupported under consumer
plans. The FAQ recommends Gemini Enterprise or a Google AI Studio API key for
third-party coding-agent use with Gemini. It does not authorize AWM to wrap the
Antigravity CLI under consumer terms. Gemini Enterprise has a distinct
Antigravity AI developer tools offering and pooled-credit quota contract; it is
not evidence that an Argon-specific Antigravity window is exposed.
The account's plan and applicable terms are unknown, so this research does not
treat the standalone CLI documentation as authorization for AWM to wrap it.

Google Cloud's [AI developer tools setup](https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools-settings)
identifies the Business AI Code API as the service for Antigravity in Gemini
Enterprise and lists Gemini 4 Argon as a supported model. The [quotas and overages](https://docs.cloud.google.com/gemini/enterprise/docs/quotas-and-overages)
and [feature usage](https://docs.cloud.google.com/gemini/enterprise/docs/feature-usage)
pages describe shared AI developer-tool credits pooled by edition, project,
and location on a rolling seven-day cycle. The feature-usage page shows
absolute and percentage usage for pooled quotas. The [Business AI Code audit
docs](https://docs.cloud.google.com/gemini/docs/codeassist/business-audit-logging)
name `PredictionService.FetchQuotaStatus` as a `DATA_READ` method; [IAM docs](https://docs.cloud.google.com/iam/docs/roles-permissions/businessaicode)
expose `businessaicode.locations.fetchQuotaStatus`. These pages do not publish
the method's payload schema or an Argon-specific bucket contract. This is a
research lead for a separate Gemini Enterprise quota integration, not an
established contract for Antigravity windows.

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

| Property                                              | Evidence                                                | Confidence / limit                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Argon model availability                              | Official model page                                     | Documented for eligible plans; target-account entitlement unknown                                |
| Documented model slugs                                | Official headless guide                                 | `gemini-4-argon-high` and `gemini-4-argon-medium`; target-account `agy models` output unverified |
| Separate quota family                                 | No target-account `/usage` evidence                     | Unknown                                                                                          |
| Provider-issued group and bucket IDs                  | No target-account `/usage` evidence                     | Unknown                                                                                          |
| Weekly window                                         | No target-account `/usage` evidence                     | Unknown                                                                                          |
| Exactly one Argon bucket                              | No target-account `/usage` evidence                     | Unknown                                                                                          |
| No five-hour Argon bucket                             | Documentation example omits Argon                       | Unknown; omission is not proof                                                                   |
| Relationship to Gemini quota                          | No target-account `/usage` evidence                     | Unknown                                                                                          |
| Reset timestamp meaning                               | Plans page gives only general refresh descriptions      | Unknown for Argon                                                                                |
| Argon request's quota effect                          | No authorized live request                              | Unknown; no request was sent                                                                     |
| AWM use of Antigravity CLI under target account terms | Official FAQ; account plan and applicable terms unknown | Unresolved; no authenticated AWM-wrapped CLI operation is authorized by this spike               |
| Enterprise quota status method                        | IAM and audit docs name `FetchQuotaStatus`              | `DATA_READ` method; public request/response schema and Argon-level granularity not established   |
| Enterprise Argon quota shape                          | Enterprise model and quota docs                         | Argon is supported; AI developer-tool credits are pooled on a rolling seven-day basis            |

## Required next evidence and gate

Do not collect authenticated account data through AWM or install a newer CLI
as an AWM integration probe until the applicable terms or supported integration
path is established. An operator can independently choose to inspect their own
account with the documented official CLI, outside AWM, to answer the CLI output
contract question. That direct read would not authorize AWM to wrap the CLI.
For Gemini Enterprise, first establish an official public method schema and
sample response that expose the required quota facts; the existence of a quota
method name is not enough.

If the operator chooses the direct CLI check, collect only version, model-list,
and read-only usage output:

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
