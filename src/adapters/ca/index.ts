import { SiteChangedError, TransientError } from "../../core/errors.ts";
import { retry } from "../../core/retry.ts";
import { logRetry } from "../../core/session.ts";
import { parseCsv } from "../../core/csv.ts";
import type { AdapterEvent, County, RawRecord, ScrapeContext, StateAdapter } from "../types.ts";
import { discoverFromPage, discoverLayer, findSources } from "./discover.ts";
import { normalizeCa } from "./normalize.ts";
import {
  LAYER_URL,
  PAGE_SIZE,
  PORTAL_URL,
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

type Params = Record<string, string | number | boolean>;
/** How a method requests one ArcGIS query URL. */
type Request = <T>(ctx: ScrapeContext, url: string, params: Params) => Promise<T>;

const viaHttp: Request = (ctx, url, params) => ctx.fetchJson(url, params);

/** The browser loads the query URL as a page. */
const viaBrowser: Request = async <T>(ctx: ScrapeContext, url: string, params: Params): Promise<T> => {
  const full = new URL(url);
  for (const [k, v] of Object.entries(params)) full.searchParams.set(k, String(v));
  const res = await ctx.goto(full.toString());
  if (!res?.ok()) throw new SiteChangedError(`HTTP ${res?.status()} at ${url}`);
  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new SiteChangedError(`Non-JSON response from ${url}`, { cause });
  }
};

async function* queryCounty(ctx: ScrapeContext, county: County, layerUrl: string, request: Request): AsyncGenerator<AdapterEvent> {
  // One query, retried as a unit: ArcGIS reports server errors inside HTTP 200 bodies.
  const query = <T>(params: Params, what: string): Promise<T> =>
    retry(async () => check(await request<T | ArcGisError>(ctx, `${layerUrl}/query`, { ...params, f: "json" }), what), {
      signal: ctx.signal,
      onRetry: logRetry(ctx.log, what),
    });
  const countyWhere = `CountyName = ${sqlString(serviceCountyName(county.name))}`;

  const count = await query<CountResponse>({ where: countyWhere, returnCountOnly: true }, "count query");
  if (typeof count.count !== "number") throw new SiteChangedError("count query: response has no count");
  yield { type: "total", count: count.count };
  const pages = Math.ceil(count.count / PAGE_SIZE);

  // Keyset paging on OBJECTID: stable even if records are added between pages (unlike resultOffset).
  let lastId = -1;
  for (let index = 1; !ctx.signal.aborted; index++) {
    const page = await query<FeaturePage>(
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
}

async function* scrapeApi(ctx: ScrapeContext, county: County): AsyncGenerator<AdapterEvent> {
  yield* queryCounty(ctx, county, await discoverLayer(ctx, discoverFromPage), viaHttp);
}

/** Open the dataset page in the browser, follow the service it lists, and load the county's result pages. */
async function* scrapeBrowser(ctx: ScrapeContext, county: County): AsyncGenerator<AdapterEvent> {
  const layer = await discoverLayer(ctx, async () => {
    await ctx.assertRobots(PORTAL_URL);
    await ctx.goto(PORTAL_URL);
    return findSources(await ctx.page.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href)));
  });
  yield* queryCounty(ctx, county, layer, viaBrowser);
}

/** Field names the CSV spells in capitals -> the service's names, so one normalize() serves every method. */
const CSV_FIELDS = new Map(
  (
    "WCRNumber LegacyLogNumber RegionOffice CountyName LocalPermitAgency PermitDate PermitNumber OwnerAssignedWellNumber WellLocation City " +
    "PlannedUseFormerUse DrillerName DrillerLicenseNumber RecordType DecimalLatitude DecimalLongitude MethodofDeterminationLL LLAccuracy " +
    "HorizontalDatum GroundSurfaceElevation ElevationAccuracy ElevationDeterminationMethod VerticalDatum Township Range Section " +
    "BaselineMeridian APN DateWorkEnded WorkflowStatus ReceivedDate TotalDrillDepth TotalCompletedDepth TopOfPerforatedInterval " +
    "BottomofPerforatedInterval CasingDiameter DrillingMethod Fluid StaticWaterLevel TotalDrawDown TestType PumpTestLength WellYield " +
    "WellYieldUnitofMeasure OtherObservations B118WellUse"
  )
    .split(" ")
    .map((f) => [f.toUpperCase(), f]),
);

/** Stream the statewide CSV the dataset page publishes, keeping the county's rows. */
async function* scrapeDownload(ctx: ScrapeContext, county: County): AsyncGenerator<AdapterEvent> {
  const { csvUrl } = await discoverFromPage(ctx);
  if (!csvUrl) throw new SiteChangedError("dataset page lists no Well Completion Reports CSV");
  ctx.log.info({ event: "source.discovered", url: csvUrl }, `Discovered ${csvUrl}`);
  const wanted = serviceCountyName(county.name).toLowerCase();
  let rows = 0;
  let matched = 0;
  for await (const row of parseCsv(await ctx.fetchStream(csvUrl))) {
    if (rows++ === 0 && !("WCRNUMBER" in row && "COUNTYNAME" in row)) throw new SiteChangedError("CSV columns changed: WCRNUMBER/COUNTYNAME missing");
    if (ctx.signal.aborted) return;
    if (row.COUNTYNAME?.trim().toLowerCase() !== wanted) continue;
    matched++;
    const raw: RawRecord = {};
    for (const [k, v] of Object.entries(row)) raw[CSV_FIELDS.get(k) ?? k] = v;
    raw._sourceId = row.WCRNUMBER || undefined;
    yield { type: "record", raw };
  }
  if (!rows) throw new SiteChangedError("CSV is empty");
  yield { type: "total", count: matched };
  yield { type: "page", index: 1, of: 1 };
}

export const caAdapter: StateAdapter = {
  state: "CA",
  sourceName: "California DWR Well Completion Reports",
  sourceUrl: LAYER_URL,
  version: "1.1.0",
  lastVerified: "2026-10-24",
  requiresAuth: false,
  usesBrowser: false,
  sampleCounty: "Alpine",
  bounds: { minLat: 32.5, maxLat: 42.01, minLon: -124.5, maxLon: -114.1 },
  // Report PDFs are in a Box folder viewer, not direct file links, so --docs can't fetch them; links are kept in `documents`.
  capabilities: { construction: true, waterLevels: false, quality: false, documents: false },

  scrape: scrapeApi,
  methods: [
    { kind: "api", scrape: scrapeApi },
    { kind: "browser", scrape: scrapeBrowser },
    { kind: "download", robotsPaths: [PORTAL_URL], scrape: scrapeDownload },
  ],

  normalize: (raw) => normalizeCa(raw),
};
