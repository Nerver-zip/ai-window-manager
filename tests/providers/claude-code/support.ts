import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type {
  ClaudeProcessFactory,
  ClaudeSpawnOptions,
} from '../../../src/providers/claude-code/index.js';

export interface FakeInvocation {
  executable: string;
  args: string[];
  options: ClaudeSpawnOptions;
}

export interface FakeScript {
  /** stdout lines (objects are JSON-encoded) */
  lines?: Array<string | Record<string, unknown>>;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** never exit unless killed */
  hang?: boolean;
  /** emit an 'error' instead of spawning */
  spawnError?: boolean;
  /** throw synchronously from the factory */
  throwOnSpawn?: boolean;
  stderr?: string;
  /** raw stdout chunk written verbatim before lines */
  raw?: string;
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal;
      setImmediate(() => this.emit('close', null, signal));
    }
    return true;
  }
}

export function fakeClaude(
  scripts: FakeScript[] | ((invocation: FakeInvocation) => FakeScript),
): ClaudeProcessFactory & { invocations: FakeInvocation[]; children: FakeChild[] } {
  const invocations: FakeInvocation[] = [];
  const children: FakeChild[] = [];
  let index = 0;
  const factory = ((executable: string, args: string[], options: ClaudeSpawnOptions) => {
    const invocation = { executable, args, options };
    invocations.push(invocation);
    const script =
      typeof scripts === 'function' ? scripts(invocation) : (scripts[index++] ?? { exitCode: 0 });
    if (script.throwOnSpawn) throw new Error('spawn failed');
    const child = new FakeChild();
    children.push(child);
    setImmediate(() => {
      if (script.spawnError) {
        child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return;
      }
      child.emit('spawn');
      if (script.stderr) child.stderr.write(script.stderr);
      if (script.raw) child.stdout.write(script.raw);
      for (const line of script.lines ?? []) {
        child.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
      }
      if (script.hang) return;
      setImmediate(() => {
        if (child.signalCode !== null) return;
        child.exitCode = script.exitCode === undefined ? 0 : script.exitCode;
        child.emit('close', child.exitCode, script.signal ?? null);
      });
    });
    return child as unknown as ChildProcess;
  }) as ClaudeProcessFactory & { invocations: FakeInvocation[]; children: FakeChild[] };
  factory.invocations = invocations;
  factory.children = children;
  return factory;
}

export const INIT_EVENT = {
  type: 'system',
  subtype: 'init',
  session_id: '00000000-0000-4000-8000-000000000000',
  tools: [],
  mcp_servers: [],
  model: 'claude-haiku-5-5',
  apiKeySource: 'none',
  permissionMode: 'default',
};

export function usageMessage(usageReport?: unknown): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: 'synthetic usage text that must never be retained' }],
    },
    local_command_run: { command: 'usage', args: '' },
    ...(usageReport === undefined ? {} : { usage_report: usageReport }),
  };
}

export const USAGE_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 0,
  duration_api_ms: 0,
  local_command: 'usage',
  result: 'synthetic result text',
};

export function meter(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'session',
    group: 'session',
    percent: 25,
    resets_at: '2026-11-03T15:00:00.000Z',
    severity: 'normal',
    is_active: true,
    ...overrides,
  };
}

export function usageReport(limits: unknown): Record<string, unknown> {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {},
    },
    rate_limits: { limits, extra_usage: null },
  };
}

export function usageRun(limits: unknown): FakeScript {
  return { lines: [INIT_EVENT, usageMessage(usageReport(limits)), USAGE_RESULT], exitCode: 0 };
}

export function authStatus(value: Record<string, unknown>, exitCode = 0): FakeScript {
  return { lines: [JSON.stringify(value, null, 2)], exitCode };
}
