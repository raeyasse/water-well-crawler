import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeDemoAdapter } from "../../src/adapters/demo/index.ts";
import type { StateAdapter } from "../../src/adapters/types.ts";
import { runCheck } from "../../src/core/check.ts";
import { runScrape } from "../../src/core/run.ts";
import { createLogger } from "../../src/logging/logger.ts";
import { startFakeSpa, type FakeSpa, type FakeSpaOptions } from "../fake-spa/server.ts";
import { isolatedEnv, options, readJson, readLines, tempDir } from "../helpers.ts";

/** Core integration tests against the local fake SPA (specs/10, layer 3) with a real Chromium. */

let spa: FakeSpa | undefined;
afterEach(async () => {
  await spa?.close();
  spa = undefined;
});

async function serve(opts: FakeSpaOptions = {}, auth = false): Promise<StateAdapter> {
  spa = await startFakeSpa(opts);
  return makeDemoAdapter({ auth, baseUrl: spa.url });
}

describe("capture-first scraping", () => {
  it("collects every page from JSON responses, normalizes and reports", async () => {
    const adapter = await serve();
    const { exitCode, report, runDir } = await runScrape(options(), { adapter, quiet: true });
    expect(exitCode).toBe(0);
    expect(report.counts).toMatchObject({ siteReportedTotal: 137, pagesVisited: 6, recordsWritten: 141, duplicatesSkipped: 0, duplicatesKept: 5, invalid: 1 });
    expect(report.completeness.percent).toBe(99.27);
    expect(report.warnings).toEqual([{ msg: "Coordinates outside NC bounding box set to null", count: 1 }]);

    const wells = readJson<Record<string, unknown>[]>(join(runDir, "wells.json"));
    expect(wells.slice(0, 2)).toMatchObject([
      { source_id: "37183-0001", well_type: "domestic", well_status: "active", total_depth_ft: 131, completion_date: "1986-02-02", source_url: `${spa!.url}/well/37183-0001` },
      { source_id: "37183-0002", well_type: "irrigation" },
    ]);
    const oob = wells.find((w) => w.source_id === "37183-0021")!;
    expect(oob).toMatchObject({ latitude: null, longitude: null, extra: { original_latitude: 0 } });
    expect(existsSync(join(runDir, "water_levels.csv"))).toBe(true);
    expect(report.fieldCoverage.latitude).toBeGreaterThan(0.99);

    const events = readLines(join(runDir, "run-log.jsonl")).map((l) => l.event);
    expect(events).toEqual(expect.arrayContaining(["robots.checked", "terms.accepted", "site.total", "page.done", "run.end"]));
  });

  it("falls back to DOM parsing when the site loads no JSON", async () => {
    const adapter = await serve({ domOnly: true });
    const { exitCode, report, runDir } = await runScrape(options(), { adapter, quiet: true });
    expect(exitCode).toBe(0);
    expect(report.counts).toMatchObject({ siteReportedTotal: 137, pagesVisited: 6, recordsWritten: 141, invalid: 1 });
    expect(readLines(join(runDir, "run-log.jsonl")).some((l) => l.event === "strategy" && l.mode === "dom")).toBe(true);
    const wells = readJson<Record<string, unknown>[]>(join(runDir, "wells.json"));
    expect(wells[8]).toMatchObject({ source_id: "37183-0009", total_depth_ft: 127.95 });
  });

  it("handles an empty county", async () => {
    const adapter = await serve();
    const { exitCode, report } = await runScrape(options({ county: "Durham" }), { adapter, quiet: true });
    expect(exitCode).toBe(0);
    expect(report.counts).toMatchObject({ siteReportedTotal: 0, recordsWritten: 0 });
  });
});

describe("resilience", () => {
  it("retries a 503 page via the site's Retry button", async () => {
    const adapter = await serve({ flaky503Page: 3 });
    const { exitCode, report, runDir } = await runScrape(options(), { adapter, quiet: true });
    expect(spa!.stats.failed503).toBe(1);
    expect(exitCode).toBe(0);
    expect(report.counts.recordsWritten).toBe(141);
    expect(readLines(join(runDir, "run-log.jsonl")).some((l) => l.event === "retry")).toBe(true);
  });

  it("stops with exit 5 on a CAPTCHA, with a screenshot", async () => {
    const adapter = await serve({ captcha: true });
    const { exitCode, report, runDir } = await runScrape(options(), { adapter, quiet: true });
    expect(exitCode).toBe(5);
    expect(report.status).toBe("blocked");
    expect(report.errors[0]!.screenshot).toBeDefined();
    expect(existsSync(join(runDir, report.errors[0]!.screenshot!))).toBe(true);
  });

  it("stops with exit 5 when robots.txt disallows the site", async () => {
    const adapter = await serve({ robotsDisallow: true });
    const { exitCode, report } = await runScrape(options(), { adapter, quiet: true });
    expect(exitCode).toBe(5);
    expect(report.errors[0]!.msg).toMatch(/robots\.txt disallows/);
    expect(spa!.stats.wellRequests).toBe(0);
  });

  it("Ctrl+C mid-run leaves partial outputs and a report", async () => {
    const demo = await serve();
    const controller = new AbortController();
    const adapter: StateAdapter = {
      ...demo,
      async *scrape(ctx, county) {
        let pages = 0;
        for await (const ev of demo.scrape(ctx, county)) {
          yield ev;
          if (ev.type === "page" && ++pages === 2) controller.abort();
        }
      },
    };
    const { exitCode, report, runDir } = await runScrape(options(), { adapter, quiet: true, signal: controller.signal });
    expect(exitCode).toBe(1);
    expect(report.status).toBe("partial");
    expect(report.notes.join(" ")).toMatch(/interrupted/);
    expect(readJson<unknown[]>(join(runDir, "wells.json"))).toHaveLength(50);
    expect(existsSync(join(runDir, "run-report.md"))).toBe(true);
  });

  it("--max-records stops the browser run cleanly", async () => {
    const adapter = await serve();
    const { exitCode, report } = await runScrape(options({ maxRecords: "30" }), { adapter, quiet: true });
    expect(exitCode).toBe(1);
    expect(report.counts.recordsWritten).toBe(30);
    expect(report.counts.pagesVisited).toBeLessThanOrEqual(2);
  });

  it("--docs downloads well logs into documents/<source_id>/", async () => {
    const adapter = await serve();
    const { report, runDir } = await runScrape(options({ docs: true, maxRecords: "25" }), { adapter, quiet: true });
    expect(report.counts.documentsDownloaded).toBe(2);
    expect(readFileSync(join(runDir, "documents", "37183-0010", "37183-0010.pdf"), "utf8")).toMatch(/^%PDF/);
    const wells = readJson<{ source_id: string; documents: unknown[] }[]>(join(runDir, "wells.json"));
    expect(wells.find((w) => w.source_id === "37183-0010")!.documents).toEqual([
      { url: `${spa!.url}/docs/37183-0010.pdf`, type: "well_log", local_path: "documents/37183-0010/37183-0010.pdf" },
    ]);
  });
});

