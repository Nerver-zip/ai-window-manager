import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveWindowTarget } from '../domain/window-target.js';
import type { ProviderAdapter } from '../providers/provider.js';
import type { Clock } from '../scheduler/clock.js';
import type { StorageRepositories } from '../storage/repositories.js';
import type { ActionIntentRecord, EventRecord } from '../storage/repositories.js';
import { isProviderVisible } from '../providers/visibility.js';

const MAX_MANUAL_IDEMPOTENCY_KEY = 128;

const TriggerCommandSchema = z
  .object({
    windowKind: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .optional(),
    idempotencyKey: z.string().min(1).max(MAX_MANUAL_IDEMPOTENCY_KEY).optional(),
  })
  .strict();

export interface CommandApiInput {
  repositories: StorageRepositories;
  adapters: ReadonlyMap<string, ProviderAdapter>;
  clock: Clock;
  requestReconcile?: (() => void) | undefined;
  idFactory?: () => string;
  fakeProviderEnabled?: boolean;
}

export interface CommandAcceptedBody {
  intentId?: string;
  state?: ActionIntentRecord['state'];
  dedupeKey?: string;
  created?: boolean;
}

export interface CommandResult {
  statusCode: 202 | 400 | 404 | 409 | 422;
  body: {
    accepted: boolean;
    command?: string;
    intent?: CommandAcceptedBody;
    error?: { code: string; message: string };
  };
}

export interface CommandApiHandlers {
  inspect(providerId: unknown): CommandResult;
  trigger(providerId: unknown, body: unknown): CommandResult;
}

export function createCommandApi(input: CommandApiInput): CommandApiHandlers {
  return {
    inspect: (providerId) => inspectProvider(input, providerId),
    trigger: (providerId, body) => triggerProvider(input, providerId, body),
  };
}

function inspectProvider(input: CommandApiInput, rawProviderId: unknown): CommandResult {
  const providerId = providerIdValue(rawProviderId);
  if (!providerId) return badRequest('provider id is invalid');
  if (!isProviderVisible(providerId, input.fakeProviderEnabled ?? true))
    return notFound('provider not found');
  const provider = input.repositories.providers.get(providerId);
  if (!provider) return notFound('provider not found');
  if (!provider.enabled) return conflict('provider is disabled');

  appendEvent(input, {
    occurredAtMs: input.clock.now().getTime(),
    providerId,
    type: 'inspect_requested',
    severity: 'info',
    reasonCode: 'INSPECT_REQUESTED',
    data: { providerId },
  });
  input.requestReconcile?.();
  return { statusCode: 202, body: { accepted: true, command: 'inspect' } };
}

