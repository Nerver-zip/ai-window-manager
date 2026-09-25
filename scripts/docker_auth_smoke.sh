#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly COMPOSE_FILE="${REPO_ROOT}/compose.yaml"
readonly CI_AUTH_USERNAME='awm-ci-operator'
readonly CI_AUTH_PASSWORD='awm-ci-synthetic-password-2026'
readonly HEALTH_ATTEMPTS=60
readonly REQUEST_TIMEOUT_SECONDS=15
readonly MAIN_SHELL_PID="$BASHPID"

if ! command -v docker >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' 'docker-auth-smoke: Docker and curl are required' >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'docker-auth-smoke: Python 3 is required for isolated test helpers' >&2
  exit 1
fi

run_id="${GITHUB_RUN_ID:-local}"
run_attempt="${GITHUB_RUN_ATTEMPT:-0}"
project_name="awm-auth-smoke-${run_id}-${run_attempt}-$$"
if [[ ! "$project_name" =~ ^awm-auth-smoke-[a-zA-Z0-9_-]+$ ]]; then
  printf '%s\n' 'docker-auth-smoke: refusing a non-disposable Compose project name' >&2
  exit 1
fi
if [[ -n "${AWM_AUTH_SMOKE_PREBUILT_IMAGE:-}" ]]; then
  smoke_image="$AWM_AUTH_SMOKE_PREBUILT_IMAGE"
  docker image inspect "$smoke_image" >/dev/null 2>&1 || {
    printf '%s\n' 'docker-auth-smoke: requested prebuilt image is not available locally' >&2
    exit 1
  }
  remove_smoke_image=false
else
  smoke_image="ai-window-manager:auth-smoke-${run_id}-${run_attempt}-$$"
  remove_smoke_image=true
fi

host_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
readonly BASE_URL="http://127.0.0.1:${host_port}"
readonly EXPECTED_ORIGIN="$BASE_URL"
readonly TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/awm-auth-smoke.XXXXXX")"
readonly COOKIE_JAR="${TEMP_DIR}/cookies.txt"
readonly RESPONSE_BODY="${TEMP_DIR}/response.body"
readonly RESPONSE_HEADERS="${TEMP_DIR}/response.headers"
readonly RESPONSE_STATUS="${TEMP_DIR}/response.status"
readonly LOG_FILE="${TEMP_DIR}/compose.log"
: >"$COOKIE_JAR"

compose() {
  docker compose --project-name "$project_name" --env-file /dev/null -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local status=$?
  [[ "$BASHPID" == "$MAIN_SHELL_PID" ]] || return "$status"
  trap - EXIT
  set +e
  compose down --volumes --remove-orphans >/dev/null 2>&1
  if [[ "$remove_smoke_image" == true ]]; then
    docker image rm "$smoke_image" >/dev/null 2>&1 || true
  fi
  rm -r -- "$TEMP_DIR"
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'docker-auth-smoke: %s\n' "$1" >&2
  compose ps >&2 || true
  exit 1
}

# Keep the disposable CI stack isolated from any operator .env, real provider
# clients, and quota-consuming actions. The temporary hash is only a Compose
# interpolation placeholder while the image is built; it is never run.
export COMPOSE_PROJECT_NAME="$project_name"
export AWM_IMAGE="$smoke_image"
export AWM_HOST_BIND='127.0.0.1'
export AWM_HOST_PORT="$host_port"
export AWM_AUTH_USERNAME="$CI_AUTH_USERNAME"
export AWM_AUTH_PASSWORD_HASH='ci-build-placeholder-not-a-password-hash'
export AWM_AUTH_SESSION_TTL_SECONDS='900'
export AWM_TRUST_PROXY=''
export AWM_FAKE_PROVIDER_ENABLED='true'
export AWM_CODEX_ENABLED='false'
export AWM_CODEX_TRIGGER_ENABLED='false'
export AWM_ANTIGRAVITY_ENABLED='false'
export AWM_ANTIGRAVITY_TRIGGER_ENABLED='false'
export AWM_ANTIGRAVITY_KEYRING_SECRET_FILE=''
export AWM_LOG_LEVEL='info'
export AWM_RECONCILE_INTERVAL_SECONDS='30'
export AWM_EXECUTOR_INTERVAL_SECONDS='5'

