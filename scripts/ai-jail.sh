#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_path="$(realpath "${BASH_SOURCE[0]}")"

cd "$repo_root"

die() {
  echo "Error: $*" >&2
  exit 1
}

show_help() {
  cat <<EOF
Usage: $0 [tool] [command] [args...]

Tools:
  agy | antigravity   Run Antigravity CLI inside ai-jail (default)
  codex               Run Codex CLI inside ai-jail

Commands:
  run
      Launch a new interactive session inside ai-jail

  resume [id]
      Resume a session by ID (or continue if id omitted)

  resume:last
      Resume the most recent session (default)

  task <prompt-file> [args...]
      Run a prompt non-interactively.
      Useful directly or as the backend for 'schedule'.

  schedule <time> <prompt-file> [args...]
      Schedule a non-interactive task using 'at'.

  help
      Show this help message

Examples:
  $0 agy run
  $0 agy resume:last
  $0 agy resume <conversation-id>

  $0 codex run
  $0 codex resume:last
  $0 codex resume <session-id>

  $0 codex task prompt.md
  $0 agy task prompt.md

  $0 codex schedule 03:30 prompt.md
  $0 agy schedule 03:30 prompt.md

  $0 codex schedule "now + 5 hours" prompt.md
  $0                              (defaults to 'agy resume:last')
  $0 run

Scheduled-run logs are stored in:
  $repo_root/.ai-runs/

Useful 'at' commands:
  atq             List scheduled jobs
  atrm <job-id>   Remove a scheduled job
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

resolve_prompt_file() {
  local prompt_file="${1:-}"

  [[ -n "$prompt_file" ]] || die "missing prompt file"
  [[ -f "$prompt_file" ]] || die "prompt file not found: $prompt_file"

  realpath "$prompt_file"
}

schedule_task() {
  local selected_tool="$1"
  shift

  local schedule_time="${1:-}"
  local prompt_file="${2:-}"

  [[ -n "$schedule_time" ]] || \
    die "usage: $0 $selected_tool schedule <time> <prompt-file> [args...]"

  [[ -n "$prompt_file" ]] || \
    die "usage: $0 $selected_tool schedule <time> <prompt-file> [args...]"

  shift 2

  command -v at >/dev/null 2>&1 || {
    echo "'at' is not installed." >&2
    echo >&2
    echo "On Arch Linux:" >&2
    echo "  sudo pacman -S at" >&2
    echo "  sudo systemctl enable --now atd" >&2
    exit 1
  }

  prompt_file="$(resolve_prompt_file "$prompt_file")"

  local log_dir="$repo_root/.ai-runs"
  mkdir -p "$log_dir"

  local timestamp
  timestamp="$(date '+%Y%m%d-%H%M%S')"

  local log_file="$log_dir/${selected_tool}-${timestamp}-$$.log"

  # Build the command that the at job will execute.
  #
  # Example:
  #   /absolute/path/ai-jail.sh codex task /absolute/path/prompt.md
  local -a cmd=(
    "$script_path"
    "$selected_tool"
    task
    "$prompt_file"
    "$@"
  )

  local quoted_cmd
  printf -v quoted_cmd '%q ' "${cmd[@]}"

  local job_script

  if [[ "$selected_tool" == "agy" ]]; then
    # Antigravity's --print mode has historically had problems when started
    # completely detached from a TTY.
    #
    # util-linux "script" creates a PTY for it. /dev/null is used as the
    # typescript file; stdout/stderr are redirected to our own log.
    command -v script >/dev/null 2>&1 || \
      die "'script' from util-linux is required for scheduled agy tasks"

    printf -v job_script \
      'cd %q && exec script -qefc %q /dev/null > %q 2>&1\n' \
      "$repo_root" \
      "$quoted_cmd" \
      "$log_file"
  else
    # Codex exec is designed for headless/non-interactive execution.
    printf -v job_script \
      'cd %q && %s > %q 2>&1\n' \
      "$repo_root" \
      "$quoted_cmd" \
      "$log_file"
  fi

  local at_output

  if ! at_output="$(
    printf '%s' "$job_script" | at "$schedule_time" 2>&1
  )"; then
    echo "$at_output" >&2
    die "failed to schedule job"
  fi

  echo "$at_output"
  echo
  echo "Task scheduled successfully."
  echo
  echo "Tool:   $selected_tool"
  echo "Time:   $schedule_time"
  echo "Prompt: $prompt_file"
  echo "Repo:   $repo_root"
  echo "Log:    $log_file"
  echo
  echo "Pending jobs:"
  echo "  atq"
  echo
  echo "Follow this run:"
  printf '  tail -f %q\n' "$log_file"
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

if [[ "${1:-}" =~ ^(help|--help|-h)$ ]]; then
  show_help
fi

# ---------------------------------------------------------------------------
# Detect tool
# ---------------------------------------------------------------------------

# Default tool: Antigravity
tool="agy"

if [[ "${1:-}" == "codex" ]]; then
  tool="codex"
  shift
elif [[ "${1:-}" == "agy" || "${1:-}" == "antigravity" ]]; then
  tool="agy"
  shift
fi

subcommand="${1:-resume:last}"

case "$subcommand" in
  help|--help|-h)
    show_help
    ;;
