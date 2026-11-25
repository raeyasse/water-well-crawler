import type { Page } from "playwright";
import { buildUserAgent, launchBrowser, type BrowserSession } from "../browser/launch.ts";
import { ResponseCapture, type CapturedResponse } from "../browser/capture.ts";
import { detectBlock, saveScreenshot } from "../browser/helpers.ts";
import { deleteSession, hasSession, saveSession, sessionPath } from "../credentials/sessions.ts";
import { makeCredentialSet, type CredentialSet, type ResolveEnv } from "../credentials/resolve.ts";
import type { Logger } from "../logging/logger.ts";
import type { StateAdapter } from "../adapters/types.ts";
import type { ScrapeContext, Timeouts } from "./context.ts";
import { AuthFailedError, BlockedError, SiteChangedError, TransientError, WellsError } from "./errors.ts";
import { PoliteDelay } from "./rate-limit.ts";
import { parseRetryAfter, retry } from "./retry.ts";

export interface SessionOptions {
  adapter: StateAdapter;
  /** State code used for credential keys and the session store. */
  state: string;
  log: Logger;
  credentials?: CredentialSet;
  delay: number;
  headed: boolean;
  contact?: string;
  timeouts: Timeouts;
  signal: AbortSignal;
  maxRecords?: number;
  docs?: boolean;
  /** Where ctx.screenshot() writes. */
  screenshotDir: string;
  /** Path prefix stripper for screenshot paths in the report. */
  relPath?: (abs: string) => string;
  onBody?: (res: CapturedResponse) => void;
  /** Load the saved session for this state if one exists. Default: adapter.requiresAuth. */
  useSavedSession?: boolean;
  sessionEnv?: ResolveEnv;
  recordHar?: string;
  replayHar?: string;
  /** HTTP client for ctx.fetchJson (injected in tests and fixture replay). */
  fetch?: typeof fetch;
}

export interface Session {
  ctx: ScrapeContext;
  browser?: BrowserSession;
  savedSessionLoaded: boolean;
  close(): Promise<void>;
}

/** Launch the browser (when the adapter uses one) and build the ScrapeContext adapters receive. */
export async function openSession(opts: SessionOptions): Promise<Session> {
  const { adapter, log, timeouts, signal } = opts;
  const usesBrowser = adapter.usesBrowser !== false;
  const useSaved = (opts.useSavedSession ?? adapter.requiresAuth) && hasSession(opts.state, opts.sessionEnv);

  const browser = usesBrowser
    ? await launchBrowser({
        headed: opts.headed,
        contact: opts.contact,
        storageState: useSaved ? sessionPath(opts.state, opts.sessionEnv) : undefined,
        recordHar: opts.recordHar,
        replayHar: opts.replayHar,
      })
    : undefined;
  if (browser) {
    browser.page.setDefaultTimeout(timeouts.actionMs);
    browser.page.setDefaultNavigationTimeout(timeouts.navigationMs);
  }

  const polite = new PoliteDelay(opts.delay);
  const fetchFn = opts.fetch ?? fetch;
  const apiUserAgent = buildUserAgent("Mozilla/5.0 (compatible; Node.js)", opts.contact);
  const rel = opts.relPath ?? ((p: string) => p);
  const noBrowser = (): never => {
    throw new Error(`Adapter ${adapter.state} declared usesBrowser: false; no page is available`);
  };
  const page = (): Page => browser?.page ?? noBrowser();

  const ctx: ScrapeContext = {
    get page() {
      return page();
    },
    get browserContext() {
      return browser?.context ?? noBrowser();
    },
    log,
    credentials: opts.credentials ?? makeCredentialSet(),
    politeWait: () => polite.politeWait(),
    capture: new ResponseCapture(browser?.page, { log, defaultTimeoutMs: timeouts.resultsMs, onBody: opts.onBody }),
    options: { maxRecords: opts.maxRecords, docs: opts.docs ?? false, headed: opts.headed },
    timeouts,
    signal,
    async screenshot(name) {
      if (!browser) return undefined;
      const file = await saveScreenshot(browser.page, opts.screenshotDir, name);
      return file && rel(file);
    },
    async assertNotBlocked() {
      const reason = await detectBlock(page());
      if (reason) throw await blocked(ctx, reason);
    },
    async fetchJson<T>(url: string, params?: Record<string, string | number | boolean>): Promise<T> {
      const full = new URL(url);
      for (const [k, v] of Object.entries(params ?? {})) full.searchParams.set(k, String(v));
      const target = full.toString();
      await ctx.politeWait();
      return retry(
        async () => {
          const t0 = Date.now();
          const res = await fetchFn(target, {
            headers: { "user-agent": apiUserAgent, accept: "application/json" },
            signal: AbortSignal.timeout(timeouts.navigationMs),
          });
          log.debug({ event: "navigate", url: target, status: res.status, ms: Date.now() - t0 }, "navigate");
          if (res.status === 401 || res.status === 403) throw new BlockedError(`Access denied (HTTP ${res.status}) at ${full.origin}${full.pathname}`);
          if (res.status === 429 || res.status >= 500) throw new TransientError(`HTTP ${res.status} at ${full.origin}${full.pathname}`, parseRetryAfter(res.headers.get("retry-after")));
          if (!res.ok) throw new SiteChangedError(`HTTP ${res.status} at ${full.origin}${full.pathname}`);
          let body: unknown;
          try {
            body = await res.json();
          } catch {
            throw new SiteChangedError(`Non-JSON response from ${full.origin}${full.pathname}`);
          }
          log.debug({ event: "capture.response", url: target, status: res.status }, "capture.response");
          opts.onBody?.({ url: target, status: res.status, body });
          return body as T;
        },
        { signal, onRetry: logRetry(log, `fetch ${full.origin}${full.pathname}`) },
      );
    },
    async goto(url) {
      await ctx.politeWait();
      return retry(
        async () => {
          const t0 = Date.now();
          const res = await page().goto(url, { waitUntil: "domcontentloaded", timeout: timeouts.navigationMs });
          const status = res?.status();
          log.debug({ event: "navigate", url, status, ms: Date.now() - t0 }, "navigate");
          if (status === 403 || status === 401) throw await blocked(ctx, `Access denied (HTTP ${status}) at ${url}`);
          if (status === 429 || (status !== undefined && status >= 500)) {
            throw new TransientError(`HTTP ${status} at ${url}`, parseRetryAfter(res?.headers()["retry-after"]));
          }
          await ctx.assertNotBlocked();
          return res;
        },
        { signal, onRetry: logRetry(log, `goto ${url}`) },
      );
    },
  };

  return {
    ctx,
    browser,
    savedSessionLoaded: useSaved,
    close: async () => {
      await browser?.close();
    },
  };
}

