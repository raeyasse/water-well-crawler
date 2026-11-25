import { createReadStream, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { parseCsv } from "../core/csv.ts";

/**
 * Read-only view of every stored run, grouped by the UTC calendar day each record was collected
 * (`scraped_at`). Nothing is moved, merged or de-duplicated, so timestamps and files stay as written.
 */

export type StoredRecord = Record<string, unknown> & { run_id: string };

export interface RecordFilter {
  /** Inclusive UTC days, YYYY-MM-DD. */
  from?: string;
  to?: string;
  state?: string;
  countyFips?: string;
}

export interface DayGroup {
  date: string;
  records: number;
  /** "<STATE>/<county>/<runId>" of each run that collected records that day. */
  runs: string[];
}

export interface SkippedInput {
  file: string;
  reason: string;
}

const subdirs = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory()) // excludes the `latest` symlink
        .map((e) => e.name)
        .sort()
    : [];

function* runDirs(out: string, filter: RecordFilter): Generator<{ dir: string; runId: string }> {
  for (const state of subdirs(out)) {
    if (filter.state && state !== filter.state) continue;
    for (const county of subdirs(join(out, state))) {
      if (filter.countyFips && !county.endsWith(`-${filter.countyFips}`)) continue;
      for (const runId of subdirs(join(out, state, county))) yield { dir: join(out, state, county, runId), runId };
    }
  }
}

/** wells.json has one record per line, so it streams and stays readable while a run is in progress. */
async function* readWellsJson(file: string, skipped: SkippedInput[]): AsyncGenerator<Record<string, unknown>> {
  let bad = 0;
  for await (const line of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
    const text = line.trim().replace(/,$/, "");
    if (text === "" || text === "[" || text === "]" || text === "[]") continue;
    try {
      yield JSON.parse(text) as Record<string, unknown>;
    } catch {
      bad++;
    }
  }
  if (bad) skipped.push({ file, reason: `${bad} unreadable line(s)` });
}

const JSON_COLUMNS = new Set(["water_levels", "water_quality", "documents", "extra"]);
const NUMBER_COLUMNS = new Set(["latitude", "longitude", "total_depth_ft", "casing_depth_ft", "casing_diameter_in", "static_water_level_ft", "yield_gpm"]);

/** Runs made with --format csv have no wells.json. */
async function* readWellsCsv(file: string): AsyncGenerator<Record<string, unknown>> {
  for await (const row of parseCsv(createReadStream(file))) {
    yield Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, JSON_COLUMNS.has(k) ? JSON.parse(v) : v === "" ? null : NUMBER_COLUMNS.has(k) ? Number(v) : v]),
    );
  }
}

/** UTC day of a record, or undefined when the timestamp is missing or malformed. */
function dayOf(record: Record<string, unknown>): string | undefined {
  const t = typeof record.scraped_at === "string" ? Date.parse(record.scraped_at) : Number.NaN;
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

async function* readAll(out: string, filter: RecordFilter, skipped: SkippedInput[]): AsyncGenerator<{ date: string; run: string; record: StoredRecord }> {
  for (const { dir, runId } of runDirs(out, filter)) {
    const json = join(dir, "wells.json");
    const csv = join(dir, "wells.csv");
    const file = existsSync(json) ? json : existsSync(csv) ? csv : undefined;
    if (!file) continue;
    const run = relative(out, dir).replace(/\\/g, "/");
    let undated = 0;
    try {
      for await (const record of file === json ? readWellsJson(json, skipped) : readWellsCsv(csv)) {
        const date = dayOf(record);
        if (!date) undated++;
        else if (!(filter.from && date < filter.from) && !(filter.to && date > filter.to)) yield { date, run, record: { ...record, run_id: runId } };
      }
    } catch (err) {
      skipped.push({ file, reason: (err as Error).message });
    }
    if (undated) skipped.push({ file, reason: `${undated} record(s) without a valid scraped_at` });
  }
}

export async function listDays(out: string, filter: RecordFilter = {}): Promise<{ days: DayGroup[]; skipped: SkippedInput[] }> {
  const skipped: SkippedInput[] = [];
  const groups = new Map<string, { records: number; runs: Set<string> }>();
  for await (const { date, run } of readAll(out, filter, skipped)) {
    const g = groups.get(date) ?? { records: 0, runs: new Set<string>() };
    g.records++;
    g.runs.add(run);
    groups.set(date, g);
  }
  const days = [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, g]) => ({ date, records: g.records, runs: [...g.runs] }));
  return { days, skipped };
}

export async function readRecords(out: string, filter: RecordFilter, limit: number, offset: number): Promise<{ total: number; records: StoredRecord[]; skipped: SkippedInput[] }> {
  const skipped: SkippedInput[] = [];
  const records: StoredRecord[] = [];
  let total = 0;
  for await (const { record } of readAll(out, filter, skipped)) {
    if (total >= offset && records.length < limit) records.push(record);
    total++;
  }
  return { total, records, skipped };
}
