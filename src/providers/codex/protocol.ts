import { z } from 'zod';

const RateLimitWindowSchema = z
  .object({
    usedPercent: z.number().finite().int().min(0).max(100),
    windowDurationMins: z.number().finite().int().positive().nullable().optional(),
    resetsAt: z.number().finite().int().nonnegative().nullable().optional(),
  })
  .passthrough();

const RateLimitSnapshotSchema = z
  .object({
    limitId: z.string().nullable().optional(),
    limitName: z.string().nullable().optional(),
    primary: RateLimitWindowSchema.nullable().optional(),
    secondary: RateLimitWindowSchema.nullable().optional(),
  })
  .passthrough();

export const CodexRateLimitsResponseSchema = z
  .object({
    rateLimits: RateLimitSnapshotSchema,
    rateLimitsByLimitId: z.record(z.string(), RateLimitSnapshotSchema).nullable().optional(),
  })
  .passthrough();

export type CodexRateLimitsResponse = z.infer<typeof CodexRateLimitsResponseSchema>;
export type CodexRateLimitSnapshot = z.infer<typeof RateLimitSnapshotSchema>;
export type CodexRateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

export function parseCodexRateLimitsResponse(value: unknown): CodexRateLimitsResponse {
  return CodexRateLimitsResponseSchema.parse(value);
}
