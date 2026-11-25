import { sleep } from "./retry.ts";

/**
 * Enforces a minimum delay (plus 0–500 ms jitter) between navigations, searches and page turns.
 * The first call does not wait.
 */
export class PoliteDelay {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly delayMs: number,
    private readonly jitterMs = 500,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  /** Serialized so concurrent callers can never overlap (one page-load in flight). */
  politeWait(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.last !== 0) {
        const target = this.delayMs + Math.random() * this.jitterMs;
        const elapsed = Date.now() - this.last;
        if (elapsed < target) await this.wait(target - elapsed);
      }
      this.last = Date.now();
    });
    return this.chain;
  }
}
