import type { BrowserContext, Page, Response } from "playwright";
import type { CredentialSet } from "../credentials/resolve.ts";
import type { ResponseCapture } from "../browser/capture.ts";
import type { Logger } from "../logging/logger.ts";

export interface Timeouts {
  navigationMs: number;
  resultsMs: number;
  actionMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = { navigationMs: 45_000, resultsMs: 30_000, actionMs: 15_000 };

/** Everything an adapter may use (specs/04). Adapters never touch the filesystem or logger setup directly. */
export interface ScrapeContext {
  /** Playwright page, already launched. Throws for adapters with usesBrowser: false. */
  page: Page;
  browserContext: BrowserContext;
  /** Child logger tagged with adapter + runId */
  log: Logger;
  /** Resolved keys; never log values */
  credentials: CredentialSet;
  /** Enforces --delay between actions */
  politeWait(): Promise<void>;
  /** Network JSON capture helpers (specs/05) */
  capture: ResponseCapture;
  options: { maxRecords?: number; docs: boolean; headed: boolean };
  timeouts: Timeouts;
  /** Set on Ctrl+C or when --max-records is reached */
  signal: AbortSignal;

  /**
   * Polite, retried navigation. Throws BlockedError on 403/CAPTCHA,
   * TransientError on 429/5xx (honoring Retry-After).
   */
  goto(url: string): Promise<Response | null>;
  /** Save screenshots/<name>.png and .html; returns the path relative to the run folder. */
  screenshot(name: string): Promise<string | undefined>;
  /** Throws BlockedError if a CAPTCHA or bot challenge is showing. */
  assertNotBlocked(): Promise<void>;
  /**
   * Polite, retried GET of a JSON endpoint, for adapters using an agency-documented public API
   * (usesBrowser: false). Same rules as goto(): 401/403 -> BlockedError, 429/5xx -> TransientError.
   */
  /** Like fetchJson for text (HTML pages). Also checks the URL's robots.txt. */
  fetchText(url: string): Promise<string>;
  /** Like fetchText, but streams the body so large file downloads are never held in memory. */
  fetchStream(url: string): Promise<AsyncIterable<Uint8Array>>;
  /** Throws BlockedError if robots.txt disallows a URL found at runtime. */
  assertRobots(url: string): Promise<void>;
  fetchJson<T = unknown>(url: string, params?: Record<string, string | number | boolean>): Promise<T>;
}
