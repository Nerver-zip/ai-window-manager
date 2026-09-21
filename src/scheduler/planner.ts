import type {
  ActivationPolicy,
  CurrentWindowState,
  ProviderCapabilities,
  WindowSnapshot,
} from '../domain/types.js';
import { localDateAt, resolveLocalOccurrenceOnDate, shiftLocalDate } from './time.js';
import { MIN_ACTIVE_HOURS_COVERAGE_SECONDS, localTimeMinutes } from './policy.js';

export const PlannerReasonCode = {
  PolicyDisabled: 'POLICY_DISABLED',
  ManualPolicy: 'MANUAL_POLICY',
  AutomationDisabled: 'AUTOMATION_DISABLED',
  TriggerCapabilityUnavailable: 'TRIGGER_CAPABILITY_UNAVAILABLE',
  MonitoringUnavailable: 'MONITORING_UNAVAILABLE',
  ObservationStale: 'OBSERVATION_STALE',
  ObservationMissing: 'OBSERVATION_MISSING',
  WindowPhaseConfidenceTooLow: 'WINDOW_PHASE_CONFIDENCE_TOO_LOW',
  WindowNotReported: 'WINDOW_NOT_REPORTED',
  CurrentWindowActive: 'CURRENT_WINDOW_ACTIVE',
  WindowDurationUnknown: 'WINDOW_DURATION_UNKNOWN',
  WindowDurationConfidenceTooLow: 'WINDOW_DURATION_CONFIDENCE_TOO_LOW',
  ScheduledAnchor: 'SCHEDULED_ANCHOR',
  AnchorNotDue: 'ANCHOR_NOT_DUE',
  AnchorSkippedActive: 'ANCHOR_SKIPPED_ACTIVE_WINDOW',
  AnchorExpired: 'ANCHOR_EXPIRED',
  NextAnchor: 'NEXT_ANCHOR',
  ActionAlreadyPending: 'ACTION_ALREADY_PENDING',
  ActiveHoursCoverage: 'ACTIVE_HOURS_COVERAGE',
  ActiveHoursTooShort: 'ACTIVE_HOURS_TOO_SHORT',
  AutoWindowAvailable: 'AUTO_WINDOW_AVAILABLE',
} as const;

export type PlannerReasonCode = (typeof PlannerReasonCode)[keyof typeof PlannerReasonCode];

export type PlannerDecisionKind = 'START' | 'WAIT' | 'SKIP' | 'NONE';

export interface PlannerIntentLike {
  dedupeKey: string;
  actionType: string;
  state: string;
}

export interface PlannerInput {
  now: Date;
  providerId: string;
  policy: ActivationPolicy;
  currentWindow: CurrentWindowState;
  window?: WindowSnapshot;
  observation?: { observedAt: string; staleAfterSeconds: number };
  capabilities: Pick<ProviderCapabilities, 'windowTrigger'>;
  automationEnabled: boolean;
  pendingIntents?: readonly PlannerIntentLike[];
}

export interface PlannerExplanation {
  decision: PlannerDecisionKind;
  reasonCode: PlannerReasonCode;
  providerId: string;
  policyId: string;
  policyKind: ActivationPolicy['kind'];
  timezone: string;
  currentWindow: CurrentWindowState['status'];
  currentWindowConfidence?: CurrentWindowState['confidence'];
  windowKind?: string;
  phase?: WindowSnapshot['phase']['value'];
  phaseConfidence?: WindowSnapshot['phase']['confidence'];
  windowDurationSeconds?: number;
  durationConfidence?: NonNullable<WindowSnapshot['durationSeconds']>['confidence'];
  observationAgeSeconds?: number;
  anchorAt?: string;
  nextAnchorAt?: string;
  validFrom?: string;
  validUntil?: string;
  toleranceSeconds?: number;
  coverageSeconds?: number;
}

export interface PlannerDecision {
  kind: PlannerDecisionKind;
  reasonCode: PlannerReasonCode;
  explanation: PlannerExplanation;
  anchorAt?: string;
  nextAnchorAt?: string;
  validFrom?: string;
  validUntil?: string;
  notBefore?: string;
  dedupeKey?: string;
}

export interface UpcomingScheduleItem {
  at: string;
  kind: 'start' | 'wait';
  label: string;
  reasonCode: PlannerReasonCode;
}

const ACTIONABLE_CONFIDENCE = new Set(['exact', 'high']);
const OPEN_INTENT_STATES = new Set(['planned', 'executing', 'failed_retryable']);

