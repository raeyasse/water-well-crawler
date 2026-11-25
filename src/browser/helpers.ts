import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { BlockedError, SiteChangedError } from "../core/errors.ts";
import { retry } from "../core/retry.ts";
import type { RawRecord, ScrapeContext } from "../adapters/types.ts";

/**
 * Resolve when either the results locator or the empty-state locator appears.
 * Throws SiteChangedError naming `what` if neither shows up in time.
 */
export async function waitForResults(
  page: Page,
  opts: { rows: Locator; empty?: Locator; timeoutMs?: number; what?: string },
): Promise<"rows" | "empty"> {
  const timeout = opts.timeoutMs ?? 30_000;
  const waits: Promise<"rows" | "empty">[] = [opts.rows.first().waitFor({ state: "visible", timeout }).then(() => "rows" as const)];
  if (opts.empty) waits.push(opts.empty.first().waitFor({ state: "visible", timeout }).then(() => "empty" as const));
  try {
    return await Promise.any(waits);
  } catch {
    throw new SiteChangedError(`${opts.what ?? "results"} did not appear within ${timeout} ms`);
  }
}

/** Wait for a key element; throws SiteChangedError("<what> not found") instead of a generic timeout. */
export async function expectVisible(locator: Locator, what: string, timeoutMs = 15_000): Promise<Locator> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    return locator;
  } catch {
    throw new SiteChangedError(`${what} not found`);
  }
}

/** Scroll into view, wait until enabled, click — retried on transient failures. */
export async function safeClick(locator: Locator, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 15_000;
  await retry(
    async () => {
      await locator.scrollIntoViewIfNeeded({ timeout });
      await locator.click({ timeout });
    },
    { attempts: 3, baseMs: 500, signal: opts.signal },
  );
}

export interface PaginateOptions {
  mode: "next" | "numbered" | "scroll";
  /** Read the records currently shown (DOM fallback) or the latest captured batch. */
  extract: (pageIndex: number) => Promise<RawRecord[]>;
  /** "next" mode: the next-page control. */
  next?: Locator;
  /** "numbered" mode: locator for page n (1-based). */
  pageLink?: (n: number) => Locator;
  /** "scroll" mode: the scrollable container (defaults to the window). */
  scrollContainer?: Locator;
  /** Wait after a page turn until new content is ready. */
  afterTurn?: (pageIndex: number) => Promise<void>;
  maxPages?: number;
}

export interface PageBatch {
  index: number;
  records: RawRecord[];
}

/**
 * Generic pagination loop. Stops when there is no next page, a page yields no new records, or the run is aborted.
 * In scroll mode, rows still on screen from the last step are not yielded twice. Other modes keep
 * repeated records (core keeps duplicates for later cleanup) and stop when a page adds nothing new.
 */
export async function* paginate(ctx: ScrapeContext, opts: PaginateOptions): AsyncGenerator<PageBatch> {
  const seen = new Set<string>();
  const maxPages = opts.maxPages ?? Number.POSITIVE_INFINITY;
  for (let index = 1; index <= maxPages; index++) {
    if (ctx.signal.aborted) return;
    const all = await opts.extract(index);
    const fresh = all.filter((r) => {
      if (r._sourceId === undefined) return true;
      if (seen.has(r._sourceId)) return false;
      seen.add(r._sourceId);
      return true;
    });
    if (!fresh.length && index > 1) return;
    yield { index, records: opts.mode === "scroll" ? fresh : all };
    if (ctx.signal.aborted) return;

    if (opts.mode === "next") {
      const next = opts.next;
      if (!next || !(await next.isVisible()) || !(await next.isEnabled()) || (await next.getAttribute("aria-disabled")) === "true") return;
      await ctx.politeWait();
      await safeClick(next, { timeoutMs: ctx.timeouts.actionMs, signal: ctx.signal });
    } else if (opts.mode === "numbered") {
      const link = opts.pageLink?.(index + 1);
      if (!link || (await link.count()) === 0) return;
      await ctx.politeWait();
      await safeClick(link.first(), { timeoutMs: ctx.timeouts.actionMs, signal: ctx.signal });
    } else {
      await ctx.politeWait();
      if (opts.scrollContainer) await opts.scrollContainer.evaluate((el) => el.scrollBy(0, el.clientHeight));
      else await ctx.page.mouse.wheel(0, 900);
    }
    await opts.afterTurn?.(index + 1);
  }
}

const CAPTCHA_SELECTORS = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha.com']",
  "iframe[src*='challenges.cloudflare.com']",
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
  "[data-sitekey]",
  "#challenge-form",
];

const CHALLENGE_TITLES = /just a moment|attention required|access denied|are you a robot|security check/i;

/** Returns a reason string if the page shows a CAPTCHA, bot challenge, or access-denied interstitial. */
export async function detectBlock(page: Page): Promise<string | null> {
  for (const sel of CAPTCHA_SELECTORS) {
    if ((await page.locator(sel).count().catch(() => 0)) > 0) return `CAPTCHA or bot challenge detected (${sel})`;
  }
  const title = await page.title().catch(() => "");
  if (CHALLENGE_TITLES.test(title)) return `Bot challenge or access-denied page ("${title}")`;
  return null;
}

export async function throwIfBlocked(page: Page): Promise<void> {
  const reason = await detectBlock(page);
  if (reason) throw new BlockedError(reason);
}

/** Save <dir>/<name>.png and <name>.html. Returns the png path, or undefined if the page is gone. */
export async function saveScreenshot(page: Page, dir: string, name: string): Promise<string | undefined> {
  const safe = name.replace(/[^a-z0-9._-]+/gi, "-");
  mkdirSync(dir, { recursive: true });
  const png = join(dir, `${safe}.png`);
  try {
    await page.screenshot({ path: png, fullPage: true, timeout: 10_000 });
    writeFileSync(join(dir, `${safe}.html`), await page.content());
    return png;
  } catch {
    return undefined;
  }
}
