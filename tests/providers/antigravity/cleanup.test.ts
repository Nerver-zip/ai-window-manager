import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AntigravityCleanupError,
  deleteAntigravityConversation,
} from '../../../src/providers/antigravity/cleanup.js';

const resources: string[] = [];
const conversationId = '00000000-0000-4000-8000-000000000001';

afterEach(async () => {
  for (const directory of resources.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function createHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'awm-agy-cleanup-'));
  resources.push(home);
  const root = path.join(home, '.gemini', 'antigravity-cli');
  const conversations = path.join(root, 'conversations');
  const brain = path.join(root, 'brain');
  await fs.mkdir(conversations, { recursive: true });
  await fs.mkdir(brain, { recursive: true });
  return { home, root, conversations, brain };
}

describe('Antigravity per-conversation cleanup', () => {
  it('removes only the exact AWM conversation DB, SQLite sidecars and brain directory', async () => {
    const { home, conversations, brain } = await createHome();
    const db = path.join(conversations, `${conversationId}.db`);
    const brainConversation = path.join(brain, conversationId);
    await fs.writeFile(db, 'synthetic conversation database');
    await fs.writeFile(`${db}-wal`, 'synthetic wal');
    await fs.writeFile(`${db}-shm`, 'synthetic shm');
    await fs.writeFile(`${db}-journal`, 'synthetic journal');
    await fs.mkdir(path.join(brainConversation, 'nested'), { recursive: true });
    await fs.writeFile(path.join(brainConversation, 'nested', 'transcript.jsonl'), 'synthetic');

    const otherId = '00000000-0000-4000-8000-000000000002';
    const otherDb = path.join(conversations, `${otherId}.db`);
    const summaryDb = path.join(conversations, 'conversation_summaries.db');
    const otherBrain = path.join(brain, otherId);
    await fs.writeFile(otherDb, 'unrelated conversation');
    await fs.writeFile(summaryDb, 'provider-owned summary index');
    await fs.mkdir(otherBrain);
    await fs.writeFile(path.join(otherBrain, 'unrelated'), 'keep');

    await deleteAntigravityConversation(home, conversationId);

    await expect(fs.access(db)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(`${db}-wal`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(`${db}-shm`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(`${db}-journal`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(brainConversation)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(otherDb, 'utf8')).resolves.toBe('unrelated conversation');
    await expect(fs.readFile(summaryDb, 'utf8')).resolves.toBe('provider-owned summary index');
    await expect(fs.readFile(path.join(otherBrain, 'unrelated'), 'utf8')).resolves.toBe('keep');
  });

  it('is idempotent when the provider has already removed the exact artifacts', async () => {
    const { home } = await createHome();

    await expect(deleteAntigravityConversation(home, conversationId)).resolves.toBeUndefined();
    await expect(deleteAntigravityConversation(home, conversationId)).resolves.toBeUndefined();
  });

  it('treats an absent home or absent optional provider directories as already clean', async () => {
    const absentParent = await fs.mkdtemp(path.join(os.tmpdir(), 'awm-agy-cleanup-absent-'));
    resources.push(absentParent);
    const absentHome = path.join(absentParent, 'missing-home');
    await expect(
      deleteAntigravityConversation(absentHome, conversationId),
    ).resolves.toBeUndefined();

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'awm-agy-cleanup-empty-'));
    resources.push(home);
    await expect(deleteAntigravityConversation(home, conversationId)).resolves.toBeUndefined();
    await fs.mkdir(path.join(home, '.gemini'));
    await expect(deleteAntigravityConversation(home, conversationId)).resolves.toBeUndefined();
  });

  it('removes an exact brain folder when no conversations database directory exists', async () => {
    const { home, conversations, brain } = await createHome();
    await fs.rm(conversations, { recursive: true });
    const target = path.join(brain, conversationId);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'transcript.jsonl'), 'synthetic');

    await expect(deleteAntigravityConversation(home, conversationId)).resolves.toBeUndefined();
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not touch paths for IDs that are not canonical UUIDs', async () => {
    const { home } = await createHome();

    await expect(deleteAntigravityConversation(home, '../conversation')).rejects.toBeInstanceOf(
      AntigravityCleanupError,
    );
    await expect(
      deleteAntigravityConversation(home, 'synthetic-antigravity-conversation'),
    ).rejects.toMatchObject({ code: 'ANTIGRAVITY_CLEANUP_PATH_UNSAFE' });
  });

  it('rejects symlinked provider directories and symlinked conversation files', async () => {
    const { home, conversations } = await createHome();
    const linkedRoot = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    const displaced = path.join(home, 'displaced');
    await fs.rename(linkedRoot, displaced);
    await fs.symlink(displaced, linkedRoot);

    await expect(deleteAntigravityConversation(home, conversationId)).rejects.toMatchObject({
      code: 'ANTIGRAVITY_CLEANUP_PATH_UNSAFE',
    });
    await fs.unlink(linkedRoot);
    await fs.rename(displaced, conversations);

    const target = path.join(home, 'external.db');
    const linkedConversation = path.join(conversations, `${conversationId}.db`);
    await fs.writeFile(target, 'outside');
    await fs.symlink(target, linkedConversation);
    await expect(deleteAntigravityConversation(home, conversationId)).rejects.toMatchObject({
      code: 'ANTIGRAVITY_CLEANUP_PATH_UNSAFE',
    });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('outside');
  });

  it('rejects symlinked homes and non-directory per-ID brain artifacts', async () => {
    const { home, brain } = await createHome();
    const linkContainer = await fs.mkdtemp(path.join(os.tmpdir(), 'awm-agy-cleanup-link-'));
    resources.push(linkContainer);
    const homeLink = path.join(linkContainer, 'home');
    await fs.symlink(home, homeLink, 'dir');
    await expect(deleteAntigravityConversation(homeLink, conversationId)).rejects.toMatchObject({
      code: 'ANTIGRAVITY_CLEANUP_PATH_UNSAFE',
    });

    const nonDirectory = path.join(brain, conversationId);
    await fs.writeFile(nonDirectory, 'synthetic, not a chat directory');
    await expect(deleteAntigravityConversation(home, conversationId)).rejects.toMatchObject({
      code: 'ANTIGRAVITY_CLEANUP_PATH_UNSAFE',
    });
    await expect(fs.readFile(nonDirectory, 'utf8')).resolves.toBe(
      'synthetic, not a chat directory',
    );
  });

  it('rejects a symlinked exact brain folder without deleting its target', async () => {
    const { home, brain } = await createHome();
    const outside = path.join(home, 'outside-brain-folder');
    const linked = path.join(brain, conversationId);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'outside');
    await fs.symlink(outside, linked, 'dir');

    await expect(deleteAntigravityConversation(home, conversationId)).rejects.toMatchObject({
      code: 'ANTIGRAVITY_CLEANUP_PATH_UNSAFE',
    });
    await expect(fs.readFile(path.join(outside, 'keep'), 'utf8')).resolves.toBe('outside');
  });

  it('bounds non-missing path and permission failures without touching other artifacts', async () => {
    const overlongHome = `/${'x'.repeat(5_000)}`;
    await expect(deleteAntigravityConversation(overlongHome, conversationId)).rejects.toMatchObject(
      { code: 'ANTIGRAVITY_CLEANUP_FAILED' },
    );

    const { home, conversations, brain } = await createHome();
    const targetDb = path.join(conversations, `${conversationId}.db`);
    await fs.writeFile(targetDb, 'synthetic conversation data');
    await fs.chmod(conversations, 0o500);
    try {
      await expect(deleteAntigravityConversation(home, conversationId)).rejects.toMatchObject({
        code: 'ANTIGRAVITY_CLEANUP_FAILED',
      });
    } finally {
      await fs.chmod(conversations, 0o700);
    }

    await fs.chmod(conversations, 0o400);
    try {
      await expect(deleteAntigravityConversation(home, conversationId)).rejects.toMatchObject({
        code: 'ANTIGRAVITY_CLEANUP_FAILED',
      });
    } finally {
      await fs.chmod(conversations, 0o700);
    }

    const brainTarget = path.join(brain, conversationId);
    await fs.mkdir(brainTarget);
    await fs.writeFile(path.join(brainTarget, 'transcript.jsonl'), 'synthetic');
    await fs.chmod(brain, 0o500);
    try {
      await expect(deleteAntigravityConversation(home, conversationId)).rejects.toMatchObject({
        code: 'ANTIGRAVITY_CLEANUP_FAILED',
      });
    } finally {
      await fs.chmod(brain, 0o700);
    }
  });
});
