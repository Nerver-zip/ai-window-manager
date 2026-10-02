#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly COMPOSE_FILE="${REPO_ROOT}/compose.yaml"
readonly CI_AUTH_USERNAME='awm-ci-operator'
readonly CI_AUTH_PASSWORD='awm-ci-synthetic-password-2026'
readonly CI_METRICS_TOKEN='synthetic-metrics-smoke-xxxxxxxxxxxxxxxxxxx'
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
export AWM_METRICS_TOKEN_SHA256=''
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
export AWM_METRICS_TOKEN_SHA256="$(printf '%s' "$CI_METRICS_TOKEN" | docker run \
  --rm --interactive --network none --read-only --user 10001:10001 \
  --entrypoint node "$image_id" --input-type=module -e \
  'import { createHash } from "node:crypto"; let token = ""; for await (const part of process.stdin) token += part; if (!/^[A-Za-z0-9_-]{43}$/.test(token)) process.exit(2); process.stdout.write(createHash("sha256").update(token).digest("hex"));')"

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

assert_metrics_token() {
  local status
  status="$(request_code '/metrics' --header "Authorization: Bearer ${CI_METRICS_TOKEN}")"
  assert_status '200' "$status" 'GET with technical token' '/metrics'
  [[ -s "$RESPONSE_BODY" ]] || fail 'technical metrics scrape returned no samples'
  status="$(request_code '/metrics' --head --header "Authorization: Bearer ${CI_METRICS_TOKEN}")"
  assert_status '200' "$status" 'HEAD with technical token' '/metrics'
  status="$(request_code '/api/v1/diagnostics' --header "Authorization: Bearer ${CI_METRICS_TOKEN}")"
  assert_status '401' "$status" 'GET with metrics token' '/api/v1/diagnostics'
  status="$(request_code "/metrics?token=${CI_METRICS_TOKEN}" --header "Authorization: Bearer ${CI_METRICS_TOKEN}")"
  assert_status '401' "$status" 'GET with query' '/metrics'
  status="$(request_code '/metrics' --request POST --header "Authorization: Bearer ${CI_METRICS_TOKEN}")"
  assert_status '401' "$status" 'POST with metrics token' '/metrics'
}

check_runtime_state() {
  local mode="$1"
  compose exec -T ai-window-manager node --input-type=module - "$mode" <<'JS'
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
assert.equal(process.env.AWM_FAKE_PROVIDER_ENABLED, 'true');
assert.equal(process.env.AWM_CODEX_ENABLED, 'false');
assert.equal(process.env.AWM_ANTIGRAVITY_ENABLED, 'false');
const db = new Database('/data/window-manager.db');
db.pragma('busy_timeout = 5000');
const mode = process.argv[2];
const now = Date.now();
assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 12);
if (mode === 'before-hint') {
  db.prepare("UPDATE providers SET poll_interval_seconds = 86400 WHERE id = 'fake'").run();
  const before = db.prepare("SELECT observed_at_ms AS at FROM provider_state WHERE provider_id = 'fake'").get().at;
  db.prepare("INSERT OR REPLACE INTO settings(key, value_json, updated_at_ms) VALUES('runtime_smoke_observed_before', ?, ?)").run(JSON.stringify(before), now);
} else if (mode === 'after-hint') {
  const before = JSON.parse(db.prepare("SELECT value_json FROM settings WHERE key = 'runtime_smoke_observed_before'").get().value_json);
  assert.ok(db.prepare("SELECT observed_at_ms AS at FROM provider_state WHERE provider_id = 'fake'").get().at > before);
} else if (mode === 'prepare-restart') {
  db.transaction(() => {
    db.prepare(`INSERT INTO action_intents(id, provider_id, action_type, dedupe_key, state,
      scheduled_for_ms, attempt_count, reason_code, explanation_json, created_at_ms, started_at_ms, updated_at_ms)
      VALUES('runtime-smoke-legacy', 'fake', 'window_trigger', 'runtime-smoke-no-redispatch', 'executing',
      ?, 1, 'SYNTHETIC_SMOKE_EXECUTING', '{"windowKind":"five_hour"}', ?, ?, ?)`)
      .run(now - 60000, now - 60000, now - 60000, now - 60000);
    db.prepare(`INSERT INTO provider_read_backoff(provider_id, purpose, failure_count, not_before_ms, failure_kind, updated_at_ms)
      VALUES('fake', 'confirmation', 3, ?, 'auth_required', ?)`)
      .run(now + 3600000, now);
  })();
} else if (mode === 'after-restart') {
  const intent = db.prepare("SELECT state, attempt_count, dedupe_key FROM action_intents WHERE id = 'runtime-smoke-legacy'").get();
  assert.equal(intent.state, 'uncertain');
  assert.equal(intent.attempt_count, 1);
  assert.equal(intent.dedupe_key, 'runtime-smoke-no-redispatch');
  assert.ok(db.prepare("SELECT not_before_ms FROM provider_read_backoff WHERE provider_id = 'fake'").get().not_before_ms > now);
} else if (mode === 'clear-read-backoff') {
  db.prepare("DELETE FROM provider_read_backoff WHERE provider_id = 'fake'").run();
} else if (mode === 'after-resolution') {
  const request = db.prepare("SELECT state, reason_code FROM action_resolution_requests WHERE intent_id = 'runtime-smoke-legacy'").get();
  assert.equal(request?.state, 'checked');
  assert.equal(request.reason_code, 'ACTION_RESOLUTION_CYCLE_UNIDENTIFIED');
  const intent = db.prepare("SELECT state, attempt_count FROM action_intents WHERE id = 'runtime-smoke-legacy'").get();
  assert.equal(intent.state, 'uncertain');
  assert.equal(intent.attempt_count, 1);
} else throw new Error('Unsupported isolated smoke mode');
db.close();
JS
}

