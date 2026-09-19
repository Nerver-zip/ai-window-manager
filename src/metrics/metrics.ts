import client from 'prom-client';

client.collectDefaultMetrics({ prefix: 'ai_window_process_' });

export const providerUp = new client.Gauge({
  name: 'ai_window_provider_up',
  help: 'Whether the provider is currently considered up (1) or not (0).',
  labelNames: ['provider'] as const,
});

export const usageRatio = new client.Gauge({
  name: 'ai_window_usage_ratio',
  help: 'Normalized used quota ratio when known.',
  labelNames: ['provider', 'window'] as const,
});

export const remainingRatio = new client.Gauge({
  name: 'ai_window_remaining_ratio',
  help: 'Normalized remaining quota ratio when known.',
  labelNames: ['provider', 'window'] as const,
});

export const registry = client.register;
