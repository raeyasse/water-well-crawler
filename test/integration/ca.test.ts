import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PORTAL_URL, QUERY_URL } from "../../src/adapters/ca/service.ts";
import { caAdapter } from "../../src/adapters/ca/index.ts";
import type { ScrapeContext, StateAdapter } from "../../src/adapters/types.ts";
import { runScrape } from "../../src/core/run.ts";
import { options, readJson } from "../helpers.ts";

/** The API method on its own, so these tests stay offline. */
const adapter: StateAdapter = { ...caAdapter, methods: undefined };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
const strip = (wells: Record<string, unknown>[]) => wells.map(({ scraped_at: _, adapter_version: _v, ...w }) => w);

describe("CA adapter — offline replay of recorded DWR responses (Alpine)", () => {
  it("reproduces the recorded run exactly", async () => {
    const recorded = readJson<Record<string, unknown>>(new URL("../fixtures/ca/alpine.responses.json", import.meta.url).pathname);
    const replay: typeof fetch = async (input) => {
      const body = recorded[String(input)];
      return body === undefined ? notFound() : json(body);
    };
    const { exitCode, report, runDir } = await runScrape(options({ state: "CA", county: "Alpine" }), { adapter, quiet: true, fetch: replay });
    expect(exitCode).toBe(0);
    expect(report.counts).toMatchObject({ siteReportedTotal: 677, recordsWritten: 677, duplicatesSkipped: 0, duplicatesKept: 2, invalid: 0 });
    const expected = JSON.parse(readFileSync(new URL("../fixtures/ca/alpine.expected.wells.json", import.meta.url), "utf8"));
    const written = strip(readJson(join(runDir, "wells.json")));
    expect(written).toHaveLength(677);
    // Apart from the kept duplicates, records match the original recording.
    const ids = new Set<unknown>();
    expect(written.filter((w) => !ids.has(w.source_id) && ids.add(w.source_id))).toEqual(strip(expected));
  });
});

/** Minimal stand-in for the ArcGIS query endpoint, honoring the WHERE/ORDER/COUNT parameters the adapter sends. */
function fakeArcGis(total: number, opts: { failFirst?: { code: number } } = {}) {
  const rows = Array.from({ length: total }, (_, i) => ({ OBJECTID: 1000 + i * 3, WCRNumber: `WCR-T-${i}`, CountyName: "Yolo", B118WellUse: "Domestic", TotalCompletedDepth: 100 + i }));
  const calls: string[] = [];
  let failed = false;
  const fetchFn: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("robots.txt")) return notFound();
    if (!String(input).startsWith(QUERY_URL)) return notFound();
    calls.push(url.search);
    if (opts.failFirst && !failed && !url.searchParams.has("returnCountOnly")) {
      failed = true;
      return json({ error: { code: opts.failFirst.code, message: "test failure" } });
    }
    const where = url.searchParams.get("where") ?? "";
    if (!where.startsWith("CountyName = 'Yolo'")) return json({ count: 0, features: [] });
    if (url.searchParams.get("returnCountOnly")) return json({ count: rows.length });
    const after = Number(where.match(/OBJECTID > (-?\d+)/)?.[1] ?? -1);
    const n = Number(url.searchParams.get("resultRecordCount"));
    const page = rows.filter((r) => r.OBJECTID > after).slice(0, n);
    return json({ features: page.map((attributes) => ({ attributes })), exceededTransferLimit: rows.filter((r) => r.OBJECTID > after).length > n });
  };
  return { fetchFn, calls };
}

describe("CA adapter — paging and errors against a stub service", () => {
  it("walks every page with keyset paging", async () => {
    const { fetchFn, calls } = fakeArcGis(2345);
    const { exitCode, report } = await runScrape(options({ state: "CA", county: "Yolo" }), { adapter, quiet: true, fetch: fetchFn });
    expect(exitCode).toBe(0);
    expect(report.counts).toMatchObject({ siteReportedTotal: 2345, recordsWritten: 2345, pagesVisited: 3 });
    expect(calls.filter((c) => c.includes("OBJECTID"))).toHaveLength(3);
  });

  it("retries an ArcGIS 500 error body", async () => {
    const { fetchFn } = fakeArcGis(10, { failFirst: { code: 500 } });
    const { exitCode, report, runDir } = await runScrape(options({ state: "CA", county: "Yolo" }), { adapter, quiet: true, fetch: fetchFn });
    expect(exitCode).toBe(0);
    expect(report.counts.recordsWritten).toBe(10);
    expect(readFileSync(join(runDir, "run-log.jsonl"), "utf8")).toContain('"event":"retry"');
  }, 30_000);

  it("reports a changed service (ArcGIS 400) as a site change", async () => {
    const { fetchFn } = fakeArcGis(10, { failFirst: { code: 400 } });
    const { exitCode, report } = await runScrape(options({ state: "CA", county: "Yolo" }), { adapter, quiet: true, fetch: fetchFn });
    expect(exitCode).toBe(2);
    expect(report.errors[0]).toMatchObject({ name: "SiteChangedError" });
    expect(report.notes.join(" ")).toMatch(/may be out of date/);
  });

  it("warns that --docs is unsupported", async () => {
    const { fetchFn } = fakeArcGis(5);
    const { report } = await runScrape(options({ state: "CA", county: "Yolo", docs: true }), { adapter, quiet: true, fetch: fetchFn });
    expect(report.warnings[0]!.msg).toMatch(/--docs ignored/);
  });
});

