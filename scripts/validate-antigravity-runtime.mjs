import { accessSync, constants, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const executable = process.env.AWM_ANTIGRAVITY_EXECUTABLE ?? '/opt/antigravity/bin/agy';
const expectedVersion = process.env.AGY_EXPECTED_VERSION ?? '1.2.9';

function fail(message) {
  console.error(`antigravity runtime check failed: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 10_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error || result.status !== 0) {
    fail(`${command} is unavailable`);
  }
  return result.stdout.trim();
}

try {
  accessSync(executable, constants.X_OK);
} catch {
  fail('official executable is not installed');
}

const version = run(executable, ['--version']);
if (version !== expectedVersion) {
  fail('official executable version does not match the pinned release');
}

run('dbus-run-session', ['--version']);
run('gnome-keyring-daemon', ['--version']);

const runtimeRoot = '/tmp/awm-antigravity-runtime-check';
const home = `${runtimeRoot}/home`;
const runtimeDir = `${runtimeRoot}/run`;
mkdirSync(home, { recursive: true, mode: 0o700 });
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

const check = spawnSync(
  'dbus-run-session',
  [
    '--',
    'sh',
    '-eu',
    '-c',
    'gnome-keyring-daemon --start --components=secrets >/dev/null 2>&1 && test -S "$XDG_RUNTIME_DIR/keyring/control"',
  ],
  {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_DATA_HOME: `${home}/.local/share`,
      XDG_RUNTIME_DIR: runtimeDir,
    },
  },
);

if (check.error || check.status !== 0) {
  fail('D-Bus session and Secret Service could not start');
}

console.log(`antigravity-cli ${version}`);
console.log('dbus-session ok');
console.log('secret-service ok');
