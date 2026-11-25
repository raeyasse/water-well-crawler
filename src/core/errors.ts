/** Error types from specs/09. Each maps to an exit code and report status. */

export class WellsError extends Error {
  readonly exitCode: number = 2;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Bad state / county / options. Exit 3. */
export class InputError extends WellsError {
  override readonly exitCode = 3;
}

/** Required credential keys not found. Exit 4. */
export class CredentialsMissingError extends WellsError {
  override readonly exitCode = 4;
  constructor(
    readonly missingKeys: string[],
    readonly placesChecked: string[],
  ) {
    super(
      `Missing credentials: ${missingKeys.join(", ")}. Checked: ${placesChecked.join("; ")}.`,
    );
  }
}

/** Login rejected. Exit 4. Never retried (avoid account lockouts). */
export class AuthFailedError extends WellsError {
  override readonly exitCode = 4;
}

/** CAPTCHA, 403, bot challenge, robots disallow. Exit 5. Never retried. */
export class BlockedError extends WellsError {
  override readonly exitCode = 5;
  screenshot?: string;
}

/** Expected selector/endpoint not found after waits: the adapter needs updating. */
export class SiteChangedError extends WellsError {
  screenshot?: string;
}

/** Timeout, network error, 429, 5xx. Retried with backoff. */
export class TransientError extends WellsError {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** One record can't be normalized. The record goes to invalid.jsonl and the run continues. */
export class ParseError extends WellsError {}

/** Playwright timeouts and network failures count as transient. */
export function isTransient(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  if (err instanceof WellsError) return false;
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || (err.cause instanceof Error && isTransient(err.cause)) || /net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|UND_ERR/i.test(err.message);
}
