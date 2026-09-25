import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  bumpProviderClientPins,
  createOfficialReleaseSource,
  parseProviderClientManifest,
  serializeProviderClientManifest,
} from './provider-clients-core.js';

function rejectArguments(): void {
  if (process.argv.length > 2) {
    throw new Error('provider-clients:bump accepts no arguments');
  }
}

async function main(): Promise<void> {
  rejectArguments();
  const manifestPath = fileURLToPath(new URL('../provider-clients.lock.json', import.meta.url));
  const manifest = parseProviderClientManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const result = await bumpProviderClientPins(manifest, createOfficialReleaseSource());

  if (result.updated.length === 0) {
    console.log('Provider client source pins are already current; no files changed.');
    return;
  }

  await writeFile(manifestPath, serializeProviderClientManifest(result.manifest), 'utf8');
  for (const providerId of result.updated) {
    const pin = result.manifest.providers[providerId];
    console.log(`${providerId}: updated source pin metadata to ${pin.version} (${pin.tag}).`);
  }
  console.log('Only provider-clients.lock.json was updated. No binary was downloaded or executed.');
}

main().catch((error: unknown) => {
  console.error(
    `provider-clients:bump failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
});
