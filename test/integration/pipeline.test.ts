import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runScrape } from "../../src/core/run.ts";
import type { RunReport } from "../../src/logging/report.ts";
import { options, readJson, readLines } from "../helpers.ts";

/** M1: the whole pipeline with the no-browser fake adapter. */
describe("pipeline with fake adapter", () => {
  it("writes wells.csv, wells.json, invalid.jsonl, run-log.jsonl and both reports", async () => {
    const { exitCode, runDir, report } = await runScrape(options({ adapter: "fake" }), { quiet: true });
    expect(exitCode).toBe(0);
    for (const f of ["wells.csv", "wells.json", "invalid.jsonl", "run-log.jsonl", "run-report.json", "run-report.md"]) {
      expect(existsSync(join(runDir, f)), f).toBe(true);
    }
    const wells = readJson<Record<string, unknown>[]>(join(runDir, "wells.json"));
    expect(wells).toHaveLength(249);
    expect(Object.keys(wells[0]!).slice(0, 5)).toEqual(["source_state", "county_fips", "county_name", "source_name", "source_id"]);
    expect(wells[0]).toMatchObject({ source_state: "NC", county_fips: "37183", county_name: "Wake County" });

    const csv = readFileSync(join(runDir, "wells.csv"), "utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.trim().split("\n")).toHaveLength(250);

    expect(readLines(join(runDir, "invalid.jsonl"))).toEqual([expect.objectContaining({ errors: ["missing well id"] })]);
    expect(report.counts).toMatchObject({ siteReportedTotal: 250, recordsSeen: 251, recordsWritten: 249, duplicatesSkipped: 1, invalid: 1, pagesVisited: 5 });
    expect(readJson<RunReport>(join(runDir, "run-report.json")).status).toBe("success");

    const log = readLines(join(runDir, "run-log.jsonl"));
    for (const line of log) expect(line).toMatchObject({ runId: report.runId, state: "NC", countyFips: "37183", adapter: expect.any(String) });
    expect(log.map((l) => l.event)).toEqual(expect.arrayContaining(["run.start", "county.resolved", "page.done", "record.invalid", "run.end"]));
    expect(existsSync(join(runDir, "..", "latest"))).toBe(true);
  });

  it("--no-owner drops owner_name; --format json writes only JSON", async () => {
    const { runDir, report } = await runScrape(options({ adapter: "fake", owner: false, format: "json" }), { quiet: true });
    expect(existsSync(join(runDir, "wells.csv"))).toBe(false);
    const wells = readJson<Record<string, unknown>[]>(join(runDir, "wells.json"));
    expect(wells[0]).not.toHaveProperty("owner_name");
    expect(report.fieldCoverage).not.toHaveProperty("owner_name");
  });

  it("--max-records stops early with status partial and valid JSON", async () => {
    const { exitCode, runDir, report } = await runScrape(options({ adapter: "fake", maxRecords: "10" }), { quiet: true });
    expect(exitCode).toBe(1);
    expect(report.status).toBe("partial");
    expect(readJson<unknown[]>(join(runDir, "wells.json"))).toHaveLength(10);
  });
});

describe("CLI input validation (exit 3)", () => {
  const bin = fileURLToPath(new URL("../../bin/wells.js", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

  it.each([
    [["scrape", "--state", "ZZ", "--county", "Wake"], /Unknown state "ZZ"/],
    [["scrape", "--state", "TX", "--county", "Travis"], /No adapter for TX yet/],
    [["scrape", "--state", "MD", "--county", "Baltimore", "--adapter", "fake"], /ambiguous.*24005.*24510/],
    [["scrape", "--state", "NC", "--county", "Wkae", "--adapter", "fake"], /Closest: .*Wake County/],
    [["scrape", "--state", "NC", "--county", "Wake", "--format", "xml", "--adapter", "fake"], /--format/],
    [["scrape", "--state", "NC", "--county", "Wake", "--max-records", "-1", "--adapter", "fake"], /--max-records/],
  ])("%j", (args, message) => {
    const res = run(...args);
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(message);
  });

  it("--help lists commands", () => {
    const res = run("--help");
    expect(res.status).toBe(0);
    for (const cmd of ["scrape", "list-states", "check", "login"]) expect(res.stdout).toContain(cmd);
  });
});
