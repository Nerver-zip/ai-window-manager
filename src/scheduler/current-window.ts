import type {
  Confidence,
  CurrentWindowState,
  ProviderHealth,
  ProviderObservation,
  WindowSnapshot,
} from '../domain/types.js';

const ACTIONABLE_CONFIDENCE = new Set<Confidence>(['exact', 'high']);

export function deriveCurrentWindow(
  providerId: string,
  observation: ProviderObservation | null | undefined,
  health?: ProviderHealth,
  preferredWindowKind?: string,
): CurrentWindowState {
  if (
    !observation ||
    health === 'AUTH_REQUIRED' ||
    health === 'UNAVAILABLE' ||
    health === 'ERROR'
  ) {
    return {
      providerId,
      status: 'UNAVAILABLE',
      confidence: 'unknown',
      ...(observation?.observedAt ? { observedAt: observation.observedAt } : {}),
      reason: health === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'MONITORING_UNAVAILABLE',
    };
  }

  const windows = preferredWindowKind
    ? observation.windows.filter((window) => window.windowKind === preferredWindowKind)
    : observation.windows;
  if (preferredWindowKind && windows.length === 0) {
    return {
      providerId,
      status: 'UNKNOWN',
      windowKind: preferredWindowKind,
      observedAt: observation.observedAt,
      confidence: 'unknown',
      reason: 'WINDOW_NOT_REPORTED',
    };
  }

  const active = windows.find(
    (window) => window.phase.value === 'ACTIVE' && actionable(window.phase.confidence),
  );
  if (active) return activeState(providerId, active, observation.observedAt);

  const inactive = windows.find(
    (window) => window.phase.value === 'INACTIVE' && actionable(window.phase.confidence),
  );
  if (inactive) {
    return {
      providerId,
      status: 'INACTIVE',
      windowKind: inactive.windowKind,
      observedAt: observation.observedAt,
      confidence: inactive.phase.confidence,
    };
  }

  const first = windows[0];
  return {
    providerId,
    status: 'UNKNOWN',
    ...(first ? { windowKind: first.windowKind } : {}),
    observedAt: observation.observedAt,
    confidence: first?.phase.confidence ?? 'unknown',
    reason: first ? 'WINDOW_STATE_UNCERTAIN' : 'NO_WINDOW_REPORTED',
  };
}

export function deriveCurrentWindowForTarget(
  providerId: string,
  observation: ProviderObservation | null | undefined,
  health: ProviderHealth | undefined,
  windowKind: string | undefined,
): CurrentWindowState {
  if (
    !observation ||
    health === 'AUTH_REQUIRED' ||
    health === 'UNAVAILABLE' ||
    health === 'ERROR'
  ) {
    return deriveCurrentWindow(providerId, observation, health);
  }
  if (!windowKind) {
    return {
      providerId,
      status: 'UNKNOWN',
      observedAt: observation.observedAt,
      confidence: 'unknown',
      reason: 'WINDOW_TARGET_NOT_SELECTED',
    };
  }
  return deriveCurrentWindow(providerId, observation, health, windowKind);
}

function activeState(
  providerId: string,
  window: WindowSnapshot,
  observedAt: string,
): CurrentWindowState {
  const expectedEndAt = window.resetAt ?? inferredEnd(window);
  return {
    providerId,
    status: 'ACTIVE',
    windowKind: window.windowKind,
    observedAt,
    confidence: window.phase.confidence,
    ...(window.startedAt ? { startedAt: window.startedAt } : {}),
    ...(expectedEndAt ? { expectedEndAt } : {}),
  };
}

function inferredEnd(window: WindowSnapshot) {
  if (!window.startedAt || !window.durationSeconds) return undefined;
  const startedAtMs = Date.parse(window.startedAt.value);
  if (!Number.isFinite(startedAtMs)) return undefined;
  return {
    value: new Date(startedAtMs + window.durationSeconds.value * 1000).toISOString(),
    source: 'inferred' as const,
    confidence: window.durationSeconds.confidence,
    observedAt: window.observedAt,
  };
}

function actionable(confidence: Confidence): boolean {
  return ACTIONABLE_CONFIDENCE.has(confidence);
}
