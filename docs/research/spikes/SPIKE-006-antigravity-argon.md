# SPIKE-006 — Gemini 4 Argon quota identity and CLI compatibility

**Research checked:** 2026-10-20

**Status:** Argon weekly quota identity is observed from operator-provided Pro account output and independently matches the official CLI 1.4.3 bucket shape. Argon trigger effect remains unverified. The operator authorized continued official-CLI wrapper implementation on 2026-10-20; that authorization does not establish Google approval under the applicable terms.

**Scope:** Official documentation, release metadata, isolated CLI reads without an explicit login, and operator-provided account output. No model prompt was sent.

## Conclusion

Argon is an officially supported Antigravity CLI model on eligible plans. The
public documentation does not specify an Argon quota schema or reset
semantics. However, the operator-provided Google AI Pro CLI 1.4.2 output shows
a distinct Argon quota row with a weekly reset, and an isolated official CLI
1.4.3 JSON read exposes the exact bucket ID
`gemini-argon-wtu-weekly` with `window: weekly`. The isolated probe's account
identity was not established, so only the operator-provided 1.4.2 output is
account-specific evidence.

The official FAQ warns that third-party access violates the Antigravity Terms
of Service and says wrapping headless `agy -p` is unsupported under consumer
plans. The operator identified the account as Google AI Pro and authorized this
implementation. This authorizes the project work; it is not Google approval.

The adapter recognizes only the exact provider bucket ID
`gemini-argon-wtu-weekly` with `window: weekly`, mapping it to
`antigravity_argon_weekly` regardless of group order or display name. Other
Argon-like bucket identities are retained as observed-only windows with a
deterministic opaque identity derived from their validated ID and cadence.
Their phase and confidence are `UNKNOWN`; they cannot become a canonical
Gemini/Argon policy target or trigger. This keeps known Gemini and Claude/GPT
observations fresh if the CLI adds or changes an Argon bucket. No Argon
five-hour target is established or exposed. The representative fixture at
[`tests/fixtures/providers/antigravity/usage/usage-json.argon-weekly.json`](../../../tests/fixtures/providers/antigravity/usage/usage-json.argon-weekly.json)
preserves the observed names, bucket ID, and window with synthetic ratios and
2030 reset timestamps; it is a parser fixture, not raw account output.

The Argon schedule starts in manual mode, requires review, and has no target.
An Argon prompt can be advertised only when the global Antigravity gate, the
Argon-specific default-off gate, and one of the exact allowlisted Argon model
slugs are all enabled. No live AWM Argon prompt or quota-consuming acceptance
was performed; any post-dispatch ambiguity remains uncertain without retry.

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

