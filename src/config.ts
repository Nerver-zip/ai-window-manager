import { z } from 'zod';

const envSchema = z.object({
  AWM_BIND: z.string().default('0.0.0.0'),
  AWM_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  AWM_DB_PATH: z.string().default('./data/window-manager.db'),
  AWM_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  AWM_TIMEZONE: z
    .string()
    .refine(isValidTimeZone, { message: 'AWM_TIMEZONE must be a valid IANA timezone' })
    .default('America/Sao_Paulo'),
  AWM_FAKE_PROVIDER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  AWM_CODEX_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  AWM_CODEX_TRIGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  AWM_CODEX_HOME: z.string().default('./data/codex'),
  AWM_CODEX_EXECUTABLE: z.string().default('codex'),
  AWM_CODEX_ACTION_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  AWM_AUTH_SESSION_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(1800).default(900),
  AWM_ANTIGRAVITY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  AWM_ANTIGRAVITY_HOME: z.string().default('./data/antigravity'),
  AWM_ANTIGRAVITY_EXECUTABLE: z.string().default('agy'),
  AWM_RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  AWM_EXECUTOR_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(3600).default(5),
  AWM_RETENTION_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(604800).default(86400),
});

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
