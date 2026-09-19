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