The [Antigravity FAQ](https://antigravity.google/docs/faq/) says headless
`agy -p` is intended for direct scripting/CI and wrapping it in a third-party
application is unsupported under consumer plans. The operator identified the
account as Google AI Pro and authorized this implementation; this does not
claim Google approval.

## CLI release compatibility

The pre-change Antigravity pin was CLI 1.3.3. The project's official-release
resolver returned stable release 1.4.3, published 2026-10-20T04:28:40Z, during
the compatibility probe. Earlier checks that day returned 1.4.2. The resolver
returned these GitHub-published asset digests:

| Architecture | Asset                        | SHA-256                                                            |
| ------------ | ---------------------------- | ------------------------------------------------------------------ |
| amd64        | `agy_cli_linux_x64.tar.gz`   | `319b2cb3240d244930bd077033b466941fd7ba6f0881d783eee801dbd2fb9371` |
| arm64        | `agy_cli_linux_arm64.tar.gz` | `045aa7112f574ef97f8320a65d30a555c4ce9bdd5e3d56d40fce7e262ca98cda` |

The existing official archive downloader fetched the fixed 1.4.3 amd64 asset
into a temporary directory. Its published SHA-256 was verified before
extracting the single regular-file executable, with bounded entry count,
expanded size, and path checks. This isolated probe did not replace the
packaged or active runtime. There is no Docker daemon on this host.

With a new empty home and auto-update disabled, the read-only commands were:

```sh
agy --version
agy --help
agy models
```

`agy --version` returned `1.4.3`; `agy --help` and plain `agy models` exited
successfully. The model listing included:

```text
gemini-4-argon-medium  Gemini 4 Argon (Medium)
gemini-4-argon-high    Gemini 4 Argon (High)
gemini-4-argon-low     Gemini 4 Argon (Low)
```

This proves these slugs are returned by the isolated CLI's model
discovery; it does not establish the Pro account's entitlement or quota
mapping. `agy models --output-format json` exited 1 because this subcommand
does not accept that flag. Capture the plain tab-separated model listing.
The separate structured `/usage` check is recorded below. No normal model
prompt was sent.

### Pinned 1.3.3 baseline without credentials

The existing pinned 1.3.3 archive digest was verified against official GitHub
release metadata and installed through AWM's official downloader and bounded
runtime-store extractor in a fresh empty home. With auto-update disabled, no
D-Bus/auth environment, and `/dev/null` stdin, `agy --version` returned
`1.3.3`; `agy --help` succeeded. `agy models` exited 1 with
`Please sign in to view available models.` No credentials, sign-in, model
prompt, or quota action was used. Thus authenticated Argon discovery under
1.3.3 remains unverified.

## Quota evidence

### Isolated official CLI 1.4.3 structured read

The fixed 1.4.3 amd64 executable ran with an empty `HOME`, a minimal
environment, and no explicit login or credentials:

```text
agy -p '/usage' --output-format json
```

It returned `status: SUCCESS`, `command.name: usage`, zero turns and zero
token usage, with three groups and five buckets. The `Gemini 4 Argon` group
contained exactly one observed bucket, ID `gemini-argon-wtu-weekly`, with
`window: weekly`. `Gemini Models` and `Claude and GPT models` each contained
weekly and `5h` buckets. No Argon five-hour bucket appeared in this output.
The probe's account identity was not established, so this is structural CLI
evidence, not a reading from the operator's Pro account. The representative
fixture [`usage-json.argon-weekly.json`](../../../tests/fixtures/providers/antigravity/usage/usage-json.argon-weekly.json)
preserves the observed names, ID and window with synthetic ratios and reset
timestamps.

The official `/usage` documentation describes refreshing the quota view. The
official CLI changelog says read-only print-mode commands such as `/usage` can
return structured output without starting an agent turn or spending quota.
Google does not document the nested group/bucket object as a versioned schema.

### Operator-provided Google AI Pro CLI 1.4.2 output

The operator supplied plain model-list and `/usage` output from their Pro
account. `agy models` listed these exact model and display-name pairs:

```text
gemini-4-argon-medium  Gemini 4 Argon (Medium)
gemini-4-argon-high    Gemini 4 Argon (High)
gemini-4-argon-low     Gemini 4 Argon (Low)
```

Their `/usage` output contained three groups and five buckets. Its Argon row
reported 33% remaining and a weekly reset of `2026-10-24 22:16 -03`. The
reported Gemini readings of 87% weekly and 97% five-hour remaining also match
the separate structured-probe reading. That agreement
does not identify the separate probe's account; no values from it are
attributed to the Pro account here. This single operator-provided snapshot
confirms Argon weekly visibility for that account, not a moving reset
transition or trigger effect.

## Evidence matrix

| Property                                        | Evidence                                                          | Confidence / limit                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Argon model availability                        | Official model page; operator Pro model list and quota display    | Target account exposes Argon quota and model choices; a prompt was not tested                                              |
| Documented model slugs                          | Official headless guide; CLI 1.4.3 and operator 1.4.2 model lists | `gemini-4-argon-high`, `medium`, and `low` observed; availability depends on eligible plan                                 |
| Argon bucket ID                                 | CLI 1.4.3 JSON probe                                              | `gemini-argon-wtu-weekly`; operator CLI 1.4.2 text separately confirms the family and weekly cadence, without exposing IDs |
| Weekly Argon window                             | CLI 1.4.3 JSON probe; operator Pro CLI 1.4.2 output               | `window: weekly`; operator reported 33% remaining in one snapshot                                                          |
| Argon five-hour bucket                          | Neither recorded output showed one                                | Not established; no five-hour Argon target is supported                                                                    |
| Reset timestamp meaning                         | Operator Pro CLI 1.4.2 snapshot                                   | `2026-10-24 22:16 -03`; one point, cycle transition semantics unknown                                                      |
| Isolated 1.4.3 probe identity                   | Empty home/minimal environment; no explicit login                 | Account identity not established; values are not attributed to Pro account                                                 |
| Argon request's quota effect                    | No live Argon prompt sent                                         | Unknown; the request effect was not observed                                                                               |
| Target account and implementation authorization | Operator confirmation on 2026-10-20                               | Google AI Pro; continued wrapper implementation authorized by the operator                                                 |

## Remaining implementation and acceptance gates

The read-only identity gate is satisfied for the observed weekly target:
operator-provided Pro CLI 1.4.2 output identifies Argon weekly usage, and the
isolated 1.4.3 JSON response supplies the bucket ID and field shape. The
schema remains an official-client output contract, not a public versioned API;
the parser maps only the exact observed bucket to the canonical Argon target
and keeps unknown Argon-like buckets under opaque observed-only identities. No
five-hour Argon target is inferred or trigger-supported.

The Argon integration passes offline validation and browser acceptance;
PR/operator review remains required. The policy is seeded as manual, review-required, and
without a target; existing saved policy choices must survive migration 014.
The Argon-specific trigger gate defaults to false, and selecting a valid model
does not override the global gate or provider automation mode. `/usage` output
does not establish trigger effects.

## Trigger and lifecycle limits

The official documentation and CLI output establish the listed Argon model
slugs, but do not prove that an Argon request independently changes an Argon
quota window. Existing Gemini and Claude/GPT trigger experiments do not
establish Argon behavior. No live Argon trigger request was performed by this
research; the Argon-specific capability remains disabled by default.

## Offline acceptance

`pnpm validate` passed on 2026-10-20: 84 test files and 1,300 tests, production
build, formatting, lint, strict typecheck and Gitleaks. Global coverage was
94.86% statements, 90.58% branches, 97.26% functions and 96.45% lines. An
additional working-tree Gitleaks scan found no leaks; dependency audit found
no known vulnerabilities. Compose configuration passed. A local image build
could not start because the host has no Docker socket; image/smoke acceptance
is delegated to the PR's existing CI gates and must be checked there.

[Browser evidence](../evidence/argon/README.md) records twelve page/viewport
captures with synthetic data, native login, independent weekly Argon scope,
soft saves, and saved-policy persistence across restart. No provider prompt
was sent and no production deployment occurred.

Only the Antigravity CLI pin changes in this feature. Existing Gemini and
Claude/GPT model defaults are preserved. The new model list does not contain
the existing `claude-sonnet-4-6` default; its live compatibility with 1.4.3
remains unverified. This change does not silently choose a replacement.