cd "$REPO_ROOT"
if [[ "$remove_smoke_image" == true ]]; then
  compose build ai-window-manager
else
  printf 'docker-auth-smoke: exercising local image %s without rebuilding\n' "$smoke_image"
fi

# Generate a real Argon2id PHC value inside the just-built runtime image. The
# synthetic password travels only over stdin; neither it nor the hash is echoed.
image_ref="$(compose config --images | sed -n '1p')"
[[ -n "$image_ref" ]] || fail 'Compose did not resolve an application image'
image_id="$(docker image inspect --format '{{.Id}}' "$image_ref")"
hash_script='import { hash, Algorithm, Version } from "@node-rs/argon2";
let password = "";
for await (const chunk of process.stdin) password += chunk;
if (!password) process.exit(2);
const encoded = await hash(password, {
  algorithm: Algorithm.Argon2id,
  version: Version.V0x13,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
});
password = "";
process.stdout.write(encoded);'
generated_hash="$(printf '%s' "$CI_AUTH_PASSWORD" | docker run \
  --rm --interactive \
  --network none \
  --read-only \
  --tmpfs /tmp:size=16m,mode=1777 \
  --user 10001:10001 \
  --entrypoint node \
  "$image_id" --input-type=module -e "$hash_script")"
[[ "$generated_hash" =~ ^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$ ]] || \
  fail 'the runtime image did not produce an Argon2id PHC hash'
export AWM_AUTH_PASSWORD_HASH="$generated_hash"

# Compose interpolation of a PHC string containing multiple '$' characters is
# verified by the browser-style login below, not by printing resolved config.
compose config --quiet
compose up -d --no-build

wait_for_health() {
  local attempt status
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
    status="$(curl --silent --show-error --connect-timeout 2 --max-time 4 \
      --output "$RESPONSE_BODY" --write-out '%{http_code}' "${BASE_URL}/healthz" 2>/dev/null || true)"
    if [[ "$status" == '200' ]] && python3 - "$RESPONSE_BODY" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as response:
        valid = json.load(response) == {"status": "ok"}
except (OSError, ValueError):
    valid = False
sys.exit(0 if valid else 1)
PY
    then
      return 0
    fi
    sleep 1
  done
  fail 'the service did not become healthy within the readiness window'
}

request_code() {
  local path="$1"
  shift
  curl --silent --show-error --max-time "$REQUEST_TIMEOUT_SECONDS" \
    --dump-header "$RESPONSE_HEADERS" \
    --output "$RESPONSE_BODY" \
    --write-out '%{http_code}\n' \
    "$@" "${BASE_URL}${path}"
}

assert_status() {
  local expected="$1" actual="$2" method="$3" path="$4"
  [[ "$actual" == "$expected" ]] || \
    fail "${method} ${path} returned HTTP ${actual}; expected ${expected}"
}

assert_auth_error_body() {
  python3 - "$RESPONSE_BODY" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as response:
        payload = json.load(response)
except (OSError, ValueError):
    sys.exit(1)
sys.exit(0 if payload.get("error", {}).get("code") == "AUTH_REQUIRED" else 1)
PY
}

