#!/bin/sh
# Operator-only manual fallback to the official Claude Code CLI inside AWM:
#   docker compose exec ai-window-manager claude-code-cli auth login
# Use this if Settings-based sign-in is unavailable or you prefer to keep the
# browser-returned code entirely outside the AWM process.
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
