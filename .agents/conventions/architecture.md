# Architecture conventions

Mandatory direction of dependency:

```text
provider observation -> normalized domain -> scheduler decision -> provider action
```

- Domain must not import Fastify, SQLite, child-process details, or provider-specific code.
- Scheduler consumes normalized observations + capabilities + persisted intents.
- Adapters implement transport/parsing/auth integration and return normalized observations.
- HTTP/UI reads application services, never provider credentials.
- Storage owns transactions and migrations, not scheduling rules.
