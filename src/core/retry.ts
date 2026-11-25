import { isTransient, TransientError } from "./errors.ts";

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  factor?: number;
  jitter?: boolean;
  signal?: AbortSignal;
  /** Called before each retry wait. */
  onRetry?: (info: { attempt: number; error: unknown; waitMs: number }) => void;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry transient failures with exponential backoff, honoring Retry-After (specs/09). */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseMs = 2000, factor = 2, jitter = true, signal, onRetry, sleep: wait = sleep } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransient(error) || signal?.aborted) throw error;
      let waitMs = baseMs * factor ** (attempt - 1);
      if (jitter) waitMs += Math.random() * baseMs * 0.25;
      if (error instanceof TransientError && error.retryAfterMs !== undefined) {
        waitMs = Math.max(waitMs, error.retryAfterMs);
      }
      onRetry?.({ attempt, error, waitMs });
      await wait(waitMs);
    }
  }
}

/** Parse a Retry-After header (seconds or HTTP date) to milliseconds. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
