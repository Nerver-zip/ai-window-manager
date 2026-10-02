export interface ReconcileWorkerInput {
  providerIds: readonly string[];
  intervalMs: number;
  /** Return only hints for which a new read was actually attempted. */
  work: (hints: ReadonlySet<string>) => Promise<readonly string[]>;
  onError: (error: unknown) => void;
}

/** Bounded generations preserve requests received while earlier reads are running. */
export class ReconcileWorker {
  private readonly providerIds: ReadonlySet<string>;
  private readonly hints = new Map<string, number>();
  private generation = 0;
  private started = false;
  private stopped = false;
  private requested = false;
  private scheduled = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly input: ReconcileWorkerInput) {
    if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1)
      throw new RangeError('reconcile interval must be a positive safe integer');
    this.providerIds = new Set(input.providerIds);
    if (this.providerIds.size > 64) throw new RangeError('too many reconcile providers');
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.timer = setInterval(() => this.request(), this.input.intervalMs);
    this.timer.unref?.();
    if (this.requested) this.pump();
  }

  request(providerId?: string): boolean {
    if (this.stopped || (providerId !== undefined && !this.providerIds.has(providerId)))
      return false;
    if (providerId !== undefined) {
      this.generation = this.generation >= Number.MAX_SAFE_INTEGER ? 1 : this.generation + 1;
      this.hints.set(providerId, this.generation);
    }
    this.requested = true;
    if (this.started) this.pump();
    return true;
  }

  pendingProviderIds(): string[] {
    return [...this.hints.keys()];
  }

  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.requested = false;
    const captured = new Map(this.hints);
    const current = Promise.resolve()
      .then(() => this.input.work(new Set(captured.keys())))
      .then((consumed) => {
        for (const id of consumed)
          if (captured.has(id) && this.hints.get(id) === captured.get(id)) this.hints.delete(id);
      })
      .catch((error: unknown) => this.input.onError(error))
      .finally(() => {
        if (this.inFlight === current) this.inFlight = undefined;
        if (this.requested && this.started && !this.stopped) this.pump();
      });
    this.inFlight = current;
    return current;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private pump(): void {
    if (this.scheduled || this.inFlight || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.stopped) void this.runOnce();
    });
  }
}
