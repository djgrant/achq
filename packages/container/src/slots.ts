/** At most `max` runs at once, across all threads. `onBusy` and `onIdle` mark the first run starting and the last one ending. */
export class RunSlots {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private max: number,
    private hooks: { onBusy: () => void; onIdle: () => void },
  ) {}

  async run(fn: () => Promise<void>) {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    if (this.active++ === 0) this.hooks.onBusy();
    try {
      await fn();
    } finally {
      if (--this.active === 0) this.hooks.onIdle();
      this.waiting.shift()?.();
    }
  }
}