export function planWindowAction(input: PlannerInput): PlannerDecision {
  const base = {
    providerId: input.providerId,
    policyId: input.policy.id,
    policyKind: input.policy.kind,
    timezone: input.policy.timezone,
    currentWindow: input.currentWindow.status,
    currentWindowConfidence: input.currentWindow.confidence,
    ...(input.window
      ? {
          windowKind: input.window.windowKind,
          phase: input.window.phase.value,
          phaseConfidence: input.window.phase.confidence,
          ...(input.window.durationSeconds
            ? {
                windowDurationSeconds: input.window.durationSeconds.value,
                durationConfidence: input.window.durationSeconds.confidence,
              }
            : {}),
        }
      : {}),
    ...(input.observation ? observationAgeSeconds(input.now, input.observation.observedAt) : {}),
  } satisfies Omit<PlannerExplanation, 'decision' | 'reasonCode'>;

  if (!input.policy.enabled) return none(base, PlannerReasonCode.PolicyDisabled);
  if (input.policy.kind === 'manual') return none(base, PlannerReasonCode.ManualPolicy);
  if (!input.automationEnabled) return none(base, PlannerReasonCode.AutomationDisabled);
  if (!input.capabilities.windowTrigger.supported) {
    return none(base, PlannerReasonCode.TriggerCapabilityUnavailable);
  }
  if (!input.observation) return wait(base, PlannerReasonCode.ObservationMissing);
  const ageSeconds = Math.max(
    0,
    Math.floor((input.now.getTime() - Date.parse(input.observation.observedAt)) / 1000),
  );
  if (ageSeconds > input.observation.staleAfterSeconds) {
    return wait(base, PlannerReasonCode.ObservationStale);
  }
  if (input.currentWindow.status === 'UNAVAILABLE') {
    return wait(base, PlannerReasonCode.MonitoringUnavailable);
  }
  if (input.currentWindow.status === 'UNKNOWN') {
    return wait(
      base,
      input.currentWindow.reason === 'WINDOW_STATE_UNCERTAIN'
        ? PlannerReasonCode.WindowPhaseConfidenceTooLow
        : input.currentWindow.reason === 'WINDOW_NOT_REPORTED'
          ? PlannerReasonCode.WindowNotReported
          : PlannerReasonCode.MonitoringUnavailable,
    );
  }

  if (input.policy.kind === 'auto') return planAuto(input, base);
  if (input.policy.kind === 'fixed') return planFixed(input, base, input.policy);
  if (input.policy.kind === 'custom_schedule') return planCustom(input, base, input.policy);
  return planActiveHours(input, base, input.policy);
}

export function upcomingSchedule(
  policy: ActivationPolicy,
  now: Date,
  durationSeconds: number | undefined,
  count = 6,
): UpcomingScheduleItem[] {
  if (!policy.enabled || policy.kind === 'manual' || policy.kind === 'auto') return [];
  if (policy.kind === 'fixed') {
    if (!durationSeconds || durationSeconds <= 0) return [];
    const anchors = fixedAnchors(policy, now, durationSeconds, count);
    return anchors.map((at) => ({
      at: at.toISOString(),
      kind: 'start' as const,
      label: 'Start window',
      reasonCode: PlannerReasonCode.ScheduledAnchor,
    }));
  }
  if (policy.kind === 'custom_schedule') {
    return customAnchors(policy, now, count).map((at) => ({
      at: at.toISOString(),
      kind: 'start' as const,
      label: 'Start window',
      reasonCode: PlannerReasonCode.ScheduledAnchor,
    }));
  }
  return activeHourStarts(policy, now, count).map((at) => ({
    at: at.toISOString(),
    kind: 'start' as const,
    label: 'Available hours begin',
    reasonCode: PlannerReasonCode.ActiveHoursCoverage,
  }));
}

function planAuto(
  input: PlannerInput,
  base: Omit<PlannerExplanation, 'decision' | 'reasonCode'>,
): PlannerDecision {
  if (input.currentWindow.status === 'ACTIVE')
    return wait(base, PlannerReasonCode.CurrentWindowActive);
  if (input.currentWindow.status !== 'INACTIVE')
    return wait(base, PlannerReasonCode.MonitoringUnavailable);
  const duration = actionableDuration(input.window);
  const cycleMs = (duration ?? 18_000) * 1000;
  const cycleAt = Math.floor(input.now.getTime() / cycleMs) * cycleMs;
  return start(
    input,
    base,
    new Date(cycleAt),
    new Date(input.now.getTime() + 5 * 60_000),
    PlannerReasonCode.AutoWindowAvailable,
  );
}

