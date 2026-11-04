import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  claudeProcessEnvironment,
  runClaudeCli,
  type ClaudeCliRunOptions,
} from '../../../src/providers/claude-code/index.js';

function node(script: string, overrides: Partial<ClaudeCliRunOptions> = {}) {
  return runClaudeCli({
    executable: process.execPath,
    args: ['-e', script],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 5_000,
    maxStdoutBytes: 64 * 1024,
    ...overrides,
  });
}

describe('claudeProcessEnvironment', () => {
  it('builds an allowlisted environment isolated to the dedicated config directory', () => {
    const env = claudeProcessEnvironment('/claude-state', {
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
      HOME: '/home/someone',
      ANTHROPIC_API_KEY: 'synthetic',
      CLAUDE_CODE_OAUTH_TOKEN: 'synthetic',
      AWM_AUTH_PASSWORD_HASH: 'synthetic',
    });
    expect(env).toEqual({
      HOME: '/claude-state',
      CLAUDE_CONFIG_DIR: '/claude-state',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_UPDATES: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      TZ: 'UTC',
    });
  });
});

describe('runClaudeCli', () => {
  it('delivers complete lines, including an unterminated final line', async () => {
    const lines: string[] = [];
    const result = await node("process.stdout.write('one\\n\\n  two  \\nthree')", {
      onLine: (line) => {
        lines.push(line);
        return 'continue';
      },
    });
    expect(lines).toEqual(['one', 'two', 'three']);
    expect(result).toMatchObject({ started: true, exitCode: 0, overflow: false, stdout: '' });
  });

  it('collects bounded stdout only when asked', async () => {
    const result = await node('process.stdout.write(JSON.stringify({ok:true}))', {
      collectStdout: true,
    });
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });

  it('stops and terminates when the line callback asks or throws', async () => {
    const stopped = await node("console.log('a'); setInterval(() => {}, 1000)", {
      onLine: () => 'stop',
    });
    expect(stopped).toMatchObject({ stopped: true, signal: 'SIGTERM' });
    const thrown = await node("console.log('a'); setInterval(() => {}, 1000)", {
      onLine: () => {
        throw new Error('parser bug');
      },
    });
    expect(thrown.stopped).toBe(true);
  });

  it('bounds total stdout, single lines and pending partial lines', async () => {
    const total = await node("for (let i=0;i<200;i++) console.log('x'.repeat(1000))", {
      maxStdoutBytes: 10_000,
      onLine: () => 'continue',
    });
    expect(total.overflow).toBe(true);
    const longLine = await node("console.log('y'.repeat(5000))", {
      maxLineBytes: 100,
      onLine: () => 'continue',
    });
    expect(longLine.overflow).toBe(true);
    const partial = await node("process.stdout.write('z'.repeat(5000)); setInterval(()=>{},1000)", {
      maxLineBytes: 100,
    });
    expect(partial.overflow).toBe(true);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM on timeout', async () => {
    const result = await node(
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
      { timeoutMs: 1_500, onLine: () => 'continue' },
    );
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
  });

  it('terminates a child that floods stderr', async () => {
    const result = await node(
      "const b='e'.repeat(65536); (function w(){ process.stderr.write(b, w); })()",
      { timeoutMs: 5_000 },
    );
    expect(result.signal).toBe('SIGTERM');
  });

  it('reports cancellation and spawn failures without throwing', async () => {
    const controller = new AbortController();
    const pending = node('setInterval(() => {}, 1000)', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toMatchObject({ aborted: true, started: true });

    const missing = await runClaudeCli({
      executable: '/nonexistent/claude-awm-test',
      args: [],
      cwd: tmpdir(),
      env: {},
      timeoutMs: 1_000,
      maxStdoutBytes: 1_024,
    });
    expect(missing).toMatchObject({ started: false, exitCode: null });
  });
});
