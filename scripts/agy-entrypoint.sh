#!/bin/sh
set -eu

if [ "${AWM_ANTIGRAVITY_ENABLED:-false}" != "true" ]; then
  exec node dist/src/index.js "$@"
fi

runtime_dir="${XDG_RUNTIME_DIR:-/tmp/awm-antigravity-runtime}"
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
export XDG_RUNTIME_DIR="$runtime_dir"

if [ "${AWM_ANTIGRAVITY_DBUS_SESSION:-}" != "1" ]; then
  exec dbus-run-session -- env AWM_ANTIGRAVITY_DBUS_SESSION=1 "$0" "$@"
fi

agy_home="${AWM_ANTIGRAVITY_HOME:-/antigravity-state}"
agy_keyring_home="${AWM_ANTIGRAVITY_KEYRING_HOME:-/antigravity-keyring}"
export HOME="$agy_home"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$agy_home/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$agy_home/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$agy_home/.cache}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$agy_home/.local/state}"

mkdir -p "$HOME" "$agy_keyring_home" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
chmod 700 "$HOME" "$agy_keyring_home" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"

keyrings_dir="$XDG_DATA_HOME/keyrings"
if [ -L "$keyrings_dir" ]; then
  if [ "$(readlink "$keyrings_dir")" != "$agy_keyring_home" ]; then
    echo 'Antigravity keyring link points outside its dedicated state volume' >&2
    exit 1
  fi
elif [ -e "$keyrings_dir" ]; then
  if [ ! -d "$keyrings_dir" ] || [ -n "$(find "$keyrings_dir" -mindepth 1 -print -quit)" ]; then
    echo 'Existing Antigravity keyring data needs an explicit safe migration' >&2
    exit 1
  fi
  rmdir "$keyrings_dir"
fi
if [ ! -e "$keyrings_dir" ]; then
  ln -s "$agy_keyring_home" "$keyrings_dir"
fi

if ! gnome-keyring-daemon --start --components=secrets >/dev/null 2>&1; then
  echo 'Antigravity keyring service could not start' >&2
  exit 1
fi

keyring_secret_file="${AWM_ANTIGRAVITY_KEYRING_SECRET_FILE:-}"
if [ -n "$keyring_secret_file" ]; then
  case "$keyring_secret_file" in
    /run/secrets/*) ;;
    *)
      echo 'Antigravity keyring secret must be mounted below /run/secrets' >&2
      exit 1
      ;;
  esac
  if [ ! -f "$keyring_secret_file" ] || [ ! -r "$keyring_secret_file" ]; then
    echo 'Antigravity keyring secret mount is unavailable' >&2
    exit 1
  fi
  if ! gnome-keyring-daemon --unlock < "$keyring_secret_file" >/dev/null 2>&1; then
    echo 'Antigravity keyring unlock failed' >&2
    exit 1
  fi
  unset AWM_ANTIGRAVITY_KEYRING_SECRET_FILE
fi

exec node dist/src/index.js "$@"
