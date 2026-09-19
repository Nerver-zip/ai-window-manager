# ADR-006 — Official client-owned authentication

Status: Accepted with provider spikes required

Do not implement provider OAuth/token refresh independently and do not mount a workstation home. Prefer dedicated official-client state/auth flows. Direct internal backend auth replay is rejected by default. Antigravity login may only be used through the official `agy` CLI; token extraction/internal backend impersonation is prohibited by project policy.
