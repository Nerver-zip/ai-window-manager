import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function generateMetricsCredential(): { token: string; digest: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, digest: createHash('sha256').update(token, 'utf8').digest('hex') };
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  const { token, digest } = generateMetricsCredential();
  process.stdout.write(
    `Metrics token (displayed once): ${token}\nAWM_METRICS_TOKEN_SHA256=${digest}\n` +
      'Configure only the digest in the server environment. Store the token in a private\n' +
      'Prometheus credentials_file (mode 0600), never in Git, URLs or server .env.\n' +
      'Protect terminal scrollback and use TLS or a trusted private VPN.\n',
  );
}
