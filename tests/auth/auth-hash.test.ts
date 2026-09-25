import { spawnSync } from 'node:child_process';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import { parseOptions } from '@node-rs/argon2';
import {
  validateArgon2idPasswordHash,
  verifyOperatorPassword,
} from '../../src/auth/operator-password.js';

const PASSWORD = 'synthetic-awm-🪟';
const PROMPT_TIMEOUT_MS = 8_000;
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

const children = new Set<IPty>();

afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
});

function waitForOutput(
  output: () => string,
  marker: string,
  subscribe: (listener: () => void) => () => void,
): Promise<void> {
  if (output().includes(marker)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const unsubscribe = subscribe(() => {
      if (!output().includes(marker)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for prompt marker: ${marker}; output=${output()}`));
    }, PROMPT_TIMEOUT_MS);
  });
}

function waitForExit(child: IPty): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Hash prompt process did not exit.')), 10_000);
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
}

function launchPrompt(): {
  child: IPty;
  output: () => string;
  subscribe: (listener: () => void) => () => void;
} {
  const child = spawnPty(process.execPath, ['--import', 'tsx', 'scripts/auth-hash.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
    name: 'xterm-256color',
    cols: 100,
    rows: 24,
  });
  children.add(child);

  let captured = '';
  const listeners = new Set<() => void>();
  child.onData((chunk) => {
    captured += chunk;
    for (const listener of listeners) listener();
  });

  return {
    child,
    output: () => captured.replace(ANSI_SEQUENCE, ''),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe('auth:hash command', () => {
  it('hides pasted UTF-8 input, handles grapheme backspace and prints a Compose-ready PHC hash', async () => {
    const { child, output, subscribe } = launchPrompt();
    const exited = waitForExit(child);

    await waitForOutput(output, 'Password: ', subscribe);
    child.write(`\u001b[200~${PASSWORD}\u001b[201~\r`);
    await waitForOutput(output, 'Confirm password: ', subscribe);
    child.write(`${PASSWORD}\u007f🪟\r`);
    await waitForOutput(output, '$argon2id$', subscribe);

    expect(await exited).toBe(0);
    const terminalOutput = output();
    const encodedHash = terminalOutput.match(
      /\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+/u,
    )?.[0];

    expect(terminalOutput).not.toContain(PASSWORD);
    expect(terminalOutput).toContain('single quotes for Compose');
    expect(encodedHash).toBeDefined();
    expect(validateArgon2idPasswordHash(encodedHash!)).toBe(true);
    expect(parseOptions(encodedHash!)).toMatchObject({
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    await expect(verifyOperatorPassword(PASSWORD, encodedHash!)).resolves.toBe(true);
  }, 15_000);

  it('refuses non-TTY input without reading or echoing a piped password', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/auth-hash.ts'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: 'synthetic-piped-input-must-not-be-read',
    });
    const combinedOutput = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(combinedOutput).toContain('requires an interactive terminal');
    expect(combinedOutput).not.toContain('synthetic-piped-input-must-not-be-read');
    expect(combinedOutput).not.toContain('$argon2id$');
  });

  it('rejects mismatched confirmation without printing a hash or either input', async () => {
    const { child, output, subscribe } = launchPrompt();
    const exited = waitForExit(child);

    await waitForOutput(output, 'Password: ', subscribe);
    child.write('synthetic-first\r');
    await waitForOutput(output, 'Confirm password: ', subscribe);
    child.write('synthetic-second\r');

    expect(await exited).toBe(1);
    expect(output()).toContain('Passwords do not match.');
    expect(output()).not.toContain('synthetic-first');
    expect(output()).not.toContain('synthetic-second');
    expect(output()).not.toContain('$argon2id$');
  }, 15_000);

  it('handles Ctrl-C and exits without printing a hash', async () => {
    const { child, output, subscribe } = launchPrompt();
    const exited = waitForExit(child);

    await waitForOutput(output, 'Password: ', subscribe);
    child.write('\u0003');

    expect(await exited).toBe(130);
    expect(output()).toContain('Cancelled.');
    expect(output()).not.toContain('$argon2id$');
  }, 15_000);
});
