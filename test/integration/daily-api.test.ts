import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runScrape } from "../../src/core/run.ts";
import { parseCsv } from "../../src/core/csv.ts";
import { listDays, readRecords } from "../../src/output/daily.ts";
import { startServer } from "../../src/server/server.ts";
import { options, tempDir } from "../helpers.ts";

let close: (() => void) | undefined;
afterEach(() => close?.());

async function scrapeAt(out: string, iso: string, flags: Parameters<typeof options>[0] = {}) {
  return runScrape(options({ adapter: "fake", maxRecords: "3", ...flags }, out), { quiet: true, now: () => new Date(iso) });
}

async function seeded() {
  const out = tempDir();
  const runs = [
    await scrapeAt(out, "2026-03-01T09:00:00.123Z"),
    await scrapeAt(out, "2026-03-01T23:59:59.999Z"),
    await scrapeAt(out, "2026-03-02T00:00:00.000Z", { county: "Orange" }),
  ];
  return { out, runs };
}

async function api(out: string) {
  const { server, url } = await startServer(out, 0);
  close = () => server.close();
  return async (path: string) => {
    const res = await fetch(url + path);
    return { status: res.status, body: await res.json() };
  };
}

describe("daily grouping", () => {
  it("groups several runs on one UTC day, keeps timestamps, and leaves files untouched", async () => {
    const { out, runs } = await seeded();
    const before = runs.map((r) => readFileSync(join(r.runDir, "wells.json"), "utf8"));
    const { days, skipped } = await listDays(out);
    expect(skipped).toEqual([]);
    expect(days.map((d) => [d.date, d.records, d.runs.length])).toEqual([["2026-03-01", 6, 2], ["2026-03-02", 3, 1]]);
    const { records } = await readRecords(out, { from: "2026-03-01", to: "2026-03-01" }, 100, 0);
    expect(new Set(records.map((r) => r.scraped_at))).toEqual(new Set(["2026-03-01T09:00:00.123Z", "2026-03-01T23:59:59.999Z"]));
    expect(runs.map((r) => readFileSync(join(r.runDir, "wells.json"), "utf8"))).toEqual(before);
  });

  it("splits a run that crosses midnight by record", async () => {
    const out = tempDir();
    let t = Date.parse("2026-03-01T23:59:59.000Z");
    await runScrape(options({ adapter: "fake", maxRecords: "4" }, out), { quiet: true, now: () => new Date((t += 400)) });
    const { days } = await listDays(out);
    expect(days.map((d) => d.date)).toEqual(["2026-03-01", "2026-03-02"]);
    expect(days.reduce((n, d) => n + d.records, 0)).toBe(4);
  });

  it("reads CSV-only runs with the same types as JSON", async () => {
    const json = tempDir();
    const csv = tempDir();
    await scrapeAt(json, "2026-03-01T09:00:00Z");
    await scrapeAt(csv, "2026-03-01T09:00:00Z", { format: "csv" });
    const read = (out: string) => readRecords(out, {}, 10, 0).then((r) => r.records);
    expect(await read(csv)).toEqual(await read(json));
  });

  it("reports unreadable lines instead of failing (run in progress)", async () => {
    const out = tempDir();
    const dir = join(out, "CA", "yolo-06113", "r1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wells.json"), '[\n{"scraped_at":"2026-03-01T00:00:00Z"},\n{"scraped');
    const { days, skipped } = await listDays(out);
    expect(days[0]!.records).toBe(1);
    expect(skipped).toHaveLength(1);
  });
});

describe("records API", () => {
  it("filters by date, range, state and county, with paging", async () => {
    const { out } = await seeded();
    const get = await api(out);
    expect((await get("/records")).body.total).toBe(9);
    expect((await get("/records?date=2026-03-01")).body.total).toBe(6);
    expect((await get("/records?from=2026-03-02")).body.total).toBe(3);
    expect((await get("/records?to=2026-03-01")).body.total).toBe(6);
    expect((await get("/records?date=2026-03-03")).body).toMatchObject({ total: 0, records: [] });
    expect((await get("/records?county=37135")).body.total).toBe(3);
    expect((await get("/records?state=CA")).body.total).toBe(0);
    const page = (await get("/records?limit=4&offset=4")).body;
    expect([page.total, page.records.length]).toEqual([9, 4]);
    expect((await get("/days")).body.days).toHaveLength(2);
  });

  it.each(["date=2026-02-30", "date=yesterday", "from=2026-03-02&to=2026-03-01", "date=2026-03-01&from=2026-03-01", "state=ZZ", "county=../x", "limit=0", "dat=2026-03-01"])("rejects %s", async (q) => {
    const get = await api(tempDir());
    expect((await get(`/records?${q}`)).status).toBe(400);
  });

  it("404s unknown paths and handles a missing output folder", async () => {
    const get = await api(join(tempDir(), "none"));
    expect((await get("/nope")).status).toBe(404);
    expect((await get("/records")).body.total).toBe(0);
  });
});

it("parseCsv handles quotes, newlines, and any chunk split", async () => {
  const bytes = new TextEncoder().encode('﻿a,b\r\n"x ""q"", y","l1\nl2"\r\né,\r\n,""');
  for (let size = 1; size <= bytes.length; size++) {
    const chunks = (async function* () {
      for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
    })();
    const rows = [];
    for await (const r of parseCsv(chunks)) rows.push(r);
    expect(rows).toEqual([{ a: 'x "q", y', b: "l1\nl2" }, { a: "é", b: "" }, { a: "", b: "" }]);
  }
});
