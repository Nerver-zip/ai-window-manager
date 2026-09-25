import { lstat, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AntigravityCleanupError extends Error {
  constructor(readonly code: 'ANTIGRAVITY_CLEANUP_PATH_UNSAFE' | 'ANTIGRAVITY_CLEANUP_FAILED') {
    super(`Antigravity cleanup ${code.toLowerCase().replaceAll('_', ' ')}`);
    this.name = 'AntigravityCleanupError';
  }
}

/**
 * Remove only the two known per-conversation artifacts created by the AWM CLI
 * home. This is a narrowly scoped filesystem cleanup, not an official agy API.
 */
export async function deleteAntigravityConversation(
  antigravityHome: string,
  conversationId: string,
): Promise<void> {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new AntigravityCleanupError('ANTIGRAVITY_CLEANUP_PATH_UNSAFE');
  }

  const home = path.resolve(antigravityHome);
  let realHome: string;
  try {
    realHome = await realpath(home);
  } catch (error) {
    if (isMissing(error)) return;
    throw new AntigravityCleanupError('ANTIGRAVITY_CLEANUP_FAILED');
  }
  if (realHome !== home) throw new AntigravityCleanupError('ANTIGRAVITY_CLEANUP_PATH_UNSAFE');

  const cliRoot = path.join(home, '.gemini', 'antigravity-cli');
  if (!(await isSafeDirectory(home, path.join(home, '.gemini')))) return;
  if (!(await isSafeDirectory(path.join(home, '.gemini'), cliRoot))) return;

  const id = conversationId.toLowerCase();
  const conversationsDir = path.join(cliRoot, 'conversations');
  if (await isSafeDirectory(cliRoot, conversationsDir)) {
    const databasePath = path.join(conversationsDir, `${id}.db`);
    for (const target of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ]) {
      await removeRegularFile(target);
    }
  }

  const brainDir = path.join(cliRoot, 'brain');
  if (await isSafeDirectory(cliRoot, brainDir)) {
    const conversationDir = path.join(brainDir, id);
    const stat = await lstatIfPresent(conversationDir);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AntigravityCleanupError('ANTIGRAVITY_CLEANUP_PATH_UNSAFE');
    }
    try {
      await rm(conversationDir, { recursive: true, force: false });
    } catch {
      throw new AntigravityCleanupError('ANTIGRAVITY_CLEANUP_FAILED');
    }
  }
}

async function isSafeDirectory(parent: string, directory: string): Promise<boolean> {
  const stat = await lstatIfPresent(directory);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.dirname(directory) !== parent) {
    throw new AntigravityCleanupError('ANTIGRAVITY_CLEANUP_PATH_UNSAFE');
  }
  return true;
}

async function removeRegularFile(filePath: string): Promise<void> {
  const stat = await lstatIfPresent(filePath);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AntigravityCleanupError('ANTIGRAVITY_CLEANUP_PATH_UNSAFE');
  }
  try {
    await unlink(filePath);
  } catch {
    throw new AntigravityCleanupError('ANTIGRAVITY_CLEANUP_FAILED');
  }
}

async function lstatIfPresent(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new AntigravityCleanupError('ANTIGRAVITY_CLEANUP_FAILED');
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