assert_http_session_cookie() {
  python3 - "$RESPONSE_HEADERS" "$COOKIE_JAR" <<'PY'
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as response:
        headers = response.read().splitlines()
    with open(sys.argv[2], encoding="utf-8") as jar:
        cookie_lines = jar.read().splitlines()
except OSError:
    sys.exit(1)

session_headers = []
for line in headers:
    if not line.lower().startswith("set-cookie:"):
        continue
    value = line.split(":", 1)[1].strip()
    name = value.split("=", 1)[0].lower()
    attributes = {part.strip().lower() for part in value.split(";")[1:]}
    if name == "awm_session" and "httponly" in attributes:
        session_headers.append((name, attributes))

valid_header = any(
    "path=/" in attributes
    and "samesite=strict" in attributes
    and not any(attribute.startswith("domain=") for attribute in attributes)
    and "secure" not in attributes
    for _, attributes in session_headers
)
valid_jar = any(
    line.startswith("#HttpOnly_") and len(line.split("\t")) >= 7
    and line.split("\t")[5] == "awm_session"
    for line in cookie_lines
)
sys.exit(0 if valid_header and valid_jar else 1)
PY
}

assert_timezone_persisted() {
  local expected="$1"
  python3 - "$RESPONSE_BODY" "$expected" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as response:
        payload = json.load(response)
except (OSError, ValueError):
    sys.exit(1)

settings = payload.get("settings", [])
matches = [
    setting
    for setting in settings
    if setting.get("key") == "timezone" and setting.get("value") == sys.argv[2]
]
sys.exit(0 if matches else 1)
PY
}

csrf_token_from_cookiejar() {
  python3 - "$COOKIE_JAR" <<'PY'
import re
import sys

cookie_jar = sys.argv[1]
csrf_token = ""
try:
    with open(cookie_jar, encoding="utf-8") as jar_file:
        for line in jar_file:
            if line.startswith("#HttpOnly_"):
                line = line[len("#HttpOnly_"):]
            elif line.startswith("#"):
                continue
            fields = line.rstrip("\r\n").split("\t")
            if len(fields) >= 7 and fields[5] == "awm_csrf":
                csrf_token = fields[6]
except OSError:
    sys.exit(1)

if not re.fullmatch(r"[A-Za-z0-9_-]{43}", csrf_token):
    sys.exit(1)
print(csrf_token)
PY
}

assert_fake_only_provider_state() {
  python3 - "$RESPONSE_BODY" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as response:
        payload = json.load(response)
except (OSError, ValueError):
    sys.exit(1)

providers = payload.get("providers", [])
ids = {provider.get("id") for provider in providers}
sys.exit(0 if "fake" in ids and not ids.intersection({"codex", "antigravity"}) else 1)
PY
}

login_operator() {
  local status csrf
  status="$(request_code '/login?next=%2Fschedule' --cookie "$COOKIE_JAR" \
    --cookie-jar "$COOKIE_JAR")"
  assert_status '200' "$status" 'GET' '/login'
  csrf="$(csrf_token_from_cookiejar)" || \
    fail 'login page did not issue a CSRF cookie'
  [[ "$csrf" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail 'login page did not issue a valid CSRF cookie'

  status="$(printf 'username=%s&password=%s&csrfToken=%s&next=%s' \
    "$CI_AUTH_USERNAME" "$CI_AUTH_PASSWORD" "$csrf" '/schedule' |
    request_code '/login' \
      --cookie "$COOKIE_JAR" \
      --cookie-jar "$COOKIE_JAR" \
      --request POST \
      --header "Origin: ${EXPECTED_ORIGIN}" \
      --header 'Content-Type: application/x-www-form-urlencoded' \
      --data-binary @-)"
  if [[ ! "$status" =~ ^[23][0-9][0-9]$ ]]; then
    fail "browser-style operator login returned HTTP ${status}"
  fi
  assert_http_session_cookie || fail 'successful login did not issue the expected HttpOnly session cookie'
}

wait_for_health
compose ps

status="$(request_code '/healthz')"
assert_status '200' "$status" 'GET' '/healthz'

status="$(request_code '/')"
assert_status '303' "$status" 'GET' '/'
tr -d '\r' <"$RESPONSE_HEADERS" | \
  grep -Eiq '^location:[[:space:]]*(https?://[^/]+)?/login([?]|$)' || \
  fail 'anonymous HTML navigation did not redirect to /login'

status="$(request_code '/api/v1/providers')"
assert_status '401' "$status" 'GET' '/api/v1/providers'
assert_auth_error_body || fail 'anonymous providers response was not the bounded AUTH_REQUIRED JSON error'

status="$(request_code '/metrics')"
assert_status '401' "$status" 'GET' '/metrics'

status="$(request_code '/assets/app.css')"
assert_status '200' "$status" 'GET' '/assets/app.css'

login_operator

for path in / /usage /schedule /logs /settings /logout; do
  status="$(request_code "$path" --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR")"
  assert_status '200' "$status" 'GET' "$path"
