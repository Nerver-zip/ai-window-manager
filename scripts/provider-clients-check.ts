import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  checkProviderClientPins,
  createOfficialReleaseSource,
  parseProviderClientManifest,
} from './provider-clients-core.js';

function rejectArguments(): void {
  if (process.argv.length > 2) {
    throw new Error('provider-clients:check accepts no arguments');
  }
}

async function main(): Promise<void> {
  rejectArguments();
  const manifestPath = fileURLToPath(new URL('../provider-clients.lock.json', import.meta.url));
  const manifest = parseProviderClientManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const statuses = await checkProviderClientPins(manifest, createOfficialReleaseSource());

  console.log('Provider client source pins');
  for (const status of statuses) {
    const suffix = status.status === 'update-available' ? ' · update available' : '';
    const ahead =
      status.status === 'pinned-ahead' ? ' · pinned version is ahead of latest stable' : '';
    console.log(
      `${status.displayName}: pinned ${status.pinnedVersion} · latest ${status.latestVersion}${suffix}${ahead}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    `provider-clients:check failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
});
