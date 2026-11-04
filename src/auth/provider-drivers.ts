import { resolve } from 'node:path';
import { validateAuthorizationUrl } from './authorization-url.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { ProviderInspectionCoordinator } from '../providers/inspection-coordinator.js';
import type { ClaudeAuthState } from '../providers/claude-code/protocol.js';
import { claudeProcessEnvironment } from '../providers/claude-code/transport.js';
import type { AuthCommandRunner, AuthProcessFactory } from './process.js';
import { captureAuthCommand, providerProcessEnvironment, spawnAuthProcess } from './process.js';
import type {
  AuthManagedProcess,
  AuthOutputStream,
  AuthOutputUpdate,
  AuthProviderId,
  ProviderAuthDriver,
} from './session-manager.js';

export interface ProviderAuthDriverOptions {
  adapters: ReadonlyMap<string, ProviderAdapter>;
  inspections?: ProviderInspectionCoordinator;
  codexHome: string;
  codexExecutable: string;
  antigravityHome: string;
  antigravityExecutable: string;
  claudeCodeHome: string;
  claudeCodeExecutable: string;
  spawnProcess?: AuthProcessFactory;
  runCommand?: AuthCommandRunner;
}

interface ClaudeCodeAuthAdapter extends ProviderAdapter {
  authStatus(signal?: AbortSignal): Promise<ClaudeAuthState>;
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
        interactive: true,
      },
    );
  }

  parseOutput(_stream: AuthOutputStream, line: string): AuthOutputUpdate | undefined {
    const url = extractUrl(line, 'codex');
    if (url) this.authorizationUrl = url;
    if (!this.authorizationUrl) return undefined;

    const userCode = extractCodexDeviceCode(line);
    if (!url && !userCode) return undefined;
    return {
      awaitingUserAction: true,
      authorizationUrl: this.authorizationUrl,
      ...(userCode ? { userCode } : {}),
      requiresCodeSubmission: false,
    };
  }

  parseOutputFragment(_stream: AuthOutputStream, fragment: string): AuthOutputUpdate | undefined {
    if (!this.authorizationUrl) return undefined;
    const userCode = extractCodexDeviceCode(fragment);
    if (!userCode) return undefined;
    return {
      awaitingUserAction: true,
      authorizationUrl: this.authorizationUrl,
      userCode,
      requiresCodeSubmission: false,
    };
  }

  submitCode(): void {
    throw new Error('Codex device code is submitted on the official website');
  }

  async verify(signal: AbortSignal): Promise<boolean> {
    const observation = await (this.options.inspections
      ? this.options.inspections.inspectFresh(this.adapter, { signal }, 'auth_verify')
      : this.adapter.inspect({ signal }));
    return observation.health === 'UP' || observation.health === 'DEGRADED';
  }
}

function extractCodexDeviceCode(text: string): string | undefined {
  const labeledCode =
    /(?:user|device|one[- ]time)?\s*code\s*[:：]\s*([A-Z0-9]{4}-[A-Z0-9]{5})(?![A-Z0-9-])/i.exec(
      text,
    )?.[1];
  const standaloneCode = /^\s*([A-Z0-9]{4}-[A-Z0-9]{5})\s*$/i.exec(text)?.[1];
  return labeledCode ?? standaloneCode;
}

class AntigravityAuthDriver implements ProviderAuthDriver {
  readonly providerId = 'antigravity' as const;
  private authorizationUrl: string | undefined;
  private loginMethodPromptLinesRemaining = 0;
  private googleOAuthSelectionSent = false;
  private pendingAuthorizationUrl: string | undefined;

  private static readonly MAX_PENDING_AUTHORIZATION_URL_BYTES = 4096;

  constructor(
    private readonly options: ProviderAuthDriverOptions,
    private readonly adapter: ProviderAdapter,
  ) {}

  async isAlreadyAuthenticated(signal: AbortSignal): Promise<boolean | undefined> {
    const observation = await (this.options.inspections
      ? this.options.inspections.inspectFresh(this.adapter, { signal }, 'auth_check')
      : this.adapter.inspect({ signal }));
    if (observation.health === 'AUTH_REQUIRED') return false;
    if (observation.health === 'UP' || observation.health === 'DEGRADED') return true;
    return undefined;
  }

