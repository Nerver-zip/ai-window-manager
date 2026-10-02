import type { Clock } from './clock.js';

export const LOOP_NAMES = ['reconcile', 'executor', 'cleanup', 'aggregation', 'retention'] as const;
export type LoopName = (typeof LOOP_NAMES)[number];
export interface LoopLimits {
  intervalMs: number;
  maxRunMs: number;
}
export interface LoopProgress {
  name: LoopName;
  startedAtMs: number | null;
  completedAtMs: number | null;
  lastSuccessAtMs: number | null;
  running: boolean;
  durationMs: number;
  consecutiveFailures: number;
  status: 'starting' | 'ok' | 'overdue' | 'stalled' | 'failing';
}
interface State {
  limits: LoopLimits;
  registeredMono: number;
  startedMono: number | null;
  completedMono: number | null;
  progress: Omit<LoopProgress, 'status'>;
}

/** In-memory daemon progress, deliberately independent of provider health. */
export class LoopMonitor {
  private readonly states = new Map<LoopName, State>();

  constructor(private readonly clock: Clock) {}

  register(name: LoopName, limits: LoopLimits): void {
    if (!LOOP_NAMES.includes(name) || this.states.has(name))
      throw new Error('invalid or duplicate loop registration');
    if (
      [limits.intervalMs, limits.maxRunMs].some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
    )
      throw new RangeError('loop limits must be positive safe integers');
    this.states.set(name, {
      limits: { ...limits },
      registeredMono: this.clock.monotonicMs(),
      startedMono: null,
      completedMono: null,
      progress: {
        name,
        startedAtMs: null,
        completedAtMs: null,
        lastSuccessAtMs: null,
        running: false,
        durationMs: 0,
        consecutiveFailures: 0,
      },
    });
  }

  begin(name: LoopName): void {
    const state = this.state(name);
    if (state.progress.running) throw new Error('loop is already running');
    state.startedMono = this.clock.monotonicMs();
    state.progress.startedAtMs = this.clock.now().getTime();
    state.progress.running = true;
  }

  finish(name: LoopName, succeeded: boolean): void {
    const state = this.state(name);
    if (!state.progress.running || state.startedMono === null)
      throw new Error('loop is not running');
    state.completedMono = this.clock.monotonicMs();
    state.progress.durationMs = Math.max(0, state.completedMono - state.startedMono);
    state.progress.completedAtMs = this.clock.now().getTime();
    state.progress.running = false;
    state.progress.consecutiveFailures = succeeded
      ? 0
      : Math.min(1_000_000, state.progress.consecutiveFailures + 1);
    if (succeeded) state.progress.lastSuccessAtMs = state.progress.completedAtMs;
  }

  async run<T>(name: LoopName, work: () => T | Promise<T>): Promise<T> {
    this.begin(name);
    try {
      const result = await work();
      this.finish(name, true);
      return result;
    } catch (error) {
      this.finish(name, false);
      throw error;
    }
  }

  snapshot(): { ready: boolean; loops: LoopProgress[] } {
    const nowMono = this.clock.monotonicMs();
    const loops = [...this.states.values()].map((state): LoopProgress => {
      const progress = { ...state.progress };
      let status: LoopProgress['status'] = progress.completedAtMs === null ? 'starting' : 'ok';
      if (progress.running && state.startedMono !== null) {
        progress.durationMs = Math.max(0, nowMono - state.startedMono);
        if (progress.durationMs > state.limits.maxRunMs) status = 'stalled';
      } else if (
        nowMono - (state.completedMono ?? state.registeredMono) >
        2 * state.limits.intervalMs + state.limits.maxRunMs
      )
        status = 'overdue';
      if (status !== 'stalled' && status !== 'overdue' && progress.consecutiveFailures >= 3)
        status = 'failing';
      return { ...progress, status };
    });
    return {
      ready:
        loops.length > 0 &&
        loops.every((loop) => loop.status === 'ok' || loop.status === 'starting'),
      loops,
    };
  }

  private state(name: LoopName): State {
    const state = this.states.get(name);
    if (!state) throw new Error('loop is not registered');
    return state;
  }
}
