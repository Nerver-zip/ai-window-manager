import {
  Algorithm,
  hash as argon2Hash,
  parseOptions,
  verify as argon2Verify,
  Version,
} from '@node-rs/argon2';

const MIN_MEMORY_COST_KIB = 19_456;
const MAX_MEMORY_COST_KIB = 262_144;
const MIN_TIME_COST = 2;
const MAX_TIME_COST = 10;
const MIN_PARALLELISM = 1;
const MAX_PARALLELISM = 4;
const MIN_SALT_BYTES = 16;
const MAX_SALT_BYTES = 64;
const MIN_HASH_BYTES = 16;
const MAX_HASH_BYTES = 64;
const MAX_ENCODED_HASH_LENGTH = 256;
const MAX_PASSWORD_BYTES = 1024;
const ARGON2ID_V19_PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(0|[1-9]\d*),t=(0|[1-9]\d*),p=(0|[1-9]\d*)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u;

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return (
    Number.isFinite(value) && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function isPasswordWithinBounds(password: string): boolean {
  const byteLength = Buffer.byteLength(password, 'utf8');
  return byteLength > 0 && byteLength <= MAX_PASSWORD_BYTES;
}

export function validateArgon2idPasswordHash(encoded: string): boolean {
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > MAX_ENCODED_HASH_LENGTH
  )
    return false;

  const phcMatch = ARGON2ID_V19_PHC_PATTERN.exec(encoded);
  if (!phcMatch) return false;

  const [, , , , salt, digest] = phcMatch;
  if (!salt || !digest || !isCanonicalPhcBase64(salt) || !isCanonicalPhcBase64(digest))
    return false;

  try {
    const parsed = parseOptions(encoded);
    return (
      parsed.algorithm === Algorithm.Argon2id &&
      parsed.version === Version.V0x13 &&
      isBoundedInteger(parsed.memoryCost, MIN_MEMORY_COST_KIB, MAX_MEMORY_COST_KIB) &&
      isBoundedInteger(parsed.timeCost, MIN_TIME_COST, MAX_TIME_COST) &&
      isBoundedInteger(parsed.parallelism, MIN_PARALLELISM, MAX_PARALLELISM) &&
      isBoundedInteger(parsed.saltLen, MIN_SALT_BYTES, MAX_SALT_BYTES) &&
      isBoundedInteger(parsed.outputLen, MIN_HASH_BYTES, MAX_HASH_BYTES)
    );
  } catch {
    return false;
  }
}

function isCanonicalPhcBase64(value: string): boolean {
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64').replace(/=+$/u, '') === value;
}

export async function hashOperatorPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || !isPasswordWithinBounds(password))
    throw new Error('Password must contain between 1 and 1024 UTF-8 bytes.');

  try {
    const encoded = await argon2Hash(password, {
      algorithm: Algorithm.Argon2id,
      version: Version.V0x13,
      memoryCost: MIN_MEMORY_COST_KIB,
      timeCost: MIN_TIME_COST,
      parallelism: MIN_PARALLELISM,
      outputLen: 32,
    });
    const parsed = parseOptions(encoded);
    if (
      !validateArgon2idPasswordHash(encoded) ||
      parsed.memoryCost !== MIN_MEMORY_COST_KIB ||
      parsed.timeCost !== MIN_TIME_COST ||
      parsed.parallelism !== MIN_PARALLELISM
    ) {
      throw new Error('Generated hash did not match the configured Argon2id parameters.');
    }
    return encoded;
  } catch {
    throw new Error('Unable to generate an Argon2id password hash.');
  }
}

export async function verifyOperatorPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (
    typeof password !== 'string' ||
    !isPasswordWithinBounds(password) ||
    !validateArgon2idPasswordHash(encodedHash)
  ) {
    return false;
  }

  try {
    return await argon2Verify(encodedHash, password);
  } catch {
    return false;
  }
}
