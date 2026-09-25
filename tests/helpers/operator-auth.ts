import { loadConfig, type AppConfig } from '../../src/config.js';
import { OperatorAuthService } from '../../src/auth/operator-auth.js';
import type { Clock } from '../../src/scheduler/clock.js';
import type { FastifyInstance } from 'fastify';

const PHC_SALT = Buffer.from('synthetic-test-salt').toString('base64').replace(/=+$/u, '');
const PHC_HASH = Buffer.alloc(32, 42).toString('base64').replace(/=+$/u, '');

export const TEST_OPERATOR_PASSWORD_HASH = `$argon2id$v=19$m=19456,t=2,p=1$${PHC_SALT}$${PHC_HASH}`;

export const TEST_OPERATOR_ENV = {
  AWM_AUTH_USERNAME: 'test-operator',
  AWM_AUTH_PASSWORD_HASH: TEST_OPERATOR_PASSWORD_HASH,
};

export function loadTestConfig(env: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ...TEST_OPERATOR_ENV, ...env });
}

export function createTestOperatorAuth(
  clock: Clock,
  options: {
    username?: string;
    verifyPassword?: (password: string, hash: string) => Promise<boolean>;
  } = {},
): OperatorAuthService {
  return new OperatorAuthService({
    username: options.username ?? TEST_OPERATOR_ENV.AWM_AUTH_USERNAME,
    passwordHash: TEST_OPERATOR_PASSWORD_HASH,
    sessionTtlMs: 43_200_000,
    clock,
    verifyPassword: options.verifyPassword ?? (() => Promise.resolve(true)),
  });
}

export function withOperatorSessionCookie(cookieHeader: string | undefined, token: string): string {
  const sessionCookie = `awm_session=${token}`;
  if (!cookieHeader || cookieHeader === '') return sessionCookie;
  if (cookieHeader.split(';').some((entry) => entry.trim().startsWith('awm_session='))) {
    return cookieHeader;
  }
  return `${sessionCookie}; ${cookieHeader}`;
}

export function attachDefaultTestSession(app: FastifyInstance, token: string): void {
  interface TestInjectOptions {
    url?: string;
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    payload?: unknown;
    [key: string]: unknown;
  }
  type InjectLike = (options: TestInjectOptions | string) => Promise<unknown>;
  const injectionSurface = app as unknown as { inject: InjectLike };
  const originalInject = injectionSurface.inject.bind(app);
  const patchedInject: InjectLike = (options) => {
    const request: TestInjectOptions = typeof options === 'string' ? { url: options } : options;
    const headers = request.headers ?? {};
    const suppliedCookie = typeof headers.cookie === 'string' ? headers.cookie : undefined;
    const cookie = suppliedCookie === '' ? '' : withOperatorSessionCookie(suppliedCookie, token);
    const merged = {
      ...request,
      headers: { ...headers, cookie },
    };
    return originalInject(merged);
  };
  Object.defineProperty(injectionSurface, 'inject', {
    configurable: true,
    writable: true,
    value: patchedInject,
  });
}
