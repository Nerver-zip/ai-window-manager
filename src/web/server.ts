import Fastify from 'fastify';
import type { AppConfig } from '../config.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { SqliteDatabase } from '../storage/database.js';
import { providerUp, registry, remainingRatio, usageRatio } from '../metrics/metrics.js';

export interface BuildServerInput {
  config: AppConfig;
  db: SqliteDatabase;
  providers: ProviderAdapter[];
}

export function buildServer(input: BuildServerInput) {
  const app = Fastify({
    logger: { level: input.config.AWM_LOG_LEVEL },
    bodyLimit: 64 * 1024,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    return payload;
  });

  app.get('/healthz', async (_request, reply) => {
    try {
      input.db.prepare('SELECT 1').get();
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'error' });
    }
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.get('/api/v1/providers', async () => {
    const observations = await Promise.all(
      input.providers.map(async (provider) => {
        const observation = await provider.inspect({});
        providerUp.set({ provider: provider.id }, observation.health === 'UP' ? 1 : 0);
        for (const window of observation.windows) {
          if (window.usageRatio)
            usageRatio.set(
              { provider: provider.id, window: window.windowKind },
              window.usageRatio.value,
            );
          if (window.remainingRatio) {
            remainingRatio.set(
              { provider: provider.id, window: window.windowKind },
              window.remainingRatio.value,
            );
          }
        }
        return { capabilities: provider.capabilities(), observation };
      }),
    );
    return { providers: observations };
  });

  app.get('/', async (_request, reply) => {
    const rows = await Promise.all(
      input.providers.map(async (provider) => {
        const observation = await provider.inspect({});
        const window = observation.windows[0];
        const remaining = window?.remainingRatio
          ? `${Math.round(window.remainingRatio.value * 100)}%`
          : 'unknown';
        const reset = window?.resetAt?.value ?? 'unknown';
        return `<article><h2>${escapeHtml(provider.id)}</h2><p>Status: ${escapeHtml(
          window?.phase ?? 'UNKNOWN',
        )}</p><p>Remaining: ${escapeHtml(remaining)}</p><p>Reset: ${escapeHtml(reset)}</p></article>`;
      }),
    );

    reply.type('text/html; charset=utf-8');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Window Manager</title><style>body{font:16px system-ui;max-width:900px;margin:3rem auto;padding:0 1rem;background:#111;color:#eee}article{border:1px solid #444;border-radius:12px;padding:1rem;margin:1rem 0}code{background:#222;padding:.2rem .4rem;border-radius:4px}.muted{color:#aaa}</style></head><body><h1>AI Window Manager</h1><p class="muted">Architecture-first scaffold · FakeProvider vertical slice</p>${rows.join('')}<p><a href="/api/v1/providers">JSON providers</a> · <a href="/metrics">metrics</a></p></body></html>`;
  });

  return app;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };
    return map[char] ?? char;
  });
}
