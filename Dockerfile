# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=awm-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json vitest.config.ts eslint.config.js .prettierrc.json ./
COPY src ./src
COPY scripts/auth-hash.ts ./scripts/auth-hash.ts
COPY scripts/provider-clients-core.ts ./scripts/provider-clients-core.ts
COPY migrations ./migrations
COPY assets ./assets
RUN pnpm build

FROM node:24-bookworm-slim AS codex
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

FROM node:24-bookworm-slim AS antigravity
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

FROM node:24-bookworm-slim AS runtime
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
    AWM_ANTIGRAVITY_EXECUTABLE=/provider-clients/antigravity/current
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates dbus-daemon gnome-keyring libsecret-1-0 tini \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && useradd --system --uid 10001 --create-home --home-dir /home/awm awm \
    && mkdir -p /data /codex-state /antigravity-state /antigravity-keyring /provider-clients /home/awm \
      /antigravity-state/.local/share/keyrings \
    && chown -R awm:awm /data /codex-state /antigravity-state /antigravity-keyring /provider-clients /home/awm \
    && chmod 0755 /data \
    && chmod 0700 /codex-state /antigravity-state /antigravity-keyring /provider-clients /home/awm
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/assets ./assets
COPY --from=codex /opt/codex /opt/codex
COPY --from=antigravity /opt/antigravity /opt/antigravity
COPY provider-clients.lock.json ./provider-clients.lock.json
COPY package.json ./package.json
COPY --chmod=0555 scripts/agy-entrypoint.sh ./scripts/agy-entrypoint.sh
USER 10001:10001
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/agy-entrypoint.sh"]
