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
COPY migrations ./migrations
COPY assets ./assets
RUN pnpm build

FROM node:24-bookworm-slim AS codex
ARG CODEX_VERSION=0.155.1
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tar gzip \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) \
        codex_target='x86_64-unknown-linux-musl'; \
        codex_sha256='a65b895c6ac1a73629bbe4b864640c86133e94a43b4d67b3103044e1a306d5a2' \
        ;; \
      arm64) \
        codex_target='aarch64-unknown-linux-musl'; \
        codex_sha256='71857dbc9bea3613410e8a69cfb46b07c0402d6d20fec18843dbaffd757634bd' \
        ;; \
      *) echo "unsupported Docker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    archive="/tmp/codex-package-${codex_target}.tar.gz"; \
    curl --fail --silent --show-error --location \
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package-${codex_target}.tar.gz" \
      --output "${archive}"; \
    printf '%s  %s\n' "${codex_sha256}" "${archive}" | sha256sum --check -; \
    install -d -m 0755 /opt/codex; \
    tar --extract --gzip --file "${archive}" --directory /opt/codex; \
    test "$(/opt/codex/bin/codex --version)" = "codex-cli ${CODEX_VERSION}"; \
    chmod -R a-w /opt/codex

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PATH=/opt/codex/bin:$PATH \
    AWM_BIND=0.0.0.0 \
    AWM_PORT=8787 \
    AWM_DB_PATH=/data/window-manager.db \
    AWM_CODEX_HOME=/codex-state \
    AWM_CODEX_EXECUTABLE=/opt/codex/bin/codex
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && useradd --system --uid 10001 --create-home --home-dir /home/awm awm \
    && mkdir -p /data /codex-state \
    && chown -R awm:awm /data /codex-state /home/awm \
    && chmod 0755 /data \
    && chmod 0700 /codex-state /home/awm
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/assets ./assets
COPY --from=codex /opt/codex /opt/codex
COPY package.json ./package.json
USER 10001:10001
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/src/index.js"]
