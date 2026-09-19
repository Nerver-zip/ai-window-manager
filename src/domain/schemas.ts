import { z } from 'zod';
import type { ProviderObservation } from './types.js';

const MAX_IDENTIFIER_LENGTH = 64;
const MAX_NOTES_LENGTH = 512;
const MAX_WINDOWS_PER_OBSERVATION = 32;
const MAX_WINDOW_DURATION_SECONDS = 31_622_400;

export const EvidenceSourceSchema = z.enum([
  'official_supported',
  'official_client_internal',
  'observed',
  'inferred',
  'estimated',
  'manual',
  'unknown',
]);

export const CapabilityContractSchema = z.enum([
  'official_supported',
  'official_client_internal',
  'observed_undocumented',
  'unknown',
]);

export const ConfidenceSchema = z.enum(['exact', 'high', 'medium', 'low', 'unknown']);

export const ProviderHealthSchema = z.enum([
  'UP',
  'DEGRADED',
  'AUTH_REQUIRED',
  'UNAVAILABLE',
  'ERROR',
]);

export const WindowPhaseSchema = z.enum([
  'UNKNOWN',
  'INACTIVE',
  'ACTIVE',
  'EXHAUSTED',
  'RESET_DUE',
]);

export const ProviderIdSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'providerId must be a lowercase machine identifier');

export const WindowKindSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'windowKind must be a lowercase machine key');

export const UtcInstantSchema = z.iso
  .datetime({ offset: false })
  .refine((value) => value.endsWith('Z'), 'normalized instants must use UTC Z notation');

export const RatioSchema = z.number().finite().min(0).max(1);

export const DurationSecondsSchema = z
  .number()
  .finite()
  .int()
  .positive()
  .max(MAX_WINDOW_DURATION_SECONDS);

export const StaleAfterSecondsSchema = z
  .number()
  .finite()
  .int()
  .positive()
  .max(MAX_WINDOW_DURATION_SECONDS);

const BoundedNotesSchema = z.string().max(MAX_NOTES_LENGTH);

export function FactSchema<T extends z.ZodType>(valueSchema: T) {
  return z
    .object({
      value: valueSchema,
      source: EvidenceSourceSchema,
      confidence: ConfidenceSchema,
      observedAt: UtcInstantSchema,
    })
    .strict();
}

export const WindowSnapshotSchema = z
  .object({
    providerId: ProviderIdSchema,
    windowKind: WindowKindSchema,
    observedAt: UtcInstantSchema,
    phase: FactSchema(WindowPhaseSchema),
    startedAt: FactSchema(UtcInstantSchema).optional(),
    durationSeconds: FactSchema(DurationSecondsSchema).optional(),
    resetAt: FactSchema(UtcInstantSchema).optional(),
    usageRatio: FactSchema(RatioSchema).optional(),
    remainingRatio: FactSchema(RatioSchema).optional(),
  })
  .strict();

export const ProviderObservationSchema = z
  .object({
    providerId: ProviderIdSchema,
    health: ProviderHealthSchema,
    observedAt: UtcInstantSchema,
    windows: z.array(WindowSnapshotSchema).max(MAX_WINDOWS_PER_OBSERVATION),
    staleAfterSeconds: StaleAfterSecondsSchema,
    summary: BoundedNotesSchema.optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    const windowKinds = new Set<string>();

    observation.windows.forEach((window, index) => {
      if (window.providerId !== observation.providerId) {
        context.addIssue({
          code: 'custom',
          path: ['windows', index, 'providerId'],
          message: 'window providerId must match observation providerId',
        });
      }

      if (windowKinds.has(window.windowKind)) {
        context.addIssue({
          code: 'custom',
          path: ['windows', index, 'windowKind'],
          message: 'windowKind must be unique within an observation',
        });
      }
      windowKinds.add(window.windowKind);
    });
  });

export const ReadCapabilitySchema = z
  .object({
    supported: z.boolean(),
    contract: CapabilityContractSchema,
    notes: BoundedNotesSchema.optional(),
  })
  .strict();

export const TriggerCapabilitySchema = z
  .object({
    supported: z.boolean(),
    contract: CapabilityContractSchema,
    consumesQuota: z.union([z.boolean(), z.literal('unknown')]),
    notes: BoundedNotesSchema.optional(),
  })
  .strict();

export const ProviderCapabilitiesSchema = z
  .object({
    usageRead: ReadCapabilitySchema,
    resetRead: ReadCapabilitySchema,
    windowTrigger: TriggerCapabilitySchema,
  })
  .strict();

export const TriggerWindowRequestSchema = z
  .object({
    intentId: z.string().min(1).max(128),
    dedupeKey: z.string().min(1).max(256),
    reasonCode: z.string().min(1).max(128),
  })
  .strict();

export const ProviderActionResultSchema = z
  .object({
    status: z.enum(['succeeded', 'failed', 'uncertain', 'rejected']),
    occurredAt: UtcInstantSchema,
    confirmationHint: BoundedNotesSchema.optional(),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict();

export function parseProviderObservation(value: unknown): ProviderObservation {
  return ProviderObservationSchema.parse(value) as ProviderObservation;
}

export function safeParseProviderObservation(value: unknown) {
  return ProviderObservationSchema.safeParse(value);
}