  launch() {
    this.authorizationUrl = undefined;
    this.loginMethodPromptLinesRemaining = 0;
    this.googleOAuthSelectionSent = false;
    this.pendingAuthorizationUrl = undefined;
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

  onOutputLine(process: AuthManagedProcess, _stream: AuthOutputStream, line: string): void {
    if (/select login method:/i.test(line)) this.loginMethodPromptLinesRemaining = 12;
    if (this.loginMethodPromptLinesRemaining <= 0 || this.googleOAuthSelectionSent) return;

    if (/^\s*>\s*1\.\s*Google OAuth\s*$/i.test(line)) {
      this.googleOAuthSelectionSent = true;
      this.loginMethodPromptLinesRemaining = 0;
      process.writeInput('\r');
      return;
    }

    if (/^\s*>\s*2\.\s*Use a Google Cloud project\b/i.test(line)) {
      this.loginMethodPromptLinesRemaining = 0;
      return;
    }
    this.loginMethodPromptLinesRemaining -= 1;
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

    const authorizationPrompt = /copy and paste the URL|click here to authenticate/i.test(line);
    const urlText = /https:\/\/accounts\.google\.com\/[^\s<>"']+/i.exec(line)?.[0];
    if (urlText) this.pendingAuthorizationUrl = urlText.replace(/[),.;]+$/, '');

    if (this.pendingAuthorizationUrl) {
      if (authorizationPrompt) return this.publishPendingAuthorizationUrl();

      const continuation = line.trim();
      if (!urlText && continuation && isAuthorizationUrlContinuation(continuation)) {
        const combined = `${this.pendingAuthorizationUrl}${continuation}`;
        if (
          Buffer.byteLength(combined) > AntigravityAuthDriver.MAX_PENDING_AUTHORIZATION_URL_BYTES
        ) {
          this.pendingAuthorizationUrl = undefined;
        } else {
          this.pendingAuthorizationUrl = combined;
        }
      }
      return undefined;
    }

    return undefined;
  }

  parseOutputFragment(stream: AuthOutputStream, fragment: string): AuthOutputUpdate | undefined {
    if (
      /copy and paste the URL|click here to authenticate/i.test(fragment) ||
      (this.authorizationUrl &&
        /(?:invalid|expired|incorrect).{0,40}(?:code|authori[sz])/i.test(fragment))
    ) {
      return this.parseOutput(stream, fragment);
    }
    return undefined;
  }

  private publishPendingAuthorizationUrl(): AuthOutputUpdate | undefined {
    const candidate = this.pendingAuthorizationUrl;
    this.pendingAuthorizationUrl = undefined;
    if (!candidate) return undefined;
    const url = extractUrl(candidate, 'antigravity');
    if (!url) return undefined;

    this.authorizationUrl = url;
    return {
      awaitingUserAction: true,
      authorizationUrl: this.authorizationUrl,
      requiresCodeSubmission: true,
    };
  }

  submitCode(process: Parameters<ProviderAuthDriver['submitCode']>[0], code: string): void {
    process.writeInput(`${code}\r`);
  }

  async verify(signal: AbortSignal): Promise<boolean> {
    const observation = await (this.options.inspections
      ? this.options.inspections.inspectFresh(this.adapter, { signal }, 'auth_verify')
      : this.adapter.inspect({ signal }));
    return observation.health === 'UP' || observation.health === 'DEGRADED';
  }
}

class ClaudeCodeAuthDriver implements ProviderAuthDriver {
  readonly providerId = 'claude_code' as const;
  private authorizationUrl: string | undefined;
  private pendingBootstrapUrl: string | undefined;
  private codeEntryPromptObserved = false;
  private loginSuccessAcknowledged = false;

  constructor(
    private readonly options: ProviderAuthDriverOptions,
    private readonly adapter: ClaudeCodeAuthAdapter,
  ) {}

  async isAlreadyAuthenticated(signal: AbortSignal): Promise<boolean | undefined> {
    const status = await this.adapter.authStatus(signal);
    if (status.state === 'authenticated' || status.state === 'unsupported_auth') return true;
    if (status.state === 'unauthenticated') return false;
    return undefined;
  }

  launch(): AuthManagedProcess {
    this.authorizationUrl = undefined;
    this.pendingBootstrapUrl = undefined;
    this.codeEntryPromptObserved = false;
    this.loginSuccessAcknowledged = false;
    return (this.options.spawnProcess ?? spawnAuthProcess)(
      this.options.claudeCodeExecutable,
      ['auth', 'login'],
      {
        cwd: '/tmp',
        env: claudeProcessEnvironment(resolve(this.options.claudeCodeHome)),
        interactive: true,
      },
    );
  }

  onOutputLine(process: AuthManagedProcess, _stream: AuthOutputStream, line: string): void {
    // Anthropic documents an Enter confirmation after successful login. The
    // session manager still independently verifies `auth status --json` after
    // the official CLI exits; this keypress does not establish success.
    if (!this.loginSuccessAcknowledged && /\blogin successful\b/i.test(line)) {
      this.loginSuccessAcknowledged = true;
      process.writeInput('\r');
    }
  }

