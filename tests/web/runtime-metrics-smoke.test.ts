import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { TEST_OPERATOR_ENV } from '../helpers/operator-auth.js';

const STARTUP_TIMEOUT_MS = 20_000;

it('starts the real offline bootstrap and preserves metrics access across graceful restart without logging credentials', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-runtime-metrics-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const token = 'synthetic-runtime-token-'.padEnd(43, 'x');
  const digest = createHash('sha256').update(token).digest('hex');
  const baseUrl = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let output = '';
  let startupOutput = '';
  async function start(metricsDigest: string): Promise<void> {
    startupOutput = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        ...TEST_OPERATOR_ENV,
        AWM_BIND: '127.0.0.1',
        AWM_PORT: String(port),
        AWM_DB_PATH: path.join(directory, 'state.db'),
        AWM_METRICS_TOKEN_SHA256: metricsDigest,
        AWM_PROVIDER_CLIENT_RUNTIME_ROOT: '',
        AWM_CODEX_ENABLED: 'false',
        AWM_ANTIGRAVITY_ENABLED: 'false',
        AWM_FAKE_PROVIDER_ENABLED: 'true',
        AWM_RECONCILE_INTERVAL_SECONDS: '1',
        AWM_EXECUTOR_INTERVAL_SECONDS: '1',
        AWM_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk: Buffer): void => {
      const text = chunk.toString();
      output = (output + text).slice(-100_000);
      startupOutput = (startupOutput + text).slice(-100_000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const currentChild = child;
    if (!currentChild) throw new Error('Offline runtime failed to spawn');
    const listeningMessage = `Server listening at ${baseUrl}`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        currentChild.stdout?.off('data', checkOutput);
        currentChild.stderr?.off('data', checkOutput);
        currentChild.off('error', onError);
        currentChild.off('exit', onExit);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const checkOutput = (): void => {
        if (startupOutput.includes(listeningMessage)) finish();
      };
      const onError = (error: Error): void => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        finish(
          new Error(
            `Offline runtime exited before listening (code ${code ?? 'none'}, signal ${signal ?? 'none'})`,
          ),
        );
      const timeout = setTimeout(
        () => finish(new Error(`Offline runtime did not listen within ${STARTUP_TIMEOUT_MS}ms`)),
        STARTUP_TIMEOUT_MS,
      );
      currentChild.stdout?.on('data', checkOutput);
      currentChild.stderr?.on('data', checkOutput);
      currentChild.once('error', onError);
      currentChild.once('exit', onExit);
      if (currentChild.exitCode !== null || currentChild.signalCode !== null)
        onExit(currentChild.exitCode, currentChild.signalCode);
      else checkOutput();
    });

    const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(2_000) });
    if (health.status !== 200)
      throw new Error(`Offline runtime listened but health returned ${health.status}`);
  }
  async function stop(): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const result: unknown[] = await exited;
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(null);
  }
  try {
    for (let restart = 0; restart < 2; restart++) {
      await start(digest);
      const headers = { authorization: `Bearer ${token}` };
      const response = await fetch(`${baseUrl}/metrics`, { headers });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('ai_window_loop_');
      expect((await fetch(`${baseUrl}/api/v1/diagnostics`, { headers })).status).toBe(401);
      expect((await fetch(`${baseUrl}/metrics?token=${token}`, { headers })).status).toBe(401);
      await stop();
    }
    await start('');
    expect(
      (await fetch(`${baseUrl}/metrics`, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    await stop();
    expect(output).not.toContain(token);
    expect(output).not.toContain(digest);
    expect(output).not.toContain(TEST_OPERATOR_ENV.AWM_AUTH_PASSWORD_HASH);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 70_000);