wait_for_runtime_state() {
  local mode="$1" attempt
  for ((attempt = 1; attempt <= 20; attempt += 1)); do
    if check_runtime_state "$mode" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "isolated runtime state did not reach ${mode}"
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

assert_provider_client_runtime() {
  local status
  status="$(request_code '/api/v1/provider-clients' --cookie "$COOKIE_JAR")"
  assert_status '200' "$status" 'GET' '/api/v1/provider-clients'
  if ! python3 - "$RESPONSE_BODY" "${REPO_ROOT}/provider-clients.lock.json" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as response:
        payload = json.load(response)
    with open(sys.argv[2], encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)
except (OSError, ValueError):
    sys.exit(1)

clients = {client.get("providerId"): client for client in payload.get("providerClients", [])}
for provider_id in ("codex", "antigravity"):
    client = clients.get(provider_id)
    expected = manifest.get("providers", {}).get(provider_id, {}).get("version")
    if not client or not expected:
        sys.exit(1)
    if client.get("packagedVersion") != expected or client.get("activeVersion") != expected:
        sys.exit(1)
PY
  then
    fail 'provider-client API did not report the pinned packaged fallback versions'
  fi
}

assert_provider_client_volume() {
  local mode="$1"
  local script
  script='import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
const project = process.argv[1];
const mode = process.argv[2];
const marker = path.join("/provider-clients", `.docker-smoke-${project}`);
if (mode === "create") await writeFile(marker, project, { flag: "wx", mode: 0o600 });
else if (await readFile(marker, "utf8") !== project) process.exit(1);
for (const [provider, expected] of [["codex", "/opt/codex/bin/codex"], ["antigravity", "/opt/antigravity/bin/agy"]]) {
  const pointer = `/provider-clients/${provider}/current`;
  if (!(await lstat(pointer)).isSymbolicLink() || await readlink(pointer) !== expected) process.exit(1);
}'
  compose exec -T ai-window-manager node --input-type=module -e "$script" "$project_name" "$mode" \
    || fail "provider-client volume or packaged fallback pointer failed its ${mode} check"
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
assert_metrics_token

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
assert_provider_client_runtime
assert_provider_client_volume create

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

status="$(request_code '/api/v1/diagnostics' --cookie "$COOKIE_JAR")"
assert_status '200' "$status" 'GET private readiness' '/api/v1/diagnostics'
check_runtime_state before-hint
csrf_value="$(csrf_token_from_cookiejar)"
status="$(request_code '/api/v1/providers/fake/inspect' --cookie "$COOKIE_JAR" \
  --request POST --header "Origin: ${EXPECTED_ORIGIN}" --header "x-csrf-token: ${csrf_value}")"
assert_status '202' "$status" 'POST inspect hint' '/api/v1/providers/fake/inspect'
wait_for_runtime_state after-hint
check_runtime_state prepare-restart

docker compose --project-name "$project_name" --env-file /dev/null -f "$COMPOSE_FILE" \
  restart ai-window-manager
wait_for_health
assert_metrics_token
status="$(request_code '/api/v1/providers' --cookie "$COOKIE_JAR")"
assert_status '401' "$status" 'GET after restart' '/api/v1/providers'
assert_auth_error_body || fail 'the pre-restart session remained valid after restart'
status="$(request_code '/' --cookie "$COOKIE_JAR")"
assert_status '303' "$status" 'GET after restart' '/'

login_operator
assert_provider_client_runtime
assert_provider_client_volume verify
status="$(request_code '/api/v1/settings' --cookie "$COOKIE_JAR")"
assert_status '200' "$status" 'GET after re-login' '/api/v1/settings'
assert_timezone_persisted 'UTC' || fail 'SQLite preference did not survive docker compose restart'
wait_for_runtime_state after-restart
csrf_value="$(csrf_token_from_cookiejar)"
status="$(request_code '/api/v1/providers/fake/inspect' --cookie "$COOKIE_JAR" \
  --request POST --header "Origin: ${EXPECTED_ORIGIN}" --header "x-csrf-token: ${csrf_value}")"
assert_status '202' "$status" 'POST deferred inspect' '/api/v1/providers/fake/inspect'
status="$(request_code '/api/v1/diagnostics' --cookie "$COOKIE_JAR")"
assert_status '200' "$status" 'GET progress during read backoff' '/api/v1/diagnostics'
python3 - "$RESPONSE_BODY" <<'PY' || fail 'private diagnostics did not expose the deferred read hint'
import json
import sys
with open(sys.argv[1], encoding='utf-8') as response:
    payload = json.load(response)
provider = next(p for p in payload['providers'] if p['id'] == 'fake')
assert provider['inspectHintPending'] is True
assert provider['readRetryAtMs'] > 0
assert {loop['name'] for loop in payload['loops']} == {'reconcile', 'executor', 'cleanup', 'aggregation', 'retention'}
PY
check_runtime_state clear-read-backoff
status="$(request_code '/api/v1/actions/runtime-smoke-legacy/resolve-unknown' --cookie "$COOKIE_JAR" \
  --request POST --header "Origin: ${EXPECTED_ORIGIN}" --header "x-csrf-token: ${csrf_value}")"
assert_status '202' "$status" 'POST unknown-outcome review' '/api/v1/actions/runtime-smoke-legacy/resolve-unknown'
wait_for_runtime_state after-resolution

# Retain the original stop/up lifecycle coverage, with the same readiness wait
# used after initial startup and restart to avoid transient connection resets.
compose stop ai-window-manager
compose up -d --no-build
wait_for_health
assert_metrics_token
status="$(request_code '/api/v1/providers' --cookie "$COOKIE_JAR")"
assert_status '401' "$status" 'GET after stop/up' '/api/v1/providers'
login_operator
assert_provider_client_runtime
assert_provider_client_volume verify
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
    os.environ.get("AWM_METRICS_TOKEN_SHA256", ""),
    "synthetic-metrics-smoke-xxxxxxxxxxxxxxxxxxx",
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

export AWM_METRICS_TOKEN_SHA256=''
compose up -d --no-build --force-recreate
wait_for_health
status="$(request_code '/metrics' --header "Authorization: Bearer ${CI_METRICS_TOKEN}")"
assert_status '401' "$status" 'GET after token revocation' '/metrics'

printf '%s\n' 'docker-auth-smoke: passed (auth boundary, CSRF, provider-client fallback/version persistence, restart invalidation, SQLite persistence, technical metrics/revocation, stop/up, and logs)'