  parseOutput(_stream: AuthOutputStream, line: string): AuthOutputUpdate | undefined {
    if (
      this.authorizationUrl &&
      /(?:invalid|expired|incorrect).{0,40}(?:code|authori[sz])/i.test(line)
    ) {
      this.codeEntryPromptObserved = true;
      return {
        awaitingUserAction: true,
        authorizationUrl: this.authorizationUrl,
        requiresCodeSubmission: true,
        reasonCode: 'AUTH_CODE_REJECTED',
      };
    }

    const codePrompt = CLAUDE_CODE_ENTRY_PROMPT.exec(line);
    if (codePrompt) this.codeEntryPromptObserved = true;

    const candidate = extractUrlCandidate(line);
    if (candidate && isClaudeCodeBootstrapUrlCandidate(candidate)) {
      this.pendingBootstrapUrl = candidate;
      if (codePrompt || this.codeEntryPromptObserved) return this.publishPendingBootstrapUrl();
      return undefined;
    }

    if (this.pendingBootstrapUrl) {
      if (codePrompt) {
        const beforePrompt = line.slice(0, codePrompt.index).trim();
        if (beforePrompt && isAuthorizationUrlContinuation(beforePrompt)) {
          this.appendPendingBootstrapUrl(beforePrompt);
        }
        return this.publishPendingBootstrapUrl();
      }

      const continuation = line.trim();
      if (continuation && isAuthorizationUrlContinuation(continuation)) {
        this.appendPendingBootstrapUrl(continuation);
        return undefined;
      }
      this.pendingBootstrapUrl = undefined;
    }

    const url = extractUrl(line, 'claude_code');
    if (url) this.authorizationUrl = url;

    if (this.authorizationUrl && (url || codePrompt)) {
      return {
        awaitingUserAction: true,
        authorizationUrl: this.authorizationUrl,
        requiresCodeSubmission: this.codeEntryPromptObserved,
      };
    }
    return undefined;
  }

  private appendPendingBootstrapUrl(continuation: string): void {
    if (!this.pendingBootstrapUrl) return;
    const combined = `${this.pendingBootstrapUrl}${continuation}`;
    this.pendingBootstrapUrl = Buffer.byteLength(combined) <= 2048 ? combined : undefined;
  }

  private publishPendingBootstrapUrl(): AuthOutputUpdate | undefined {
    const candidate = this.pendingBootstrapUrl;
    this.pendingBootstrapUrl = undefined;
    const url = validateAuthorizationUrl('claude_code', candidate);
    if (!url) return undefined;
    this.authorizationUrl = url;
    return {
      awaitingUserAction: true,
      authorizationUrl: url,
      requiresCodeSubmission: this.codeEntryPromptObserved,
    };
  }

  parseOutputFragment(stream: AuthOutputStream, fragment: string): AuthOutputUpdate | undefined {
    const completeUrl = /https:\/\/[^\s<>"']+(?:\s|$)/i.test(fragment);
    if (
      CLAUDE_CODE_ENTRY_PROMPT.test(fragment) ||
      completeUrl ||
      (this.authorizationUrl &&
        /(?:invalid|expired|incorrect).{0,40}(?:code|authori[sz])/i.test(fragment))
    ) {
      return this.parseOutput(stream, fragment);
    }
    return undefined;
  }

  submitCode(process: AuthManagedProcess, code: string): void {
    process.writeInput(`${code}\r`);
  }

  async verify(signal: AbortSignal): Promise<boolean> {
    return (await this.adapter.authStatus(signal)).state === 'authenticated';
  }
}

const CLAUDE_CODE_ENTRY_PROMPT =
  /\b(?:paste\s+code\s+here(?:\s+if\s+prompted)?|enter\s+(?:the\s+)?(?:(?:auth(?:entication)?|login|verification)\s+)?code)\b/i;

function isAuthorizationUrlContinuation(line: string): boolean {
  return /^[A-Za-z0-9._~:/?&=%+-]+$/.test(line);
}

export function createProviderAuthDrivers(
  options: ProviderAuthDriverOptions,
): ReadonlyMap<AuthProviderId, ProviderAuthDriver> {
  const drivers = new Map<AuthProviderId, ProviderAuthDriver>();
  const codex = options.adapters.get('codex');
  if (codex) drivers.set('codex', new CodexAuthDriver(options, codex));
  const antigravity = options.adapters.get('antigravity');
  if (antigravity) drivers.set('antigravity', new AntigravityAuthDriver(options, antigravity));
  const claudeCode = options.adapters.get('claude_code');
  if (claudeCode && hasClaudeCodeAuthStatus(claudeCode)) {
    drivers.set('claude_code', new ClaudeCodeAuthDriver(options, claudeCode));
  }
  return drivers;
}

function hasClaudeCodeAuthStatus(adapter: ProviderAdapter): adapter is ClaudeCodeAuthAdapter {
  return typeof (adapter as ClaudeCodeAuthAdapter).authStatus === 'function';
}

function extractUrl(line: string, providerId: AuthProviderId): string | undefined {
  const candidate = extractUrlCandidate(line);
  return candidate ? validateAuthorizationUrl(providerId, candidate) : undefined;
}

function extractUrlCandidate(line: string): string | undefined {
  const match = /https:\/\/[^\s<>"']+/i.exec(line)?.[0];
  return match?.replace(/[),.;]+$/, '');
}

function isClaudeCodeBootstrapUrlCandidate(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === 'claude.com' && url.pathname === '/cai/oauth/authorize';
  } catch {
    return false;
  }
}