esac

# ---------------------------------------------------------------------------
# Antigravity
# ---------------------------------------------------------------------------

case "$tool" in
  agy)
    mkdir -p "$HOME/.gemini" "$HOME/.config/gh"

    case "$subcommand" in

      # ---------------------------------------------------------------------
      # Interactive session
      # ---------------------------------------------------------------------

      run)
        shift || true

        exec ai-jail \
          --exec \
          --display \
          --x11 \
          --terminal-passthrough \
          --network \
          --systemd-user \
          --rw-map "$HOME/.gemini" \
          --rw-map "$HOME/.config/gh" \
          -- \
          agy \
          --dangerously-skip-permissions \
          "$@"
        ;;

      # ---------------------------------------------------------------------
      # Non-interactive task
      # ---------------------------------------------------------------------

      task)
        shift || true

        prompt_file="${1:-}"

        [[ -n "$prompt_file" ]] || \
          die "usage: $0 agy task <prompt-file> [agy-args...]"

        shift

        prompt_file="$(resolve_prompt_file "$prompt_file")"

        # Antigravity currently accepts the prompt through --print/-p.
        # It does not have the same stdin-based prompt mechanism as
        # `codex exec -`, so read the file and pass its contents as the
        # --print argument.
        prompt="$(cat "$prompt_file")"

        exec ai-jail \
          --exec \
          --terminal-passthrough \
          --network \
          --systemd-user \
          --rw-map "$HOME/.gemini" \
          --rw-map "$HOME/.config/gh" \
          -- \
          agy \
          --dangerously-skip-permissions \
          "$@" \
          --print "$prompt"
        ;;

      # ---------------------------------------------------------------------
      # Schedule
      # ---------------------------------------------------------------------

      schedule)
        shift || true
        schedule_task agy "$@"
        ;;

      # ---------------------------------------------------------------------
      # Resume
      # ---------------------------------------------------------------------

      resume)
        shift || true

        if [[ $# -gt 0 && "${1:-}" != -* ]]; then
          conv_id="$1"
          shift

          exec ai-jail \
            --exec \
            --display \
            --x11 \
            --terminal-passthrough \
            --network \
            --systemd-user \
            --rw-map "$HOME/.gemini" \
            --rw-map "$HOME/.config/gh" \
            -- \
            agy \
            --dangerously-skip-permissions \
            --conversation "$conv_id" \
            "$@"
        else
          exec ai-jail \
            --exec \
            --display \
            --x11 \
            --terminal-passthrough \
            --network \
            --systemd-user \
            --rw-map "$HOME/.gemini" \
            --rw-map "$HOME/.config/gh" \
            -- \
            agy \
            --dangerously-skip-permissions \
            --continue \
            "$@"
        fi
        ;;

      resume:last)
        shift || true

        exec ai-jail \
          --exec \
          --display \
          --x11 \
          --terminal-passthrough \
          --network \
          --systemd-user \
          --rw-map "$HOME/.gemini" \
          --rw-map "$HOME/.config/gh" \
          -- \
          agy \
          --dangerously-skip-permissions \
          --continue \
          "$@"
        ;;

      # ---------------------------------------------------------------------
      # Raw passthrough
      # ---------------------------------------------------------------------

      *)
        exec ai-jail \
          --exec \
          --display \
          --x11 \
          --terminal-passthrough \
          --network \
          --systemd-user \
          --rw-map "$HOME/.gemini" \
          --rw-map "$HOME/.config/gh" \
          -- \
          agy \
          --dangerously-skip-permissions \
          "$@"
        ;;
    esac
    ;;

  # -------------------------------------------------------------------------
  # Codex
  # -------------------------------------------------------------------------

  codex)
    mkdir -p "$HOME/.codex" "$HOME/.config/gh"

    case "$subcommand" in

      # ---------------------------------------------------------------------
      # Interactive session
      # ---------------------------------------------------------------------

      run)
        shift || true

        exec ai-jail \
          --exec \
          --display \
          --x11 \
          --terminal-passthrough \
          --network \
          --systemd-user \
          --rw-map "$HOME/.codex" \
          --rw-map "$HOME/.config/gh" \
          -- \
          codex \
          --dangerously-bypass-approvals-and-sandbox \
          "$@"
        ;;

      # ---------------------------------------------------------------------
      # Non-interactive task
      # ---------------------------------------------------------------------

      task)
        shift || true

        prompt_file="${1:-}"

        [[ -n "$prompt_file" ]] || \
          die "usage: $0 codex task <prompt-file> [codex-exec-args...]"

        shift

        prompt_file="$(resolve_prompt_file "$prompt_file")"

        # `codex exec -` reads the prompt from stdin.
        exec ai-jail \
          --exec \
          --network \
          --systemd-user \
          --rw-map "$HOME/.codex" \
          --rw-map "$HOME/.config/gh" \
          -- \
          codex \
          --dangerously-bypass-approvals-and-sandbox \
          exec \
          "$@" \
          - < "$prompt_file"
        ;;

      # ---------------------------------------------------------------------
      # Schedule
      # ---------------------------------------------------------------------

      schedule)
        shift || true
        schedule_task codex "$@"
        ;;

      # ---------------------------------------------------------------------
      # Resume
      # ---------------------------------------------------------------------

      resume)
        shift || true

        exec ai-jail \
          --exec \
          --display \
          --x11 \
          --terminal-passthrough \
          --network \
          --systemd-user \
          --rw-map "$HOME/.codex" \
          --rw-map "$HOME/.config/gh" \
          -- \
          codex \
          --dangerously-bypass-approvals-and-sandbox \
          resume \
          "$@"
        ;;

      resume:last)
        shift || true

        exec ai-jail \
          --exec \
          --display \
          --x11 \
          --terminal-passthrough \
          --network \
          --systemd-user \
          --rw-map "$HOME/.codex" \
          --rw-map "$HOME/.config/gh" \
          -- \
          codex \
          --dangerously-bypass-approvals-and-sandbox \
          resume \
          --last \
          "$@"
        ;;

      # ---------------------------------------------------------------------
      # Raw passthrough
      # ---------------------------------------------------------------------

      *)
        exec ai-jail \
          --exec \
          --display \
          --x11 \
          --terminal-passthrough \
          --network \
          --systemd-user \
          --rw-map "$HOME/.codex" \
          --rw-map "$HOME/.config/gh" \
          -- \
          codex \
          --dangerously-bypass-approvals-and-sandbox \
          "$@"
        ;;
    esac
    ;;
esac
