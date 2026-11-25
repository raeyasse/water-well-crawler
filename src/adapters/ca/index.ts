import { SiteChangedError, TransientError } from "../../core/errors.ts";
import { retry } from "../../core/retry.ts";
import { logRetry } from "../../core/session.ts";
import type { AdapterEvent, County, ScrapeContext, StateAdapter } from "../types.ts";
import { normalizeCa } from "./normalize.ts";
import {
  LAYER_URL,
  PAGE_SIZE,
  QUERY_URL,
  serviceCountyName,
  sqlString,
  type ArcGisError,
  type CountResponse,
  type FeaturePage,
} from "./service.ts";

/**
 * California DWR Well Completion Reports. Uses the dataset's public ArcGIS map service, which DWR
 * publishes on the state open-data portal (specs/04 allows documented public APIs). See README.md.
 */

function isArcGisError(body: unknown): body is ArcGisError {
  return !!body && typeof body === "object" && "error" in body;
}

/** ArcGIS returns HTTP 200 with an error body; translate it to our error types. */
function check<T>(body: T | ArcGisError, what: string): T {
  if (!isArcGisError(body)) return body;
  const { code, message } = body.error;
  if (code === 429 || code >= 500) throw new TransientError(`${what}: ArcGIS error ${code} ${message}`);
  throw new SiteChangedError(`${what}: ArcGIS error ${code} ${message}`);
}

/** One query, retried as a unit: ArcGIS reports server errors inside HTTP 200 bodies. */
function query<T>(ctx: ScrapeContext, params: Record<string, string | number | boolean>, what: string): Promise<T> {
  return retry(async () => check(await ctx.fetchJson<T | ArcGisError>(QUERY_URL, { ...params, f: "json" }), what), {
    signal: ctx.signal,
    onRetry: logRetry(ctx.log, what),
  });
}

export const caAdapter: StateAdapter = {
  state: "CA",
  sourceName: "California DWR Well Completion Reports",
  sourceUrl: LAYER_URL,
  version: "1.0.0",
  lastVerified: "2026-10-24",
  requiresAuth: false,
  usesBrowser: false,
  sampleCounty: "Alpine",
  bounds: { minLat: 32.5, maxLat: 42.01, minLon: -124.5, maxLon: -114.1 },
  // Report PDFs are in a Box folder viewer, not direct file links, so --docs can't fetch them; links are kept in `documents`.
  capabilities: { construction: true, waterLevels: false, quality: false, documents: false },

  async *scrape(ctx: ScrapeContext, county: County): AsyncIterable<AdapterEvent> {
    const countyWhere = `CountyName = ${sqlString(serviceCountyName(county.name))}`;

    const count = await query<CountResponse>(ctx, { where: countyWhere, returnCountOnly: true }, "count query");
    if (typeof count.count !== "number") throw new SiteChangedError("count query: response has no count");
    yield { type: "total", count: count.count };
    const pages = Math.ceil(count.count / PAGE_SIZE);

    // Keyset paging on OBJECTID: stable even if records are added between pages (unlike resultOffset).
    let lastId = -1;
    for (let index = 1; !ctx.signal.aborted; index++) {
      const page = await query<FeaturePage>(
        ctx,
        { where: `${countyWhere} AND OBJECTID > ${lastId}`, outFields: "*", orderByFields: "OBJECTID ASC", resultRecordCount: PAGE_SIZE, returnGeometry: false },
        `page ${index}`,
      );
      if (!Array.isArray(page.features)) throw new SiteChangedError(`page ${index}: response has no features array`);
      if (!page.features.length) return;

      for (const { attributes } of page.features) {
        const id = typeof attributes.WCRNumber === "string" ? attributes.WCRNumber : undefined;
        yield { type: "record", raw: { ...attributes, _sourceId: id, _sourceUrl: typeof attributes.WCRLinks === "string" ? attributes.WCRLinks : undefined } };
      }
      yield { type: "page", index, of: Math.max(pages, index) };

      const next = Number(page.features.at(-1)!.attributes.OBJECTID);
      if (!Number.isFinite(next) || next <= lastId) throw new SiteChangedError(`page ${index}: OBJECTID ordering broken`);
      lastId = next;
      if (page.features.length < PAGE_SIZE && !page.exceededTransferLimit) return;
    }
  },

  normalize: (raw) => normalizeCa(raw),
};
