import { z } from 'zod';
import { isIP } from 'node:net';
import path from 'node:path';
import { validateArgon2idPasswordHash } from './auth/operator-password.js';
import { validateMetricsTokenDigest } from './auth/metrics-token.js';

const trustedProxySchema = z
  .string()
  .default('')
  .transform((value) => (value.trim() === '' ? [] : value.split(',').map((entry) => entry.trim())))
  .superRefine((entries, context) => {
    for (const entry of entries) {
      const [address, prefix, ...extra] = entry.split('/');
      const version = address ? isIP(address) : 0;
      const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : -1;
      const validPrefix =
        prefix === undefined ||
        (/^\d+$/.test(prefix) && Number(prefix) >= 0 && Number(prefix) <= maxPrefix);
      if (
        extra.length > 0 ||
        version === 0 ||
        !validPrefix ||
        (prefix !== undefined && maxPrefix < 0)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'AWM_TRUST_PROXY must contain valid IP addresses or CIDR ranges',
        });
        return;
      }
    }
  });

const envSchema = z.object({
  AWM_BIND: z.string().default('0.0.0.0'),
  AWM_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  AWM_DB_PATH: z.string().default('./data/window-manager.db'),
  AWM_PROVIDER_CLIENT_RUNTIME_ROOT: z
    .string()
    .default('')
    .refine((value) => value === '' || path.isAbsolute(value), {
      message: 'AWM_PROVIDER_CLIENT_RUNTIME_ROOT must be an absolute path when configured',
    }),
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
    .default('true')
    .transform((value) => value === 'true'),
  AWM_CODEX_HOME: z.string().default('./data/codex'),
  AWM_CODEX_EXECUTABLE: z.string().default('codex'),
  AWM_CODEX_ACTION_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  AWM_AUTH_SESSION_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(1800).default(900),
  AWM_AUTH_USERNAME: z
    .string()
    .trim()
    .min(1, { message: 'AWM_AUTH_USERNAME must not be empty' })
    .max(64, { message: 'AWM_AUTH_USERNAME must be 64 characters or fewer' })
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, {
      message: 'AWM_AUTH_USERNAME must use only letters, numbers, dot, underscore or hyphen',
    }),
  AWM_AUTH_PASSWORD_HASH: z
    .string()
    .min(1, { message: 'AWM_AUTH_PASSWORD_HASH must be configured' })
    .refine(validateArgon2idPasswordHash, {
      message: 'AWM_AUTH_PASSWORD_HASH must be a valid Argon2id hash with approved parameters',
    }),
  AWM_AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(900).max(604800).default(43200),
  AWM_TRUST_PROXY: trustedProxySchema,
  AWM_METRICS_TOKEN_SHA256: z.string().default('').refine(validateMetricsTokenDigest, {
    message: 'AWM_METRICS_TOKEN_SHA256 must be empty or a lowercase SHA-256 digest',
  }),
  AWM_ANTIGRAVITY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  AWM_ANTIGRAVITY_TRIGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  AWM_ANTIGRAVITY_ACTION_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  AWM_ANTIGRAVITY_GEMINI_TRIGGER_MODEL: z
    .string()
    .trim()
    .min(1, { message: 'AWM_ANTIGRAVITY_GEMINI_TRIGGER_MODEL must not be empty' })
    .max(128, { message: 'AWM_ANTIGRAVITY_GEMINI_TRIGGER_MODEL must be 128 characters or fewer' })
    .default('gemini-3.8-flash-low'),
  AWM_ANTIGRAVITY_CLAUDE_GPT_TRIGGER_MODEL: z
    .string()
    .trim()
    .min(1, { message: 'AWM_ANTIGRAVITY_CLAUDE_GPT_TRIGGER_MODEL must not be empty' })
    .max(128, {
      message: 'AWM_ANTIGRAVITY_CLAUDE_GPT_TRIGGER_MODEL must be 128 characters or fewer',
    })
    .default('claude-sonnet-4-6'),
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
