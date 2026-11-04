#!/bin/sh
# Operator-only entry to the official Claude Code CLI inside the AWM container:
#   docker compose exec ai-window-manager claude-code-cli auth login
# Sign-in stays in the official CLI; AWM never relays Claude.ai codes or tokens.
# Only account commands are allowed so the dedicated state volume is not used
# for interactive sessions, and Claude Code's own updater stays disabled.
set -eu

case "${1:-}" in
  auth)
    case "${2:-}" in
      login | logout | status) ;;
      *)
        echo "usage: claude-code-cli auth {login|logout|status} [options]" >&2
        exit 2
        ;;
    esac
    ;;
  --version) ;;
  *)
    echo "usage: claude-code-cli auth {login|logout|status} [options] | --version" >&2
    exit 2
    ;;
esac

home="${AWM_CLAUDE_CODE_HOME:-/claude-state}"
executable="${AWM_CLAUDE_CODE_EXECUTABLE:-/provider-clients/claude_code/current}"
if [ ! -x "$executable" ]; then
  executable=/opt/claude-code/bin/claude
fi

exec env -i \
  PATH=/usr/local/bin:/usr/bin:/bin \
  HOME="$home" \
  CLAUDE_CONFIG_DIR="$home" \
  TERM="${TERM:-xterm-256color}" \
  LANG="${LANG:-C.UTF-8}" \
  DISABLE_AUTOUPDATER=1 \
  DISABLE_UPDATES=1 \
  CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
  "$executable" "$@"
