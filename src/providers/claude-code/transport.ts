import {
  runCliProcess,
  type CliProcessFactory,
  type CliRunOptions,
  type CliRunResult,
  type CliSpawnOptions,
} from '../cli-process.js';

export type ClaudeSpawnOptions = CliSpawnOptions;
export type ClaudeProcessFactory = CliProcessFactory;
export type ClaudeCliRunOptions = CliRunOptions;
export type ClaudeCliRunResult = CliRunResult;

/** Run one bounded official Claude Code process (shared bounded-process runner). */
export const runClaudeCli = runCliProcess;

/**
 * Minimal environment for every official Claude Code invocation. Provider
 * credentials and API keys from the daemon environment are never inherited;
 * the dedicated configuration directory is both HOME and CLAUDE_CONFIG_DIR so
 * the CLI cannot touch another profile. Claude Code's own updater is disabled
 * because AWM manages the pinned executable.
 */
export function claudeProcessEnvironment(
  configDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: configDirectory,
    CLAUDE_CONFIG_DIR: configDirectory,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
  };
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
