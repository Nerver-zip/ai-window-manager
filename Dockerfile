# syntax=docker/dockerfile:1.7
FROM node:24-trixie-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=awm-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

FROM deps AS prod-deps
# Do not ship build, test, or lint tooling in the runtime image.
RUN pnpm prune --prod

FROM deps AS build
COPY tsconfig.json vitest.config.ts eslint.config.js .prettierrc.json ./
COPY src ./src
COPY scripts/auth-hash.ts ./scripts/auth-hash.ts
COPY scripts/provider-clients-core.ts ./scripts/provider-clients-core.ts
COPY migrations ./migrations
COPY assets ./assets
RUN pnpm build

FROM node:24-trixie-slim AS codex
ARG TARGETARCH
COPY provider-clients.lock.json /tmp/provider-clients.lock.json
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tar gzip \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) \
        codex_arch='amd64'; \
        codex_target='x86_64-unknown-linux-musl' \
        ;; \
      arm64) \
        codex_arch='arm64'; \
        codex_target='aarch64-unknown-linux-musl' \
        ;; \
      *) echo "unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    codex_version="$(node -e "const p=require('/tmp/provider-clients.lock.json').providers.codex; process.stdout.write(p.version)")"; \
    codex_tag="$(node -e "process.stdout.write(require('/tmp/provider-clients.lock.json').providers.codex.tag)")"; \
    codex_asset="$(node -e "process.stdout.write(require('/tmp/provider-clients.lock.json').providers.codex.assets['${codex_arch}'].name)")"; \
    codex_sha256="$(node -e "process.stdout.write(require('/tmp/provider-clients.lock.json').providers.codex.assets['${codex_arch}'].sha256)")"; \
    test "${codex_version}" = "${codex_tag#rust-v}"; \
    test "${codex_asset}" = "codex-package-${codex_target}.tar.gz"; \
    printf '%s' "${codex_sha256}" | grep -Eq '^[a-f0-9]{64}$'; \
    archive="/tmp/codex-package-${codex_target}.tar.gz"; \
    curl --fail --silent --show-error --location \
      "https://github.com/openai/codex/releases/download/${codex_tag}/${codex_asset}" \
      --output "${archive}"; \
    printf '%s  %s\n' "${codex_sha256}" "${archive}" | sha256sum --check -; \
    install -d -m 0755 /opt/codex; \
    tar --extract --gzip --file "${archive}" --directory /opt/codex; \
    test "$(/opt/codex/bin/codex --version)" = "codex-cli ${codex_version}"; \
    chmod -R a-w /opt/codex

FROM node:24-trixie-slim AS antigravity
ARG TARGETARCH
COPY provider-clients.lock.json /tmp/provider-clients.lock.json
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tar gzip \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) \
        agy_arch='amd64'; \
        agy_expected_asset='agy_cli_linux_x64.tar.gz' \
        ;; \
      arm64) \
        agy_arch='arm64'; \
        agy_expected_asset='agy_cli_linux_arm64.tar.gz' \
        ;; \
      *) echo "unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    agy_version="$(node -e "const p=require('/tmp/provider-clients.lock.json').providers.antigravity; process.stdout.write(p.version)")"; \
    agy_tag="$(node -e "process.stdout.write(require('/tmp/provider-clients.lock.json').providers.antigravity.tag)")"; \
    agy_asset="$(node -e "process.stdout.write(require('/tmp/provider-clients.lock.json').providers.antigravity.assets['${agy_arch}'].name)")"; \
    agy_sha256="$(node -e "process.stdout.write(require('/tmp/provider-clients.lock.json').providers.antigravity.assets['${agy_arch}'].sha256)")"; \
    test "${agy_version}" = "${agy_tag}"; \
    test "${agy_asset}" = "${agy_expected_asset}"; \
    printf '%s' "${agy_sha256}" | grep -Eq '^[a-f0-9]{64}$'; \
    archive="/tmp/${agy_asset}"; \
    curl --fail --silent --show-error --location --retry 3 \
      "https://github.com/google-antigravity/antigravity-cli/releases/download/${agy_tag}/${agy_asset}" \
      --output "${archive}"; \
    printf '%s  %s\n' "${agy_sha256}" "${archive}" | sha256sum --check -; \
    install -d -m 0755 /opt/antigravity/bin; \
    tar --extract --gzip --file "${archive}" --directory /tmp; \
    test -f /tmp/antigravity; \
    install -m 0555 /tmp/antigravity /opt/antigravity/bin/agy; \
    test "$(/opt/antigravity/bin/agy --version)" = "${agy_version}"; \
    chmod -R a-w /opt/antigravity

