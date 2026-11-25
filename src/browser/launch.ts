import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export const TOOL_NAME = "well-scraper";
export const TOOL_VERSION = "1.0.0";

export interface LaunchOptions {
  headed: boolean;
  /** Operator contact appended to the user agent. */
  contact?: string;
  /** Saved storageState to load before navigating (specs/06). */
  storageState?: string;
  /** Record a HAR (fixture recording). */
  recordHar?: string;
  /** Serve all requests from a recorded HAR (offline replay tests). */
  replayHar?: string;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  userAgent: string;
  close(): Promise<void>;
}

/** Playwright's Chromium UA plus an honest identifier: "... well-scraper/1.0 (+contact: x)". */
export function buildUserAgent(base: string, contact?: string): string {
  return `${base} ${TOOL_NAME}/${TOOL_VERSION}${contact ? ` (+contact: ${contact})` : ""}`;
}

/** One browser, one context, one page per run (no parallelism in v1). */
export async function launchBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: !opts.headed });
  const base = await getDefaultUserAgent(browser);
  const userAgent = buildUserAgent(base, opts.contact);
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    acceptDownloads: true,
    storageState: opts.storageState,
    recordHar: opts.recordHar ? { path: opts.recordHar, content: "embed" } : undefined,
  });
  if (opts.replayHar) await context.routeFromHAR(opts.replayHar, { notFound: "abort" });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    userAgent,
    async close() {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

async function getDefaultUserAgent(browser: Browser): Promise<string> {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    return await page.evaluate(() => navigator.userAgent);
  } finally {
    await ctx.close();
  }
}

/** Installed Playwright version, for the run log and report. */
export function playwrightVersion(): string {
  try {
    return (createRequire(import.meta.url)("playwright/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}
