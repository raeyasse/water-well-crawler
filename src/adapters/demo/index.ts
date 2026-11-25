import { expectVisible, paginate, safeClick, waitForResults } from "../../browser/helpers.ts";
import { AuthFailedError, SiteChangedError } from "../../core/errors.ts";
import { retry } from "../../core/retry.ts";
import { logRetry } from "../../core/session.ts";
import type { CapturedResponse, CaptureQueue } from "../../browser/capture.ts";
import type { AdapterEvent, County, RawRecord, ScrapeContext, StateAdapter } from "../types.ts";
import { normalizeDemo } from "./normalize.ts";
import { sel } from "./selectors.ts";

/**
 * Demo adapter for the local fake SPA (test/fake-spa). It is the reference implementation of the
 * capture-first strategy (specs/05): drive the UI, read the JSON the site loads, fall back to the DOM.
 */

interface WellsPage {
  total: number;
  page: number;
  pages: number;
  wells: Record<string, unknown>[];
}

export const DEMO_DEFAULT_URL = "http://127.0.0.1:4599";

export function makeDemoAdapter(opts: { auth: boolean; baseUrl?: string }): StateAdapter {
  const base = (): string => (opts.baseUrl ?? process.env.WELLS_DEMO_URL ?? DEMO_DEFAULT_URL).replace(/\/$/, "");

  const toRaw = (w: Record<string, unknown>): RawRecord => ({
    ...w,
    _sourceId: typeof w.WellID === "string" && w.WellID ? w.WellID : undefined,
    _sourceUrl: typeof w.WellID === "string" && w.WellID ? `${base()}/well/${encodeURIComponent(w.WellID)}` : undefined,
  });

  async function openSearch(ctx: ScrapeContext): Promise<void> {
    const { page } = ctx;
    await ctx.goto(`${base()}/`);
    const agree = sel.agree(page);
    await expectVisible(agree, "terms disclaimer", ctx.timeouts.resultsMs);
    await agree.click();
    ctx.log.info({ event: "terms.accepted" }, "Accepted site terms-of-use disclaimer");
    await expectVisible(sel.countySelect(page), "county dropdown", ctx.timeouts.resultsMs);
  }

  const adapter: StateAdapter = {
    state: "DEV",
    sourceName: opts.auth ? "Demo Well Records (login required)" : "Demo Well Records",
    get sourceUrl() {
      return `${base()}/`;
    },
    version: "1.0.0",
    lastVerified: "2026-10-24",
    requiresAuth: opts.auth,
    credentialKeys: opts.auth ? ["USERNAME", "PASSWORD"] : undefined,
    sampleCounty: "Wake",
    bounds: { minLat: 33.75, maxLat: 36.6, minLon: -84.33, maxLon: -75.4 },
    capabilities: { construction: true, waterLevels: true, quality: false, documents: true },

    async isLoggedIn(ctx) {
      await ctx.goto(`${base()}/`);
      const which = await Promise.any([
        sel.signOut(ctx.page).waitFor({ timeout: ctx.timeouts.resultsMs }).then(() => "in"),
        sel.signIn(ctx.page).waitFor({ timeout: ctx.timeouts.resultsMs }).then(() => "out"),
      ]).catch(() => "unknown");
      return which === "in";
    },

    async login(ctx) {
      const { page } = ctx;
      await ctx.goto(`${base()}/`);
      await expectVisible(sel.username(page), "login form", ctx.timeouts.resultsMs);
      await sel.username(page).fill(ctx.credentials.get("USERNAME"));
      await sel.password(page).fill(ctx.credentials.get("PASSWORD"));
      await sel.signIn(page).click();
      const outcome = await Promise.any([
        sel.signOut(page).waitFor({ timeout: ctx.timeouts.resultsMs }).then(() => "ok"),
        sel.loginError(page).waitFor({ timeout: ctx.timeouts.resultsMs }).then(() => "rejected"),
      ]).catch(() => "timeout");
      if (outcome === "rejected") throw new AuthFailedError("Login rejected by the site (check WELLS_<STATE>_USERNAME/PASSWORD)");
      if (outcome === "timeout") throw new SiteChangedError("No response to login form");
    },

    async *scrape(ctx: ScrapeContext, county: County): AsyncIterable<AdapterEvent> {
      const { page } = ctx;
      await openSearch(ctx);

      const select = sel.countySelect(page);
      const offered = await select.locator(`option[value="${county.fips}"]`).count();
      if (!offered) {
        yield { type: "warning", message: `${county.name} is not offered by the site's county list` };
        yield { type: "total", count: 0 };
        return;
      }

      // Register the capture before triggering the search so the first response isn't missed.
      const results = ctx.capture.collect({ url: /\/api\/wells\?/, method: "GET" });
      try {
        await ctx.politeWait();
        await select.selectOption(county.fips);
        await safeClick(sel.search(page), { timeoutMs: ctx.timeouts.actionMs, signal: ctx.signal });
        const shown = await waitForResults(page, { rows: sel.resultRows(page), empty: sel.empty(page), timeoutMs: ctx.timeouts.resultsMs, what: "results table" });

        const first = results.tryNext() ?? (await results.next({ timeoutMs: 2_000 }).catch(() => undefined));
        if (first && isWellsPage(first.body)) {
          yield* captureMode(ctx, results, first);
        } else if (shown === "empty") {
          yield { type: "total", count: 0 };
        } else {
          ctx.log.info({ event: "strategy", mode: "dom" }, "No JSON results response seen; falling back to DOM parsing");
          yield* domMode(ctx);
        }
      } finally {
        results.stop();
      }
    },

    normalize: (raw) => normalizeDemo(raw),

    documents(raw) {
      return raw.HasLog && raw._sourceId ? [{ url: `${base()}/docs/${encodeURIComponent(raw._sourceId)}.pdf`, type: "well_log" }] : [];
    },
  };

  async function* captureMode(ctx: ScrapeContext, results: CaptureQueue, first: CapturedResponse): AsyncGenerator<AdapterEvent> {
    let batch = first.body as WellsPage;
    yield { type: "total", count: batch.total };
    for (;;) {
      for (const w of batch.wells) yield { type: "record", raw: toRaw(w) };
      yield { type: "page", index: batch.page, of: batch.pages };
      if (batch.page >= batch.pages || ctx.signal.aborted) return;

      const expected = batch.page + 1;
      await ctx.politeWait();
      // The site shows a Retry button when a page request fails; use it on later attempts.
      const res = await retry(
        async (attempt) => {
          results.clear();
          await safeClick(attempt === 1 ? sel.next(ctx.page) : sel.retry(ctx.page), { timeoutMs: ctx.timeouts.actionMs, signal: ctx.signal });
          return results.next();
        },
        { signal: ctx.signal, onRetry: logRetry(ctx.log, `page ${expected}`) },
      );
      if (!isWellsPage(res.body) || res.body.page !== expected) throw new SiteChangedError(`Unexpected results response for page ${expected}`);
      batch = res.body;
    }
  }

  async function* domMode(ctx: ScrapeContext): AsyncGenerator<AdapterEvent> {
    const { page } = ctx;
    const caption = (await sel.resultsTable(page).locator("caption").textContent()) ?? "";
    const total = Number(caption.match(/(\d+)\s+wells found/i)?.[1]);
    if (Number.isFinite(total)) yield { type: "total", count: total };

    let pages: number | undefined;
    let lastFirstId = "";
    for await (const { index, records } of paginate(ctx, {
      mode: "next",
      next: sel.next(page),
      extract: async () => {
        const status = (await sel.pageStatus(page).textContent()) ?? "";
        pages = Number(status.match(/of (\d+)/)?.[1]) || undefined;
        return readRows(ctx);
      },
      afterTurn: async () => {
        // Wait until the first row changes, i.e. the next page has rendered.
        await page.waitForFunction(
          (prev) => document.querySelector("table tbody tr td")?.textContent?.trim() !== prev,
          lastFirstId,
          { timeout: ctx.timeouts.resultsMs },
        );
      },
    })) {
      lastFirstId = String(records[0]?.WellID ?? lastFirstId);
      for (const raw of records) yield { type: "record", raw };
      yield { type: "page", index, of: pages };
    }
  }

  async function readRows(ctx: ScrapeContext): Promise<RawRecord[]> {
    const rows = await sel.resultRows(ctx.page).evaluateAll((trs) =>
      trs.map((tr) => {
        const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? "");
        const href = tr.querySelector("a")?.getAttribute("href") ?? "";
        return { cells, href };
      }),
    );
    if (rows.length && rows[0]!.cells.length < 7) throw new SiteChangedError("results table columns changed");
    return rows.map(({ cells, href }) =>
      toRaw({
        WellID: cells[0],
        PermitNo: cells[1],
        OwnerName: cells[2],
        WellUse: cells[3],
        Status: cells[4],
        TotalDepth: cells[5]?.replace(/\s*m$/, ""),
        DepthUnits: cells[5]?.endsWith(" m") ? "m" : "ft",
        DateCompleted: cells[6],
        detailPath: href,
      }),
    );
  }

  return adapter;
}

function isWellsPage(body: unknown): body is WellsPage {
  return !!body && typeof body === "object" && Array.isArray((body as WellsPage).wells) && typeof (body as WellsPage).page === "number";
}
