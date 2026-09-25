import { Algorithm, parseOptions, Version } from '@node-rs/argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hashOperatorPassword,
  validateArgon2idPasswordHash,
  verifyOperatorPassword,
} from '../../src/auth/operator-password.js';

const TEST_PASSWORD = 'synthetic-test-password-only';

describe('operator password hashing', () => {
  let generatedHash: string;

  beforeEach(async () => {
    generatedHash = await hashOperatorPassword(TEST_PASSWORD);
  });

  it('generates a PHC Argon2id v=19 hash with the exact policy parameters', () => {
    const options = parseOptions(generatedHash);

    expect(generatedHash).toMatch(/^\$argon2id\$v=19\$/u);
    expect(options).toMatchObject({
      algorithm: Algorithm.Argon2id,
      version: Version.V0x13,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
      saltLen: 16,
    });
    expect(validateArgon2idPasswordHash(generatedHash)).toBe(true);
  });

  it('verifies a correct password and rejects a mismatch', async () => {
    await expect(verifyOperatorPassword(TEST_PASSWORD, generatedHash)).resolves.toBe(true);
    await expect(
      verifyOperatorPassword('different-synthetic-password', generatedHash),
    ).resolves.toBe(false);
  });

  it('rejects malformed or unsafe PHC strings', () => {
    const invalidHashes = [
      '',
      'not-a-hash',
      '$2b$12$synthetic-bcrypt-hash',
      generatedHash.replace('$argon2id$', '$argon2i$'),
      generatedHash.replace('$argon2id$', '$argon2d$'),
      generatedHash.replace('v=19', 'v=16'),
      generatedHash.replace('m=19456', 'm=19455'),
      generatedHash.replace('t=2', 't=1'),
      generatedHash.replace('p=1', 'p=0'),
      generatedHash.replace('m=19456', 'm=262145'),
      generatedHash.replace('t=2', 't=11'),
      generatedHash.replace('p=1', 'p=5'),
      generatedHash.replace('m=19456,t=2,p=1', 'm=19456,t=2,t=2,p=1'),
      generatedHash.replace('m=19456,t=2,p=1', 'm=19456,t=2,p=1,x=1'),
      generatedHash.replace('m=19456,t=2,p=1', 't=2,m=19456,p=1'),
      `${generatedHash}${'x'.repeat(257)}`,
    ];

    for (const encoded of invalidHashes) {
      expect(validateArgon2idPasswordHash(encoded)).toBe(false);
    }
  });

  it('accepts safe upper-bound work factors but rejects malformed salt or output lengths', () => {
    const upperBoundHash = generatedHash.replace('m=19456,t=2,p=1', 'm=262144,t=10,p=4');
    const saltTooShort = generatedHash.replace(/\$([^$]+)\$([^$]+)$/u, '$AA$2');
    const outputTooShort = generatedHash.replace(/\$([^$]+)$/u, '$AA');

    expect(validateArgon2idPasswordHash(upperBoundHash)).toBe(true);
    expect(validateArgon2idPasswordHash(saltTooShort)).toBe(false);
    expect(validateArgon2idPasswordHash(outputTooShort)).toBe(false);
  });

  it('rejects empty and oversized password inputs without including them in errors', async () => {
    const oversizedPassword = 'synthetic'.repeat(130);

    await expect(hashOperatorPassword('')).rejects.toThrow(
      'Password must contain between 1 and 1024 UTF-8 bytes.',
    );
    await expect(hashOperatorPassword(oversizedPassword)).rejects.toThrow(
      'Password must contain between 1 and 1024 UTF-8 bytes.',
    );
    await expect(verifyOperatorPassword('', generatedHash)).resolves.toBe(false);
    await expect(verifyOperatorPassword(TEST_PASSWORD, 'synthetic-invalid-hash')).resolves.toBe(
      false,
    );
    expect(() => validateArgon2idPasswordHash(oversizedPassword)).not.toThrow();
  });

  it('sanitizes native-library failures and never exposes the supplied PHC value', async () => {
    const sensitiveHash = generatedHash;
    const nativeFailure = new Error(`failed to parse ${sensitiveHash}`);
    const actual = await import('@node-rs/argon2');
    vi.doMock('@node-rs/argon2', () => ({
      ...actual,
      hash: vi.fn().mockRejectedValue(nativeFailure),
      verify: vi.fn().mockRejectedValue(nativeFailure),
    }));

    try {
      vi.resetModules();
      const isolated = await import('../../src/auth/operator-password.js');
      await expect(isolated.hashOperatorPassword(TEST_PASSWORD)).rejects.toThrow(
        'Unable to generate an Argon2id password hash.',
      );
      await expect(isolated.verifyOperatorPassword(TEST_PASSWORD, sensitiveHash)).resolves.toBe(
        false,
      );
    } finally {
      vi.doUnmock('@node-rs/argon2');
      vi.resetModules();
    }
  });
});
