import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const executable = process.env.AWM_CODEX_EXECUTABLE;
const expectedVersion = process.env.CODEX_VERSION ?? '0.155.1';
const home = process.env.CODEX_HOME ?? '/tmp/awm-ops-002-codex-home';
const timeoutMs = 10_000;

if (!executable) throw new Error('AWM_CODEX_EXECUTABLE is required');
await mkdir(home, { recursive: true, mode: 0o700 });

const version = await new Promise((resolve, reject) => {
  const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.once('error', reject);
  child.once('close', (code) => {
    if (code === 0) resolve(stdout.trim());
    else reject(new Error(`codex --version exited ${code}: ${stderr.trim()}`));
  });
});

if (version !== `codex-cli ${expectedVersion}`) {
  throw new Error(`unexpected Codex version: ${version}`);
}

await new Promise((resolve, reject) => {
  const child = spawn(executable, ['app-server'], {
    env: { ...process.env, CODEX_HOME: home, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let initialized = false;
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
    if (error) reject(error);
    else resolve(undefined);
  };
  const timer = setTimeout(
    () => finish(new Error('Codex app-server initialize timed out')),
    timeoutMs,
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message.id === 1 && message.result?.codexHome === home) {
          initialized = true;
          finish();
          return;
        }
      } catch {
        finish(new Error('Codex app-server emitted malformed JSON'));
        return;
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
  });
  child.once('error', (error) => finish(error));
  child.once('close', (code, signal) => {
    if (!initialized)
      finish(
        new Error(
          `Codex app-server exited before initialize: code=${code} signal=${signal} stderr=${stderr.trim()}`,
        ),
      );
  });
  child.stdin.write(
    `${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'ai-window-manager', title: 'AI Window Manager', version: 'ops-002' },
      },
    })}\n`,
  );
});

console.log(`Codex ${version} executable and app-server initialize validated`);