describe("credentials and sessions", () => {
  it("exits 4 before launching a browser when credentials are missing", async () => {
    const adapter = await serve({ requireAuth: true }, true);
    const { env, sessionEnv } = isolatedEnv();
    const { exitCode, report } = await runScrape(options(), { adapter, quiet: true, env, sessionEnv, cwd: tempDir() });
    expect(exitCode).toBe(4);
    expect(report.errors[0]!.msg).toMatch(/WELLS_NC_USERNAME, WELLS_NC_PASSWORD/);
    expect(spa!.stats.wellRequests).toBe(0);
  });

  it("exits 4 when the login is rejected, without retrying", async () => {
    const adapter = await serve({ requireAuth: true }, true);
    const { sessionEnv } = isolatedEnv({ WELLS_NC_USERNAME: "demo", WELLS_NC_PASSWORD: "wrong-password" });
    const { exitCode, report } = await runScrape(options(), { adapter, quiet: true, sessionEnv, cwd: tempDir() });
    expect(exitCode).toBe(4);
    expect(report.errors[0]!.name).toBe("AuthFailedError");
  });

  it("logs in, saves the session, reuses it next run, and never logs the password", async () => {
    const adapter = await serve({ requireAuth: true }, true);
    const { home, sessionEnv } = isolatedEnv({ WELLS_NC_USERNAME: "demo", WELLS_NC_PASSWORD: "s3cret-pass" });
    const cwd = tempDir();

    const first = await runScrape(options({ county: "Orange" }), { adapter, quiet: true, sessionEnv, cwd });
    expect(first.exitCode).toBe(0);
    expect(first.report.credentialsUsed).toEqual(["WELLS_NC_USERNAME (environment variable)", "WELLS_NC_PASSWORD (environment variable)"]);
    expect(spa!.stats.logins).toBe(1);
    expect(readdirSync(join(home, ".config", "well-scraper", "sessions"))).toEqual(["nc.json"]);

    const second = await runScrape(options({ county: "Orange" }), { adapter, quiet: true, sessionEnv, cwd });
    expect(second.exitCode).toBe(0);
    expect(spa!.stats.logins).toBe(1);
    const log = readFileSync(join(second.runDir, "run-log.jsonl"), "utf8");
    expect(log).toContain("session.reused");

    for (const run of [first, second]) {
      for (const f of ["run-log.jsonl", "run-report.json", "run-report.md"]) {
        expect(readFileSync(join(run.runDir, f), "utf8")).not.toContain("s3cret-pass");
      }
    }
  });
});

describe("fixtures and check", () => {
  it("records a HAR and replays it offline with the same results", async () => {
    const adapter = await serve();
    const har = join(tempDir(), "orange.har");
    const live = await runScrape(options({ county: "Orange" }), { adapter, quiet: true, recordHar: har });
    await spa!.close();
    spa = undefined;

    const replay = await runScrape(options({ county: "Orange" }), { adapter, quiet: true, replayHar: har });
    expect(replay.exitCode).toBe(0);
    expect(replay.report.counts.recordsWritten).toBe(live.report.counts.recordsWritten);
    const strip = (f: string) => readJson<Record<string, unknown>[]>(f).map(({ scraped_at: _, ...w }) => w);
    expect(strip(join(replay.runDir, "wells.json"))).toEqual(strip(join(live.runDir, "wells.json")));
  });

  it("wells check passes against a working site and fails on a CAPTCHA", async () => {
    const { log } = createLogger({ console: false });
    let adapter = await serve();
    const timeouts = { navigationMs: 15_000, resultsMs: 5_000, actionMs: 5_000 };
    const ok = await runCheck({ adapter, state: "NC", log, delay: 0, headed: false, timeouts });
    expect(ok.pass).toBe(true);
    expect(ok.steps.find((s) => s.name === "first page")!.detail).toMatch(/^2[56] records/);
    await spa!.close();

    adapter = await serve({ captcha: true });
    const bad = await runCheck({ adapter, state: "NC", log, delay: 0, headed: false, timeouts });
    expect(bad.pass).toBe(false);
    expect(bad.exitCode).toBe(5);
  });
});
