# Product boundaries

## The product

AI Window Manager is a private, self-hosted usage-window daemon. Its responsibility is intentionally narrow:

1. observe provider quota/window state;
2. normalize what is known and how confidently it is known;
3. calculate window timing/recommendations;
4. perform a minimal action only where provider support/compliance is defensible and the user opted in;
5. record the outcome;
6. expose current state, history, metrics and configuration.

## Explicitly out of scope

- agent orchestration or model routing;
- prompts/conversations/memories;
- automatic task distribution between models;
- universal LLM/API proxy;
- billing platform;
- account rotation, identity fabrication or traffic hiding;
- increasing/bypassing quota or anti-abuse systems;
- generic distributed scheduler;
- public multi-user SaaS;
- Grafana-like observability suite;
- LLM/ML recommendations;
- Kubernetes, message brokers, Redis and Postgres for the MVP.

A new feature that does not improve window observation, timing, safe action, history, configuration or operability belongs elsewhere.

The CLI conversation created by an AWM trigger is a disposable transport
artifact, not product conversation history. AWM never stores transcript or
response text. It retains an opaque conversation/thread ID only as a bounded
cleanup obligation until deletion succeeds. Codex cleanup uses official
`thread/delete`. Antigravity cleanup is narrowly scoped to the exact
conversation-ID files/directories inside AWM's dedicated CLI home; it is not an
official deletion API and must never touch authentication, shared indexes, or
unrelated IDs.

The web console is for one self-hosted operator and always requires native AWM
authentication. Network placement (trusted LAN, VPN/Tailscale or HTTPS proxy)
is a deployment choice, not an authentication bypass. Multi-user accounts and
public Internet SaaS remain out of scope.
