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
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AWM_BIND=0.0.0.0 \
    AWM_PORT=8787 \
    AWM_DB_PATH=/data/window-manager.db
WORKDIR /app
RUN corepack enable \
    && useradd --system --uid 10001 --create-home --home-dir /home/awm awm \
    && mkdir -p /data \
    && chown -R awm:awm /data /home/awm
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY package.json ./package.json
USER 10001:10001
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/src/index.js"]
