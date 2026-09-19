# Provider evidence convention

Every externally derived fact must carry enough provenance to answer “why do we believe this?”

Contract classifications:

- `official_supported`: public provider documentation or a documented official client protocol/command intended for use.
- `official_client_internal`: behavior visible in official open-source client code but not promised as a public contract.
- `observed`: empirically observed behavior/format.
- `inferred`: derived from other known facts.
- `manual`: user-provided fact.
- `unknown`: no defensible claim.

Confidence is independent from source: `exact`, `high`, `medium`, `low`, `unknown`.

Never upgrade observed behavior to supported merely because it appears stable.
