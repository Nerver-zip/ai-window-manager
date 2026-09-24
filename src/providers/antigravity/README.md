# Antigravity read-only adapter

This directory contains the monitor-only adapter for the official `agy` CLI.
It invokes only the documented headless usage command:

```text
agy -p /usage --output-format json --print-timeout 30s
```

The command path is injected by the caller and is executed without a shell.
The adapter validates the bounded JSON envelope, keeps Gemini and Claude/GPT
quota groups separate, and normalizes only the remaining percentage and a
provider-reported reset timestamp when it is valid and reasonable.

Authentication remains owned by the official CLI. This adapter never reads
credential files, parses tokens, calls provider endpoints, sends prompts, or
implements a trigger. `windowTrigger.supported` is always `false` and its
quota impact is `unknown`.
