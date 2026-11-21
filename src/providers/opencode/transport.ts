import {
  runCliProcess,
  type CliProcessFactory,
  type CliRunOptions,
  type CliRunResult,
} from '../cli-process.js';

export type OpenCodeProcessFactory = CliProcessFactory;
export type OpenCodeCliRunOptions = CliRunOptions;
export type OpenCodeCliRunResult = CliRunResult;

/** Run one bounded official OpenCode process (shared bounded-process runner). */
export const runOpenCodeCli = runCliProcess;

/**
 * Minimal environment for every official OpenCode invocation. Provider
 * credentials and API keys from the daemon environment (`OPENCODE_*`, vendor
 * keys, AWM secrets) are never inherited. The dedicated home directory is
 * HOME and every XDG base directory, so the client keeps its own credentials,
 * database and cache inside AWM's isolated state and cannot touch another
 * profile. OpenCode's self-updater is disabled because AWM governs the
 * executable.
 */
export function openCodeProcessEnvironment(
  homeDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: homeDirectory,
    XDG_DATA_HOME: `${homeDirectory}/.local/share`,
    XDG_CONFIG_HOME: `${homeDirectory}/.config`,
    XDG_STATE_HOME: `${homeDirectory}/.local/state`,
    XDG_CACHE_HOME: `${homeDirectory}/.cache`,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