const PORTAL_HTML = `
  <a href="https://data.cnra.ca.gov/dataset/x/resource/y/download/casingdata.csv">casing</a>
  <a href="https://data.cnra.ca.gov/dataset/x/resource/z/download/wellcompletionreports.csv">wcr</a>
  <a href="https://evil.example/download/wellcompletionreports.csv">no</a>
  <a href="https://www.arcgis.com/home/item.html?id=0123456789abcdef0123456789abcdef">service</a>`;
const CSV = '\uFEFFWCRNUMBER,COUNTYNAME,WELLLOCATION,TOTALCOMPLETEDDEPTH,DATEWORKENDED,B118WELLUSE\r\nA1,Yolo,"1 ""Main"" St, Rear",120,01/27/2025,Domestic\r\nB1,Solano,x,50,,\r\nA1,Yolo,dup,121,,\r\n';
const SERVICE = "https://moved.arcgis.com/rest/services/Wells/MapServer";

/** Portal, ArcGIS item, and a service at a new URL that only discovery can find. */
function caSite(opts: { portalDown?: boolean; robots?: string } = {}) {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url === "https://data.cnra.ca.gov/robots.txt" && opts.robots) return new Response(opts.robots, { headers: { "content-type": "text/plain" } });
    if (url.endsWith("/robots.txt")) return notFound();
    if (url === PORTAL_URL) return opts.portalDown ? notFound() : new Response(PORTAL_HTML, { headers: { "content-type": "text/html" } });
    if (url.includes("/sharing/rest/content/items/0123456789abcdef0123456789abcdef")) return json({ url: SERVICE });
    if (url.endsWith("/resource/z/download/wellcompletionreports.csv")) return new Response(CSV);
    if (url.startsWith(`${SERVICE}/0/query`)) {
      if (url.includes("returnCountOnly")) return json({ count: 1 });
      return json({ features: [{ attributes: { OBJECTID: 5, WCRNumber: "A1", CountyName: "Yolo" } }] });
    }
    return notFound();
  };
  return { fetchFn, urls };
}
const only = (...kinds: string[]): StateAdapter => ({ ...caAdapter, methods: caAdapter.methods!.filter((m) => kinds.includes(m.kind)) });

describe("CA collection methods", () => {
  it("declares API, browser and download methods", () => {
    expect(caAdapter.methods!.map((m) => m.kind)).toEqual(["api", "browser", "download"]);
  });

  it("discovers the moved service and CSV at run time and keeps duplicates from both", async () => {
    const { fetchFn } = caSite();
    const { exitCode, report, runDir } = await runScrape(options({ state: "CA", county: "Yolo" }), { adapter: only("api", "download"), quiet: true, fetch: fetchFn });
    expect(report.errors).toEqual([]);
    expect(report.methods.map((m) => [m.kind, m.status, m.recordsWritten])).toEqual([["api", "success", 1], ["download", "success", 2]]);
    expect(report.counts).toMatchObject({ recordsWritten: 3, duplicatesKept: 2 });
    const wells = readJson<Record<string, unknown>[]>(join(runDir, "wells.json"));
    expect(wells.map((w) => (w.extra as { collection_method: string }).collection_method)).toEqual(["api", "download", "download"]);
    expect(wells[1]).toMatchObject({ source_id: "A1", address: '1 "Main" St, Rear', total_depth_ft: 120, completion_date: "2025-01-27", well_type: "domestic" });
    expect(exitCode).toBe(1); // 2 distinct of 3 rows: the source itself repeats A1
  });

  it("works for any county without code changes", async () => {
    const { fetchFn } = caSite();
    const { report } = await runScrape(options({ state: "CA", county: "Solano" }), { adapter: only("download"), quiet: true, fetch: fetchFn });
    expect(report.counts.recordsWritten).toBe(1);
  });

  it("falls back to the last known service when discovery fails; download reports its own failure", async () => {
    const { fetchFn, urls } = caSite({ portalDown: true });
    const { report } = await runScrape(options({ state: "CA", county: "Yolo" }), { adapter: only("api", "download"), quiet: true, fetch: fetchFn });
    expect(urls.some((u) => u.startsWith(QUERY_URL))).toBe(true);
    expect(report.methods.find((m) => m.kind === "download")).toMatchObject({ status: "failed" });
  });

  it("never downloads a discovered file that robots.txt disallows", async () => {
    const { fetchFn, urls } = caSite({ robots: "User-agent: *\nDisallow: /dataset/\n" });
    const { report } = await runScrape(options({ state: "CA", county: "Yolo" }), { adapter: only("api", "download"), quiet: true, fetch: fetchFn });
    expect(urls.some((u) => u.endsWith("wellcompletionreports.csv"))).toBe(false);
    expect(report.methods.map((m) => m.status)).toEqual(["success", "failed"]);
  });

  it("browser method loads the dataset page, then the county's results from the service it lists", async () => {
    const visited: string[] = [];
    const links = [...PORTAL_HTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    const ctx = {
      signal: new AbortController().signal,
      log: { info() {}, warn() {} },
      assertRobots: async () => {},
      fetchJson: async () => ({ url: SERVICE }),
      page: { locator: () => ({ evaluateAll: async () => links }) },
      goto: async (url: string) => {
        visited.push(url);
        return { ok: () => true, status: () => 200, json: async () => (url.includes("returnCountOnly") ? { count: 1 } : { features: [{ attributes: { OBJECTID: 5, WCRNumber: "A1" } }] }) };
      },
    } as unknown as ScrapeContext;
    const events = [];
    for await (const ev of caAdapter.methods![1]!.scrape(ctx, { state: "CA", name: "Yolo County", fips: "06113" })) events.push(ev.type);
    expect(events).toEqual(["total", "record", "page"]);
    expect(visited[0]).toBe(PORTAL_URL);
    expect(visited.slice(1).every((u) => u.startsWith(`${SERVICE}/0/query`))).toBe(true);
  });
});
