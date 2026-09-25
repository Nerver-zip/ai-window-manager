import { emitKeypressEvents } from 'node:readline';
import { resolve } from 'node:path';
import type { ReadStream, WriteStream } from 'node:tty';
import { pathToFileURL } from 'node:url';
import { hashOperatorPassword } from '../src/auth/operator-password.js';

const MAX_PASSWORD_BYTES = 1024;
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';
const ENABLE_BRACKETED_PASTE = '\u001b[?2004h';
const DISABLE_BRACKETED_PASTE = '\u001b[?2004l';
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface Keypress {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly sequence?: string;
}

class PasswordPromptError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'PasswordPromptError';
  }
}

function isReturnKey(character: string | undefined, key: Keypress): boolean {
  return key.name === 'return' || character === '\r' || character === '\n';
}

function isBackspaceKey(character: string | undefined, key: Keypress): boolean {
  return key.name === 'backspace' || character === '\u007f' || character === '\b';
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

async function readHiddenInput(
  prompt: string,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== 'function' || !output.isTTY) {
    throw new PasswordPromptError('Password hash generation requires an interactive terminal.');
  }

  const previousRawMode = input.isRaw;
  const wasPaused = input.isPaused();
  let rawModeEnabled = false;
  let keypressListener: ((character: string | undefined, key: Keypress) => void) | undefined;
  let signalListener: (() => void) | undefined;
  const graphemes: string[] = [];

  try {
    emitKeypressEvents(input);
    output.write(ENABLE_BRACKETED_PASTE);
    input.setRawMode(true);
    rawModeEnabled = true;
    input.resume();
    output.write(prompt);

    return await new Promise<string>((resolveInput, rejectInput) => {
      let settled = false;
      let inBracketedPaste = false;

      const fail = (error: PasswordPromptError): void => {
        if (settled) return;
        settled = true;
        rejectInput(error);
      };

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        resolveInput(graphemes.join(''));
      };

      signalListener = () => fail(new PasswordPromptError('Cancelled.', 130));
      keypressListener = (character, key) => {
        if ((key.ctrl && key.name === 'c') || character === '\u0003') {
          fail(new PasswordPromptError('Cancelled.', 130));
          return;
        }
        if (key.sequence === BRACKETED_PASTE_START) {
          inBracketedPaste = true;
          return;
        }
        if (key.sequence === BRACKETED_PASTE_END) {
          inBracketedPaste = false;
          return;
        }
        if (inBracketedPaste && isReturnKey(character, key)) {
          fail(new PasswordPromptError('Password input cannot contain line breaks.'));
          return;
        }
        if (!inBracketedPaste && isReturnKey(character, key)) {
          succeed();
          return;
        }
        if (!inBracketedPaste && isBackspaceKey(character, key)) {
          if (graphemes.pop() !== undefined) output.write('\b \b');
          return;
        }
        if (key.ctrl || key.meta || !character) return;
        if (containsControlCharacters(character)) {
          if (inBracketedPaste) {
            fail(
              new PasswordPromptError('Password paste contains unsupported control characters.'),
            );
          }
          return;
        }

        for (const { segment } of graphemeSegmenter.segment(character)) {
          if (Buffer.byteLength(graphemes.join('') + segment, 'utf8') > MAX_PASSWORD_BYTES) {
            fail(new PasswordPromptError('Password exceeds the 1024-byte limit.'));
            return;
          }
          graphemes.push(segment);
          output.write('*');
        }
      };

      input.on('keypress', keypressListener);
      process.once('SIGINT', signalListener);
    });
  } finally {
    if (keypressListener) input.off('keypress', keypressListener);
    if (signalListener) process.off('SIGINT', signalListener);
    if (rawModeEnabled) input.setRawMode(previousRawMode);
    if (wasPaused) input.pause();
    output.write(`${DISABLE_BRACKETED_PASTE}\n`);
  }
}

async function run(): Promise<void> {
  try {
    const password = await readHiddenInput('Password: ');
    const confirmation = await readHiddenInput('Confirm password: ');
    if (password !== confirmation) {
      throw new PasswordPromptError('Passwords do not match.');
    }

    const encoded = await hashOperatorPassword(password);
    process.stdout.write(
      `${encoded}\nAdd it to .env as AWM_AUTH_PASSWORD_HASH, surrounded by single quotes for Compose.\n`,
    );
  } catch (error) {
    if (error instanceof PasswordPromptError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    process.stderr.write('Unable to generate an Argon2id password hash.\n');
    process.exitCode = 1;
  } finally {
    process.stdin.pause();
  }
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  void run();
}
