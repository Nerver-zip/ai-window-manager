import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const documentation = fs.readFileSync(path.join(root, 'docs/metrics.md'), 'utf8');
const configuration = documentation.match(/```yaml\n([\s\S]*?)\n```/)?.[1];
assert.ok(configuration, 'Metrics documentation must contain the scraper configuration');
assert.ok(configuration.includes('credentials_file: /etc/prometheus/secrets/awm-metrics-token'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'awm-prometheus-config-smoke-'));
let containerId;
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr || 'Unable to run isolated promtool validation');
  }
  return result.stdout;
}
try {
  fs.mkdirSync(path.join(temporary, 'secrets'), { mode: 0o700 });
  fs.writeFileSync(path.join(temporary, 'prometheus.yml'), configuration, { mode: 0o600 });
  fs.writeFileSync(
    path.join(temporary, 'secrets/awm-metrics-token'),
    'synthetic-metrics-config-'.padEnd(43, 'x'),
    { mode: 0o600 },
  );
  containerId = docker([
    'create',
    '--name',
    `awm-prometheus-config-smoke-${process.pid}-${path.basename(temporary)}`,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--entrypoint',
    '/bin/promtool',
    'prom/prometheus:v3.5.0',
    'check',
    'config',
    '/etc/prometheus/prometheus.yml',
  ]).trim();
  // Copy only disposable synthetic fixtures; no host mounts or account access.
  docker(['cp', '--archive', `${temporary}/.`, `${containerId}:/etc/prometheus/`]);
  process.stdout.write(docker(['start', '--attach', containerId]));
  const exitCode = docker(['inspect', '--format', '{{.State.ExitCode}}', containerId]).trim();
  assert.equal(exitCode, '0', 'promtool rejected documented configuration');
  process.stdout.write(
    'prometheus-config-smoke: documented credentials_file configuration passed\n',
  );
} finally {
  if (containerId) docker(['rm', '--force', containerId]);
  fs.rmSync(temporary, { recursive: true, force: true });
}
