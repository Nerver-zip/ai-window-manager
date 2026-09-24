import { z } from 'zod';

const MAX_GROUPS = 16;
const MAX_BUCKETS_PER_GROUP = 8;
const MAX_TEXT_LENGTH = 512;
const MAX_ERROR_LENGTH = 2_048;

const UsageWindowSchema = z.enum(['5h', 'weekly']);

const UsageBucketSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().max(MAX_TEXT_LENGTH).optional(),
    description: z.string().max(MAX_TEXT_LENGTH).optional(),
    window: UsageWindowSchema,
    remaining_fraction: z.number().finite().min(0).max(1),
    reset_time: z.union([z.iso.datetime({ offset: false }), z.null()]).optional(),
  })
  .passthrough();

const UsageGroupSchema = z
  .object({
    name: z.string().min(1).max(MAX_TEXT_LENGTH),
    description: z.string().max(MAX_TEXT_LENGTH).optional(),
    buckets: z.array(UsageBucketSchema).min(1).max(MAX_BUCKETS_PER_GROUP),
  })
  .passthrough();

const UsageCommandSchema = z
  .object({
    name: z.string().min(1).max(64),
    data: z
      .object({
        description: z.string().max(MAX_TEXT_LENGTH).optional(),
        groups: z.array(UsageGroupSchema).max(MAX_GROUPS),
      })
      .passthrough(),
  })
  .passthrough();

const UsageTokenSchema = z
  .record(z.string().max(64), z.number().finite().nonnegative().max(1_000_000_000_000))
  .optional();

export const AntigravityUsageEnvelopeSchema = z
  .object({
    status: z.enum([
      'SUCCESS',
      'ERROR',
      'CANCELED',
      'INTERRUPTED',
      'INVALID',
      'WAITING',
      'RUNNING',
    ]),
    response: z
      .string()
      .max(64 * 1024)
      .optional(),
    error: z.string().max(MAX_ERROR_LENGTH).optional(),
    usage: UsageTokenSchema,
    command: UsageCommandSchema.optional(),
  })
  .passthrough();

export type AntigravityUsageEnvelope = z.infer<typeof AntigravityUsageEnvelopeSchema>;
export type AntigravityUsageGroup = z.infer<typeof UsageGroupSchema>;
export type AntigravityUsageBucket = z.infer<typeof UsageBucketSchema>;

export class AntigravityOutputError extends Error {
  constructor() {
    super('invalid official Antigravity usage output');
    this.name = 'AntigravityOutputError';
  }
}

export function parseAntigravityUsageEnvelope(value: unknown): AntigravityUsageEnvelope {
  try {
    const envelope = AntigravityUsageEnvelopeSchema.parse(value);
    if (envelope.status === 'SUCCESS') {
      if (envelope.command?.name !== 'usage') throw new AntigravityOutputError();
      if (envelope.command.data.groups.length === 0) throw new AntigravityOutputError();
    }
    return envelope;
  } catch (error) {
    if (error instanceof AntigravityOutputError) throw error;
    throw new AntigravityOutputError();
  }
}

export function containsAuthenticationMarker(value: string | undefined): boolean {
  if (!value) return false;
  return /authentication required|auth required|unauthenticated|not authenticated|login required|sign[ -]?in required|please log in/i.test(
    value,
  );
}
