import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QUERY_URL } from "../../src/adapters/ca/service.ts";
import { runScrape } from "../../src/core/run.ts";
import { options, readJson } from "../helpers.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
const strip = (wells: Record<string, unknown>[]) => wells.map(({ scraped_at: _, ...w }) => w);

describe("CA adapter — offline replay of recorded DWR responses (Alpine)", () => {
  it("reproduces the recorded run exactly", async () => {
    const recorded = readJson<Record<string, unknown>>(new URL("../fixtures/ca/alpine.responses.json", import.meta.url).pathname);
    const replay: typeof fetch = async (input) => {
      const body = recorded[String(input)];
      return body === undefined ? notFound() : json(body);
    };
    const { exitCode, report, runDir } = await runScrape(options({ state: "CA", county: "Alpine" }), { quiet: true, fetch: replay });
    expect(exitCode).toBe(0);
    expect(report.counts).toMatchObject({ siteReportedTotal: 677, recordsWritten: 675, duplicatesSkipped: 2, invalid: 0 });
    const expected = JSON.parse(readFileSync(new URL("../fixtures/ca/alpine.expected.wells.json", import.meta.url), "utf8"));
    expect(strip(readJson(join(runDir, "wells.json")))).toEqual(strip(expected));
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
    const { exitCode, report } = await runScrape(options({ state: "CA", county: "Yolo" }), { quiet: true, fetch: fetchFn });
    expect(exitCode).toBe(0);
    expect(report.counts).toMatchObject({ siteReportedTotal: 2345, recordsWritten: 2345, pagesVisited: 3 });
    expect(calls.filter((c) => c.includes("OBJECTID"))).toHaveLength(3);
  });

  it("retries an ArcGIS 500 error body", async () => {
    const { fetchFn } = fakeArcGis(10, { failFirst: { code: 500 } });
    const { exitCode, report, runDir } = await runScrape(options({ state: "CA", county: "Yolo" }), { quiet: true, fetch: fetchFn });
    expect(exitCode).toBe(0);
    expect(report.counts.recordsWritten).toBe(10);
    expect(readFileSync(join(runDir, "run-log.jsonl"), "utf8")).toContain('"event":"retry"');
  }, 30_000);

  it("reports a changed service (ArcGIS 400) as a site change", async () => {
    const { fetchFn } = fakeArcGis(10, { failFirst: { code: 400 } });
    const { exitCode, report } = await runScrape(options({ state: "CA", county: "Yolo" }), { quiet: true, fetch: fetchFn });
    expect(exitCode).toBe(2);
    expect(report.errors[0]).toMatchObject({ name: "SiteChangedError" });
    expect(report.notes.join(" ")).toMatch(/may be out of date/);
  });

  it("warns that --docs is unsupported", async () => {
    const { fetchFn } = fakeArcGis(5);
    const { report } = await runScrape(options({ state: "CA", county: "Yolo", docs: true }), { quiet: true, fetch: fetchFn });
    expect(report.warnings[0]!.msg).toMatch(/--docs ignored/);
  });
});
