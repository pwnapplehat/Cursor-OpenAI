/** Serializes async work: each call to `runExclusive` waits for all previously queued work on this mutex to finish. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Lower-level lock acquisition for work whose critical section can't be
   * wrapped in a single callback - notably a held Cursor run that must stay
   * locked across multiple HTTP requests (the tool-loop bridge in hold mode).
   * Returns a release function the caller MUST invoke exactly once, in a
   * `finally` or terminal cleanup path, or the mutex stays locked forever.
   */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
}

/** Simple counting semaphore used to cap global concurrent Cursor agent runs. */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    this.available = max;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.available -= 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.available += 1;
    const next = this.queue.shift();
    if (next) next();
  }

  get inUse(): number {
    return this.max - this.available;
  }

  get queued(): number {
    return this.queue.length;
  }
}