function planFixed(
  input: PlannerInput,
  base: Omit<PlannerExplanation, 'decision' | 'reasonCode'>,
  policy: Extract<ActivationPolicy, { kind: 'fixed' }>,
): PlannerDecision {
  const duration = actionableDuration(input.window);
  if (duration === undefined) return wait(base, PlannerReasonCode.WindowDurationUnknown);
  if (!durationConfidenceOk(input.window)) {
    return wait(base, PlannerReasonCode.WindowDurationConfidenceTooLow);
  }
  const [anchor, next] = fixedCandidate(policy, input.now, duration);
  return planAnchor(input, base, anchor, next, policy.toleranceSeconds);
}

function planCustom(
  input: PlannerInput,
  base: Omit<PlannerExplanation, 'decision' | 'reasonCode'>,
  policy: Extract<ActivationPolicy, { kind: 'custom_schedule' }>,
): PlannerDecision {
  const [anchor, next] = customCandidate(policy, input.now);
  if (!anchor) return wait(base, PlannerReasonCode.AnchorNotDue);
  return planAnchor(
    input,
    base,
    anchor,
    next ?? new Date(anchor.getTime() + 86_400_000),
    policy.toleranceSeconds,
  );
}

function planActiveHours(
  input: PlannerInput,
  base: Omit<PlannerExplanation, 'decision' | 'reasonCode'>,
  policy: Extract<ActivationPolicy, { kind: 'active_hours' }>,
): PlannerDecision {
  const duration = actionableDuration(input.window);
  if (duration === undefined) return wait(base, PlannerReasonCode.WindowDurationUnknown);
  if (!durationConfidenceOk(input.window)) {
    return wait(base, PlannerReasonCode.WindowDurationConfidenceTooLow);
  }
  const span = activeHourSpanAtOrAfter(policy, input.now);
  if (!span) return wait(base, PlannerReasonCode.AnchorNotDue);
  const remainingSeconds = Math.max(
    0,
    Math.floor((span.end.getTime() - input.now.getTime()) / 1000),
  );
  if (input.currentWindow.status === 'ACTIVE') {
    return wait(
      { ...base, anchorAt: span.start.toISOString(), nextAnchorAt: span.start.toISOString() },
      PlannerReasonCode.CurrentWindowActive,
    );
  }
  if (span.start.getTime() > input.now.getTime()) {
    return wait(
      { ...base, anchorAt: span.start.toISOString(), nextAnchorAt: span.start.toISOString() },
      PlannerReasonCode.AnchorNotDue,
    );
  }
  if (remainingSeconds < MIN_ACTIVE_HOURS_COVERAGE_SECONDS) {
    return skip(
      {
        ...base,
        anchorAt: span.start.toISOString(),
        nextAnchorAt: nextActiveHourStart(policy, span.start).toISOString(),
        coverageSeconds: remainingSeconds,
      },
      PlannerReasonCode.ActiveHoursTooShort,
    );
  }
  return start(
    input,
    {
      ...base,
      anchorAt: span.start.toISOString(),
      nextAnchorAt: nextActiveHourStart(policy, span.start).toISOString(),
      coverageSeconds: remainingSeconds,
    },
    span.start,
    span.end,
    PlannerReasonCode.ActiveHoursCoverage,
  );
}

function planAnchor(
  input: PlannerInput,
  base: Omit<PlannerExplanation, 'decision' | 'reasonCode'>,
  anchor: Date,
  next: Date,
  toleranceSeconds: number,
): PlannerDecision {
  const anchorEnd = new Date(anchor.getTime() + toleranceSeconds * 1000);
  const atOrAfterAnchor = input.now.getTime() >= anchor.getTime();
  // `validUntil` is an exclusive boundary. The executor applies the same
  // rule when it expires an intent, so a decision at the exact deadline
  // cannot race with dispatch and be treated differently by each layer.
  const insideWindow =
    atOrAfterAnchor &&
    (toleranceSeconds === 0
      ? input.now.getTime() === anchor.getTime()
      : input.now.getTime() < anchorEnd.getTime());
  const explanation = {
    ...base,
    anchorAt: anchor.toISOString(),
    nextAnchorAt: next.toISOString(),
    validFrom: anchor.toISOString(),
    validUntil: anchorEnd.toISOString(),
    toleranceSeconds,
  };

  if (!atOrAfterAnchor) return wait(explanation, PlannerReasonCode.AnchorNotDue);
  if (!insideWindow) return skip(explanation, PlannerReasonCode.AnchorExpired);
  if (input.currentWindow.status === 'ACTIVE') {
    return skip(explanation, PlannerReasonCode.AnchorSkippedActive);
  }
  return start(input, explanation, anchor, anchorEnd, PlannerReasonCode.ScheduledAnchor);
}

