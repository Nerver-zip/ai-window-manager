export interface Clock {
  now(): Date;
  monotonicMs(): number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  monotonicMs(): number {
    return performance.now();
  }
}

export class FakeClock implements Clock {
  private currentMs: number;
  private monoMs = 0;

  constructor(initial: string | Date) {
    this.currentMs = new Date(initial).getTime();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  monotonicMs(): number {
    return this.monoMs;
  }

  advanceMs(ms: number): void {
    if (ms < 0) throw new Error('FakeClock cannot move backwards');
    this.currentMs += ms;
    this.monoMs += ms;
  }
}
