/**
 * Template for a new state adapter. Copy this folder to src/adapters/<xx>/, fill in the TODOs,
 * then register it in src/adapters/index.ts. See specs/04-state-adapters.md for the checklist.
 */
import { expectVisible, safeClick, waitForResults } from "../../browser/helpers.ts";
import { SiteChangedError } from "../../core/errors.ts";
import type { AdapterEvent, County, ScrapeContext, StateAdapter } from "../types.ts";
import { normalizeTemplate } from "./normalize.ts";
import { sel } from "./selectors.ts";

export const templateAdapter: StateAdapter = {
  state: "XX", // TODO: USPS code
  sourceName: "TODO Agency Well Records",
  sourceUrl: "https://example.gov/wells", // TODO
  version: "0.1.0",
  lastVerified: "1970-01-01", // TODO: set after verifying against the live site
  requiresAuth: false,
  sampleCounty: "TODO", // a small county used by `wells check`
  // bounds: { minLat, maxLat, minLon, maxLon }, // TODO: state bounding box
  capabilities: { construction: true, waterLevels: false, quality: false, documents: false },

  async *scrape(ctx: ScrapeContext, county: County): AsyncIterable<AdapterEvent> {
    const { page } = ctx;
    await ctx.goto(this.sourceUrl);
    await expectVisible(sel.countySelect(page), "county dropdown", ctx.timeouts.resultsMs);

    // Capture first: register before triggering the search. TODO: the endpoint found in DevTools.
    const results = ctx.capture.collect({ url: /\/api\/wells/, method: "GET" });
    try {
      await ctx.politeWait();
      await sel.countySelect(page).selectOption({ label: county.name });
      await safeClick(sel.search(page), { timeoutMs: ctx.timeouts.actionMs, signal: ctx.signal });
      await waitForResults(page, { rows: sel.resultRows(page), empty: sel.empty(page), timeoutMs: ctx.timeouts.resultsMs });

      for (let index = 1; !ctx.signal.aborted; index++) {
        const res = await results.next();
        const body = res.body as { total?: number; items?: Record<string, unknown>[] }; // TODO: real shape
        if (!Array.isArray(body.items)) throw new SiteChangedError("results response shape changed");
        if (index === 1 && typeof body.total === "number") yield { type: "total", count: body.total };
        for (const item of body.items) yield { type: "record", raw: { ...item, _sourceId: String(item.id) } };
        yield { type: "page", index };

        const next = sel.next(page);
        if (!(await next.isEnabled())) return;
        await ctx.politeWait();
        await safeClick(next, { timeoutMs: ctx.timeouts.actionMs, signal: ctx.signal });
      }
    } finally {
      results.stop();
    }
  },

  normalize: (raw) => normalizeTemplate(raw),
};