async function blocked(ctx: ScrapeContext, reason: string): Promise<BlockedError> {
  const err = new BlockedError(reason);
  err.screenshot = await ctx.screenshot("blocked");
  return err;
}

export function logRetry(log: Logger, action: string) {
  return ({ attempt, error, waitMs }: { attempt: number; error: unknown; waitMs: number }): void => {
    log.warn({ event: "retry", action, attempt, error: String((error as Error)?.message ?? error), waitMs: Math.round(waitMs) }, "retry");
  };
}

/**
 * Reuse a saved session if adapter.isLoggedIn() confirms it; otherwise log in once and save the session.
 * Login is never retried (avoid lockouts).
 */
export async function authenticate(adapter: StateAdapter, session: Session, state: string, log: Logger, sessionEnv?: ResolveEnv): Promise<"reused" | "login"> {
  const { ctx } = session;
  if (session.savedSessionLoaded) {
    const valid = adapter.isLoggedIn ? await adapter.isLoggedIn(ctx).catch(() => false) : false;
    if (valid) {
      log.info({ event: "session.reused" }, "session.reused");
      return "reused";
    }
    log.info({ event: "session.expired" }, "Saved session is no longer valid; logging in again");
    deleteSession(state, sessionEnv);
    await ctx.browserContext.clearCookies();
  }
  if (!adapter.login) throw new AuthFailedError(`Adapter ${adapter.state} requires auth but has no login(); run \`wells login --state ${state}\``);
  try {
    await adapter.login(ctx);
    if (adapter.isLoggedIn && !(await adapter.isLoggedIn(ctx))) throw new AuthFailedError("Login did not succeed (still signed out)");
  } catch (err) {
    log.warn({ event: "login.failed", error: (err as Error).message }, "login.failed");
    if (err instanceof WellsError) throw err;
    throw new AuthFailedError(`Login failed: ${(err as Error).message}`, { cause: err });
  }
  await saveSession(ctx.browserContext, state, sessionEnv);
  log.info({ event: "login.success" }, "login.success");
  return "login";
}
