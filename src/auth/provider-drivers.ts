import type { ProviderAdapter } from '../providers/provider.js';
import type { AuthCommandRunner, AuthProcessFactory } from './process.js';
import { captureAuthCommand, providerProcessEnvironment, spawnAuthProcess } from './process.js';
import type { AuthOutputStream, AuthOutputUpdate, ProviderAuthDriver } from './session-manager.js';

export interface ProviderAuthDriverOptions {
  adapters: ReadonlyMap<string, ProviderAdapter>;
  codexHome: string;
  codexExecutable: string;
  antigravityHome: string;
  antigravityExecutable: string;
  spawnProcess?: AuthProcessFactory;
  runCommand?: AuthCommandRunner;
}

class CodexAuthDriver implements ProviderAuthDriver {
  readonly providerId = 'codex' as const;
  private authorizationUrl: string | undefined;

  constructor(
    private readonly options: ProviderAuthDriverOptions,
    private readonly adapter: ProviderAdapter,
  ) {}

  async isAlreadyAuthenticated(signal: AbortSignal): Promise<boolean | undefined> {
    const result = await (this.options.runCommand ?? captureAuthCommand)(
      this.options.codexExecutable,
      ['login', 'status'],
      {
        cwd: '/tmp',
        env: {
          ...providerProcessEnvironment({ home: this.options.codexHome }),
          CODEX_HOME: this.options.codexHome,
        },
      },
      signal,
    );
    if (result.overflow || result.code === null) return undefined;
    if (result.code === 0) return true;
    if (result.code === 1 && /\bnot logged in\b/i.test(result.output)) return false;
    return undefined;
  }

  launch() {
    this.authorizationUrl = undefined;
    return (this.options.spawnProcess ?? spawnAuthProcess)(
      this.options.codexExecutable,
      ['login', '--device-auth'],
      {
        cwd: '/tmp',
        env: {
          ...providerProcessEnvironment({ home: this.options.codexHome }),
          CODEX_HOME: this.options.codexHome,
        },
      },
    );
  }

  parseOutput(_stream: AuthOutputStream, line: string): AuthOutputUpdate | undefined {
    const url = extractUrl(line, 'auth.openai.com');
    if (url) this.authorizationUrl = url;
    if (!this.authorizationUrl) return undefined;

    const labeledCode =
      /(?:user|device|one[- ]time)?\s*code\s*[:：]\s*([A-Za-z0-9-]{4,64})\b/i.exec(line)?.[1];
    const standaloneCode = /^[A-Z0-9-]{4,32}$/.exec(line.trim())?.[0];
    const userCode = labeledCode ?? standaloneCode;
    return {
      awaitingUserAction: true,
      authorizationUrl: this.authorizationUrl,
      ...(userCode ? { userCode } : {}),
      requiresCodeSubmission: false,
    };
  }

  submitCode(): void {
    throw new Error('Codex device code is submitted on the official website');
  }

  async verify(signal: AbortSignal): Promise<boolean> {
    const observation = await this.adapter.inspect({ signal });
    return observation.health === 'UP' || observation.health === 'DEGRADED';
  }
}

class AntigravityAuthDriver implements ProviderAuthDriver {
  readonly providerId = 'antigravity' as const;
  private authorizationUrl: string | undefined;

  constructor(
    private readonly options: ProviderAuthDriverOptions,
    private readonly adapter: ProviderAdapter,
  ) {}

  async isAlreadyAuthenticated(signal: AbortSignal): Promise<boolean | undefined> {
    const observation = await this.adapter.inspect({ signal });
    if (observation.health === 'AUTH_REQUIRED') return false;
    if (observation.health === 'UP' || observation.health === 'DEGRADED') return true;
    return undefined;
  }

  launch() {
    this.authorizationUrl = undefined;
    return (this.options.spawnProcess ?? spawnAuthProcess)(this.options.antigravityExecutable, [], {
      cwd: this.options.antigravityHome,
      env: providerProcessEnvironment({
        home: this.options.antigravityHome,
        includeDbus: true,
        includeSsh: true,
      }),
      interactive: true,
    });
  }

  parseOutput(_stream: AuthOutputStream, line: string): AuthOutputUpdate | undefined {
    if (
      this.authorizationUrl &&
      /(?:invalid|expired|incorrect).{0,40}(?:code|authori[sz])/i.test(line)
    ) {
      return {
        awaitingUserAction: true,
        authorizationUrl: this.authorizationUrl,
        requiresCodeSubmission: true,
        reasonCode: 'AUTH_CODE_REJECTED',
      };
    }

    const url = extractUrl(line, 'accounts.google.com');
    if (!url) return undefined;
    this.authorizationUrl = url;
    return {
      awaitingUserAction: true,
      authorizationUrl: url,
      requiresCodeSubmission: true,
    };
  }

  submitCode(process: Parameters<ProviderAuthDriver['submitCode']>[0], code: string): void {
    process.writeInput(`${code}\r`);
  }

  async verify(signal: AbortSignal): Promise<boolean> {
    const observation = await this.adapter.inspect({ signal });
    return observation.health === 'UP' || observation.health === 'DEGRADED';
  }
}

export function createProviderAuthDrivers(
  options: ProviderAuthDriverOptions,
): ReadonlyMap<'codex' | 'antigravity', ProviderAuthDriver> {
  const drivers = new Map<'codex' | 'antigravity', ProviderAuthDriver>();
  const codex = options.adapters.get('codex');
  if (codex) drivers.set('codex', new CodexAuthDriver(options, codex));
  const antigravity = options.adapters.get('antigravity');
  if (antigravity) drivers.set('antigravity', new AntigravityAuthDriver(options, antigravity));
  return drivers;
}

function extractUrl(line: string, expectedHost: string): string | undefined {
  const match = /https:\/\/[^\s<>"']+/i.exec(line)?.[0];
  if (!match) return undefined;
  const trimmed = match.replace(/[),.;]+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== expectedHost) return undefined;
    if (url.username || url.password) return undefined;
    const sensitiveParameter = /^(access_token|refresh_token|id_token|token|authorization|code)$/i;
    if ([...url.searchParams.keys()].some((name) => sensitiveParameter.test(name)))
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