done

for path in /api/v1/providers /api/v1/settings /api/v1/scheduling /api/v1/usage /api/v1/history; do
  status="$(request_code "$path" --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR")"
  assert_status '200' "$status" 'GET' "$path"
done
status="$(request_code '/api/v1/providers' --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR")"
assert_status '200' "$status" 'GET' '/api/v1/providers'
assert_fake_only_provider_state || fail 'the isolated smoke stack did not expose only its synthetic FakeProvider'

status="$(request_code '/metrics' --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR")"
assert_status '200' "$status" 'GET' '/metrics'
[[ -s "$RESPONSE_BODY" ]] || fail 'authenticated /metrics returned an empty response'

# A valid same-origin session without a CSRF form/header token must not reach
# the schedule mutation handler.
status="$(printf '' | request_code '/schedule' \
  --cookie "$COOKIE_JAR" \
  --request POST \
  --header "Origin: ${EXPECTED_ORIGIN}" \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-binary @-)"
assert_status '403' "$status" 'POST' '/schedule'
python3 - "$RESPONSE_BODY" <<'PY' || fail 'protected mutation without CSRF was not rejected as CSRF_REJECTED'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as response:
        payload = json.load(response)
except (OSError, ValueError):
    sys.exit(1)
sys.exit(0 if payload.get("error", {}).get("code") == "CSRF_REJECTED" else 1)
PY

# Persist a harmless test-only preference so restart checks prove that SQLite
# state survives independently of the intentionally volatile web session.
csrf_value="$(csrf_token_from_cookiejar)" || fail 'authenticated session has no valid CSRF cookie'
[[ -n "$csrf_value" ]] || fail 'authenticated session has an empty CSRF cookie'
request_code '/settings/timezone' \
  --cookie "$COOKIE_JAR" \
  --cookie-jar "$COOKIE_JAR" \
  --request POST \
  --header "Origin: ${EXPECTED_ORIGIN}" \
  --data-urlencode 'timezone=UTC' \
  --data-urlencode "csrfToken=${csrf_value}" >"$RESPONSE_STATUS"
IFS= read -r status <"$RESPONSE_STATUS" || fail 'settings mutation returned no HTTP status'
if [[ ! "$status" =~ ^[23][0-9][0-9]$ ]]; then
  fail "authenticated CSRF-protected settings mutation returned HTTP ${status}"
fi

status="$(request_code '/api/v1/settings' --cookie "$COOKIE_JAR")"
assert_status '200' "$status" 'GET' '/api/v1/settings'
assert_timezone_persisted 'UTC' || fail 'the test-only preference was not persisted before restart'

docker compose --project-name "$project_name" --env-file /dev/null -f "$COMPOSE_FILE" \
  restart ai-window-manager
wait_for_health
status="$(request_code '/api/v1/providers' --cookie "$COOKIE_JAR")"
assert_status '401' "$status" 'GET after restart' '/api/v1/providers'
assert_auth_error_body || fail 'the pre-restart session remained valid after restart'
status="$(request_code '/' --cookie "$COOKIE_JAR")"
assert_status '303' "$status" 'GET after restart' '/'

login_operator
status="$(request_code '/api/v1/settings' --cookie "$COOKIE_JAR")"
assert_status '200' "$status" 'GET after re-login' '/api/v1/settings'
assert_timezone_persisted 'UTC' || fail 'SQLite preference did not survive docker compose restart'