function start(
  input: PlannerInput,
  base: Omit<PlannerExplanation, 'decision' | 'reasonCode'>,
  anchor: Date,
  expiresAt: Date,
  reasonCode: PlannerReasonCode,
): PlannerDecision {
  const dedupeKey = [input.providerId, 'start_window', input.policy.id, anchor.toISOString()].join(
    ':',
  );
  if (hasPendingEquivalent(input.pendingIntents, dedupeKey)) {
    return wait(
      {
        ...base,
        anchorAt: anchor.toISOString(),
        validFrom: anchor.toISOString(),
        validUntil: expiresAt.toISOString(),
      },
      PlannerReasonCode.ActionAlreadyPending,
    );
  }
  const explanation = {
    ...base,
    decision: 'START' as const,
    reasonCode,
    anchorAt: anchor.toISOString(),
    validFrom: anchor.toISOString(),
    validUntil: expiresAt.toISOString(),
  };
  const result: PlannerDecision = {
    kind: 'START',
    reasonCode,
    explanation,
    anchorAt: anchor.toISOString(),
    validFrom: anchor.toISOString(),
    validUntil: expiresAt.toISOString(),
    dedupeKey,
  };
  if (anchor.getTime() > input.now.getTime()) result.notBefore = anchor.toISOString();
  return result;
}

function fixedCandidate(
  policy: Extract<ActivationPolicy, { kind: 'fixed' }>,
  now: Date,
  durationSeconds: number,
): [Date, Date] {
  const date = localDateAt(now, policy.timezone);
  const base = resolveLocalOccurrenceOnDate({
    localTime: policy.anchorLocalTime,
    timeZone: policy.timezone,
    localDate: date,
  }).instant;
  const intervalMs = durationSeconds * 1000;
  const lastOffset = Math.floor((now.getTime() - base.getTime()) / intervalMs);
  const last =
    now.getTime() < base.getTime() ? base : new Date(base.getTime() + lastOffset * intervalMs);
  return [last, new Date(last.getTime() + intervalMs)];
}

function fixedAnchors(
  policy: Extract<ActivationPolicy, { kind: 'fixed' }>,
  now: Date,
  durationSeconds: number,
  count: number,
): Date[] {
  let [first] = fixedCandidate(policy, now, durationSeconds);
  const intervalMs = durationSeconds * 1000;
  if (first.getTime() < now.getTime()) {
    first = new Date(first.getTime() + intervalMs);
  }
  return Array.from(
    { length: count },
    (_, index) => new Date(first.getTime() + index * intervalMs),
  );
}

function customAnchors(
  policy: Extract<ActivationPolicy, { kind: 'custom_schedule' }>,
  now: Date,
  count: number,
): Date[] {
  const date = localDateAt(now, policy.timezone);
  const candidates: Date[] = [];
  for (let dayOffset = -1; dayOffset <= 3; dayOffset += 1) {
    const localDate = shiftLocalDate(date, dayOffset);
    for (const time of policy.times) {
      candidates.push(
        resolveLocalOccurrenceOnDate({ localTime: time, timeZone: policy.timezone, localDate })
          .instant,
      );
    }
  }
  return candidates
    .filter((candidate) => candidate.getTime() >= now.getTime() - 86_400_000)
    .sort((left, right) => left.getTime() - right.getTime())
    .filter(
      (candidate, index, all) => index === 0 || candidate.getTime() !== all[index - 1]?.getTime(),
    )
    .filter((candidate) => candidate.getTime() >= now.getTime() - 1)
    .slice(0, count);
}

function customCandidate(
  policy: Extract<ActivationPolicy, { kind: 'custom_schedule' }>,
  now: Date,
): [Date | undefined, Date | undefined] {
  const date = localDateAt(now, policy.timezone);
  const candidates: Date[] = [];
  for (let dayOffset = -1; dayOffset <= 3; dayOffset += 1) {
    const localDate = shiftLocalDate(date, dayOffset);
    for (const time of policy.times) {
      candidates.push(
        resolveLocalOccurrenceOnDate({ localTime: time, timeZone: policy.timezone, localDate })
          .instant,
      );
    }
  }
  const sorted = candidates
    .sort((left, right) => left.getTime() - right.getTime())
    .filter(
      (candidate, index, all) => index === 0 || candidate.getTime() !== all[index - 1]?.getTime(),
    );
  const last = sorted.filter((candidate) => candidate.getTime() <= now.getTime()).at(-1);
  const next = sorted.find((candidate) => candidate.getTime() > now.getTime());
  const lastIsToday = last ? localDateAt(last, policy.timezone) === date : false;
  const selected =
    last && (now.getTime() - last.getTime() <= policy.toleranceSeconds * 1000 || lastIsToday)
      ? last
      : next;
  const selectedIndex = selected
    ? sorted.findIndex((candidate) => candidate.getTime() === selected.getTime())
    : -1;
  return [selected, selectedIndex >= 0 ? sorted[selectedIndex + 1] : undefined];
}