FROM node:24-trixie-slim AS claude-code
ARG TARGETARCH
COPY provider-clients.lock.json /tmp/provider-clients.lock.json
# Repository-pinned public release key; fingerprint is enforced below.
COPY provider-keys/claude-code-release.asc /tmp/claude-code-release.asc
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gpg gpgv \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) claude_arch='amd64'; claude_platform='linux-x64' ;; \
      arm64) claude_arch='arm64'; claude_platform='linux-arm64' ;; \
      *) echo "unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    lock() { node -e "process.stdout.write(String(require('/tmp/provider-clients.lock.json').providers.claude_code$1))"; }; \
    claude_version="$(lock .version)"; \
    test "$(lock .tag)" = "${claude_version}"; \
    test "$(lock .repository)" = 'downloads.claude.ai/claude-code-releases'; \
    test "$(lock ".assets['${claude_arch}'].name")" = "${claude_platform}/claude"; \
    claude_sha256="$(lock ".assets['${claude_arch}'].sha256")"; \
    printf '%s' "${claude_sha256}" | grep -Eq '^[a-f0-9]{64}$'; \
    base="https://downloads.claude.ai/claude-code-releases/${claude_version}"; \
    work="$(mktemp -d)"; \
    gpg --batch --dearmor < /tmp/claude-code-release.asc > "${work}/release-key.gpg"; \
    curl --fail --silent --show-error --proto '=https' --retry 3 "${base}/manifest.json" --output "${work}/manifest.json"; \
    curl --fail --silent --show-error --proto '=https' --retry 3 "${base}/manifest.json.sig" --output "${work}/manifest.json.sig"; \
    gpgv --status-fd 1 --keyring "${work}/release-key.gpg" "${work}/manifest.json.sig" "${work}/manifest.json" > "${work}/gpgv.status"; \
    grep -Eq '^\[GNUPG:\] VALIDSIG [A-F0-9]{40} .* 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE$' "${work}/gpgv.status"; \
    manifest_sha256="$(node -e "const m=require('${work}/manifest.json'); if (m.version !== '${claude_version}') process.exit(1); const p=m.platforms['${claude_platform}']; if (!p || p.binary !== 'claude') process.exit(1); process.stdout.write(p.checksum)")"; \
    test "${manifest_sha256}" = "${claude_sha256}"; \
    curl --fail --silent --show-error --proto '=https' --retry 3 "${base}/${claude_platform}/claude" --output "${work}/claude"; \
    printf '%s  %s\n' "${claude_sha256}" "${work}/claude" | sha256sum --check -; \
    install -d -m 0755 /opt/claude-code/bin; \
    install -m 0555 "${work}/claude" /opt/claude-code/bin/claude; \
    rm -rf "${work}"; \
    test "$(HOME=/tmp DISABLE_AUTOUPDATER=1 /opt/claude-code/bin/claude --version)" = "${claude_version} (Claude Code)"; \
    chmod -R a-w /opt/claude-code

# Use Ubuntu LTS for the security-maintained D-Bus/keyring runtime packages;
# retain the official Node 24 binary built in the dependency stage.
FROM ubuntu:24.04 AS runtime
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    PATH=/opt/antigravity/bin:/opt/codex/bin:$PATH \
    AWM_BIND=0.0.0.0 \
    AWM_PORT=8787 \
    AWM_DB_PATH=/data/window-manager.db \
    AWM_PROVIDER_CLIENT_RUNTIME_ROOT=/provider-clients \
    AWM_CODEX_HOME=/codex-state \
    AWM_CODEX_EXECUTABLE=/provider-clients/codex/current \
    AWM_AUTH_SESSION_TIMEOUT_SECONDS=900 \
    AWM_ANTIGRAVITY_ENABLED=false \
    AWM_ANTIGRAVITY_HOME=/antigravity-state \
    AWM_ANTIGRAVITY_EXECUTABLE=/provider-clients/antigravity/current \
    AWM_CLAUDE_CODE_ENABLED=false \
    AWM_CLAUDE_CODE_HOME=/claude-state \
    AWM_CLAUDE_CODE_EXECUTABLE=/provider-clients/claude_code/current
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates dbus-daemon gnome-keyring gpgv libsecret-1-0 tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /home/awm awm \
    && mkdir -p /data /codex-state /antigravity-state /antigravity-keyring /claude-state /provider-clients /home/awm \
      /antigravity-state/.local/share/keyrings \
    && chown -R awm:awm /data /codex-state /antigravity-state /antigravity-keyring /claude-state /provider-clients /home/awm \
    && chmod 0755 /data \
    && chmod 0700 /codex-state /antigravity-state /antigravity-keyring /claude-state /provider-clients /home/awm
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/assets ./assets
# Static assets are read by the non-root server; normalize restrictive local
# file modes in the build context before packaging them into the runtime image.
RUN chmod -R a+rX /app/assets
COPY --from=codex /opt/codex /opt/codex
COPY --from=antigravity /opt/antigravity /opt/antigravity
COPY --from=claude-code /opt/claude-code /opt/claude-code
COPY provider-keys ./provider-keys
COPY --chmod=0555 scripts/claude-code-cli.sh /usr/local/bin/claude-code-cli
COPY provider-clients.lock.json ./provider-clients.lock.json
COPY package.json ./package.json
COPY --chmod=0555 scripts/agy-entrypoint.sh ./scripts/agy-entrypoint.sh
USER 10001:10001
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/agy-entrypoint.sh"]
