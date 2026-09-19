import { loadConfig } from './config.js';
import { FakeProvider } from './providers/fake-provider.js';
import type { ProviderAdapter } from './providers/provider.js';
import { SystemClock } from './scheduler/clock.js';
import { openDatabase } from './storage/database.js';
import { buildServer } from './web/server.js';

const config = loadConfig();
const db = openDatabase(config.AWM_DB_PATH);
const clock = new SystemClock();
const providers: ProviderAdapter[] = [];

if (config.AWM_FAKE_PROVIDER_ENABLED) {
  providers.push(new FakeProvider(clock));
}

const app = buildServer({ config, db, providers });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

await app.listen({ host: config.AWM_BIND, port: config.AWM_PORT });
