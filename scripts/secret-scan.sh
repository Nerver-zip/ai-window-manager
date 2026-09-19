#!/usr/bin/env sh
set -eu

if ! command -v gitleaks >/dev/null 2>&1; then
  echo 'gitleaks is required for secret:scan; install it from https://github.com/gitleaks/gitleaks' >&2
  exit 127
fi

exec gitleaks detect --source . --config .gitleaks.toml --no-banner --redact "$@"