# Retain the original stop/up lifecycle coverage, with the same readiness wait
# used after initial startup and restart to avoid transient connection resets.
compose stop ai-window-manager
compose up -d --no-build
wait_for_health
status="$(request_code '/api/v1/providers' --cookie "$COOKIE_JAR")"
assert_status '401' "$status" 'GET after stop/up' '/api/v1/providers'
login_operator
status="$(request_code '/api/v1/settings' --cookie "$COOKIE_JAR")"
assert_status '200' "$status" 'GET after stop/up re-login' '/api/v1/settings'
assert_timezone_persisted 'UTC' || fail 'SQLite preference did not survive docker compose stop/up'
status="$(request_code '/history' --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR" --location)"
assert_status '200' "$status" 'GET after stop/up' '/history'

old_session="$(awk -F '\t' '$6 == "awm_session" { value = $7 } END { print value }' "$COOKIE_JAR")"
[[ "$old_session" =~ ^[A-Za-z0-9_-]{43}$ ]] || fail 'authenticated session cookie is missing before logout'
csrf_value="$(csrf_token_from_cookiejar)" || fail 'CSRF cookie is missing before logout'
[[ -n "$csrf_value" ]] || fail 'CSRF cookie is empty before logout'
request_code '/logout' \
  --cookie "$COOKIE_JAR" \
  --cookie-jar "$COOKIE_JAR" \
  --request POST \
  --header "Origin: ${EXPECTED_ORIGIN}" \
  --data-urlencode "csrfToken=${csrf_value}" >"$RESPONSE_STATUS"
IFS= read -r status <"$RESPONSE_STATUS" || fail 'logout returned no HTTP status'
unset csrf_value
assert_status '303' "$status" 'POST' '/logout'
status="$(request_code '/api/v1/providers' --cookie "awm_session=${old_session}")"
assert_status '401' "$status" 'GET after logout' '/api/v1/providers'
assert_auth_error_body || fail 'the logged-out session remained valid'

compose logs --no-color >"$LOG_FILE" 2>&1 || fail 'could not collect application logs for smoke assertions'
if ! AWM_AUTH_SMOKE_TEST_PASSWORD="$CI_AUTH_PASSWORD" python3 - \
  "$LOG_FILE" "$COOKIE_JAR" <<'PY'
import os
import re
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as log_file:
        logs = log_file.read()
    with open(sys.argv[2], encoding="utf-8") as jar_file:
        cookie_lines = jar_file.read().splitlines()
except OSError:
    sys.exit(2)

secrets = [
    os.environ.get("AWM_AUTH_PASSWORD_HASH", ""),
    os.environ.get("AWM_AUTH_SMOKE_TEST_PASSWORD", ""),
]
for line in cookie_lines:
    if line.startswith("#HttpOnly_"):
        fields = line[len("#HttpOnly_"):].split("\t")
    elif line.startswith("#"):
        continue
    else:
        fields = line.split("\t")
    if len(fields) >= 7:
        secrets.append(fields[6])

leaked = any(secret and secret in logs for secret in secrets)
unsafe_log = re.search(
    r"unhandled (?:exception|promise rejection)|uncaught exception|"
    r"sqlite(?:_|\s)*(?:error|corrupt)|database is locked|"
    r"migration.{0,40}(?:fail|error)|permission denied|EACCES|ENOENT|"
    r"authorization:\s*(?:bearer|basic)\s+\S+|"
    r"(?:access|refresh)[_-]?token\s*[=:]\s*\S+|"
    r"(?:api[_-]?key|client[_-]?secret|password)\s*[=:]\s*\S+|"
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|"
    r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    logs,
    re.I,
)
sys.exit(1 if leaked or unsafe_log else 0)
PY
then
  fail 'container logs contain a prohibited error pattern or authentication material'
fi

printf '%s\n' 'docker-auth-smoke: passed (auth boundary, CSRF, restart invalidation, SQLite persistence, stop/up, and logs)'