function triggerProvider(
  input: CommandApiInput,
  rawProviderId: unknown,
  body: unknown,
): CommandResult {
  const providerId = providerIdValue(rawProviderId);
  if (!providerId) return badRequest('provider id is invalid');
  if (!isProviderVisible(providerId, input.fakeProviderEnabled ?? true))
    return notFound('provider not found');
  const provider = input.repositories.providers.get(providerId);
  const adapter = input.adapters.get(providerId);
  if (!provider || !adapter) return notFound('provider not found');
  if (!provider.enabled) return conflict('provider is disabled');
  if (provider.mode !== 'automation') return conflict('provider automation is disabled');

  const parsed = TriggerCommandSchema.safeParse(body ?? {});
  if (!parsed.success) return badRequest('trigger request is invalid');
  const command = parsed.data;

  let capabilities: ReturnType<ProviderAdapter['capabilities']>;
  try {
    capabilities = adapter.capabilities();
  } catch {
    return unsupported(input, providerId, 'ACTION_CAPABILITY_UNAVAILABLE');
  }
  if (!capabilities.windowTrigger.supported || typeof adapter.triggerWindow !== 'function') {
    return unsupported(input, providerId, 'ACTION_CAPABILITY_UNAVAILABLE');
  }

  if (provider.kind === 'antigravity' && !command.windowKind) {
    return badRequest('choose an Antigravity quota window before requesting a start');
  }
  const windowKind = command.windowKind ?? exactSavedPolicyWindowKind(input, providerId);
  if (!windowKind) return badRequest('choose a reported usage window before requesting a start');
  const observation = input.repositories.providerState.get(providerId)?.observation;
  const target = resolveWindowTarget(windowKind, observation?.windows ?? []);
  if (target.status !== 'exact' && target.status !== 'legacy_resolved') {
    return badRequest('choose one exact usage window from the latest provider observation');
  }
  const exactWindowKind = target.windowKind;
  if (
    capabilities.windowTrigger.supportedWindowKinds &&
    !capabilities.windowTrigger.supportedWindowKinds.includes(exactWindowKind)
  ) {
    return unsupported(input, providerId, 'ACTION_TARGET_UNSUPPORTED');
  }

  const nowMs = input.clock.now().getTime();
  const manualKey = command.idempotencyKey ?? String(Math.floor(nowMs / (5 * 60 * 1000)));
  const dedupeKey = `${providerId}:trigger_window:manual:${exactWindowKind}:${manualKey}`;
  const intent: ActionIntentRecord = {
    id: (input.idFactory ?? randomUUID)(),
    providerId,
    policyId: null,
    actionType: 'trigger_window',
    dedupeKey,
    state: 'planned',
    scheduledForMs: nowMs,
    notBeforeMs: null,
    expiresAtMs: nowMs + 5 * 60 * 1000,
    attemptCount: 0,
    confirmationAttemptCount: 0,
    confirmationNotBeforeMs: null,
    reasonCode: 'MANUAL_TRIGGER_REQUESTED',
    explanation: {
      decision: 'manual_trigger',
      reasonCode: 'MANUAL_TRIGGER_REQUESTED',
      providerId,
      windowKind: exactWindowKind,
    },
    lastErrorCode: null,
    createdAtMs: nowMs,
    startedAtMs: null,
    finishedAtMs: null,
    updatedAtMs: nowMs,
  };
  const result = input.repositories.actionIntents.createIfAbsent(intent);
  input.requestReconcile?.();
  appendEvent(input, {
    occurredAtMs: nowMs,
    providerId,
    type: 'manual_trigger_requested',
    severity: 'info',
    reasonCode: 'MANUAL_TRIGGER_REQUESTED',
    data: {
      intentId: result.intent.id,
      dedupeKey: result.intent.dedupeKey,
      created: result.created,
      windowKind: exactWindowKind,
    },
  });
  return {
    statusCode: 202,
    body: {
      accepted: true,
      command: 'trigger',
      intent: {
        intentId: result.intent.id,
        state: result.intent.state,
        dedupeKey: result.intent.dedupeKey,
        created: result.created,
      },
    },
  };
}

function exactSavedPolicyWindowKind(
  input: CommandApiInput,
  providerId: string,
): string | undefined {
  const policy = input.repositories.schedulePolicies.get(`activation-${providerId}`);
  if (!policy) return undefined;
  const config = asRecord(policy.config);
  const windowKind = config.windowKind;
  if (typeof windowKind !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(windowKind)) {
    return undefined;
  }
  const observation = input.repositories.providerState.get(providerId)?.observation;
  const target = resolveWindowTarget(windowKind, observation?.windows ?? []);
  return target.status === 'exact' || target.status === 'legacy_resolved'
    ? target.windowKind
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function unsupported(
  input: CommandApiInput,
  providerId: string,
  reasonCode: string,
): CommandResult {
  appendEvent(input, {
    occurredAtMs: input.clock.now().getTime(),
    providerId,
    type: 'manual_trigger_rejected',
    severity: 'warn',
    reasonCode,
    data: { providerId },
  });
  return {
    statusCode: 422,
    body: {
      accepted: false,
      error: { code: reasonCode, message: 'provider trigger is unavailable' },
    },
  };
}

function appendEvent(input: CommandApiInput, event: EventRecord): void {
  input.repositories.events.append(event);
}

function providerIdValue(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ? value : undefined;
}

function badRequest(message: string): CommandResult {
  return { statusCode: 400, body: { accepted: false, error: { code: 'BAD_REQUEST', message } } };
}

function notFound(message: string): CommandResult {
  return { statusCode: 404, body: { accepted: false, error: { code: 'NOT_FOUND', message } } };
}

function conflict(message: string): CommandResult {
  return { statusCode: 409, body: { accepted: false, error: { code: 'CONFLICT', message } } };
}