function activeHourSpanAtOrAfter(
  policy: Extract<ActivationPolicy, { kind: 'active_hours' }>,
  now: Date,
): { start: Date; end: Date } | undefined {
  const date = localDateAt(now, policy.timezone);
  const spans: Array<{ start: Date; end: Date }> = [];
  for (let dayOffset = -1; dayOffset <= 3; dayOffset += 1) {
    const startDate = shiftLocalDate(date, dayOffset);
    for (const period of policy.periods) {
      const start = resolveLocalOccurrenceOnDate({
        localTime: period.start,
        timeZone: policy.timezone,
        localDate: startDate,
      }).instant;
      const endDate =
        localTimeMinutes(period.end) <= localTimeMinutes(period.start)
          ? shiftLocalDate(startDate, 1)
          : startDate;
      const end = resolveLocalOccurrenceOnDate({
        localTime: period.end,
        timeZone: policy.timezone,
        localDate: endDate,
      }).instant;
      if (end.getTime() > now.getTime() - 1) spans.push({ start, end });
    }
  }
  return spans.sort((left, right) => left.start.getTime() - right.start.getTime())[0];
}

function activeHourStarts(
  policy: Extract<ActivationPolicy, { kind: 'active_hours' }>,
  now: Date,
  count: number,
): Date[] {
  const date = localDateAt(now, policy.timezone);
  const starts: Date[] = [];
  for (let dayOffset = 0; dayOffset <= 5; dayOffset += 1) {
    const localDate = shiftLocalDate(date, dayOffset);
    for (const period of policy.periods) {
      starts.push(
        resolveLocalOccurrenceOnDate({
          localTime: period.start,
          timeZone: policy.timezone,
          localDate,
        }).instant,
      );
    }
  }
  return starts
    .filter((value) => value.getTime() >= now.getTime() - 1)
    .sort((left, right) => left.getTime() - right.getTime())
    .slice(0, count);
}

function nextActiveHourStart(
  policy: Extract<ActivationPolicy, { kind: 'active_hours' }>,
  after: Date,
): Date {
  return (
    activeHourStarts(policy, new Date(after.getTime() + 60_000), 1)[0] ??
    new Date(after.getTime() + 86_400_000)
  );
}

function actionableDuration(window: WindowSnapshot | undefined): number | undefined {
  return window?.durationSeconds?.value;
}

function durationConfidenceOk(window: WindowSnapshot | undefined): boolean {
  return Boolean(
    window?.durationSeconds && ACTIONABLE_CONFIDENCE.has(window.durationSeconds.confidence),
  );
}

function observationAgeSeconds(
  now: Date,
  observedAt: string,
): { observationAgeSeconds: number } | object {
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) return {};
  return {
    observationAgeSeconds: Math.max(0, Math.floor((now.getTime() - observedAtMs) / 1000)),
  };
}

function hasPendingEquivalent(
  intents: readonly PlannerIntentLike[] | undefined,
  dedupeKey: string,
): boolean {
  return Boolean(
    intents?.some(
      (intent) => intent.dedupeKey === dedupeKey && OPEN_INTENT_STATES.has(intent.state),
    ),
  );
}

function none(
  base: Omit<PlannerExplanation, 'decision' | 'reasonCode'>,
  reasonCode: PlannerReasonCode,
): PlannerDecision {
  return { kind: 'NONE', reasonCode, explanation: { ...base, decision: 'NONE', reasonCode } };
}

function wait(
  base: Omit<PlannerExplanation, 'decision' | 'reasonCode'>,
  reasonCode: PlannerReasonCode,
): PlannerDecision {
  return { kind: 'WAIT', reasonCode, explanation: { ...base, decision: 'WAIT', reasonCode } };
}

function skip(
  base: Omit<PlannerExplanation, 'decision' | 'reasonCode'>,
  reasonCode: PlannerReasonCode,
): PlannerDecision {
  return { kind: 'SKIP', reasonCode, explanation: { ...base, decision: 'SKIP', reasonCode } };
}
