import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countySlug, type County } from "../core/counties.ts";

/** "2026-10-24T19-30-05Z" — UTC, filesystem-safe. */
export function makeRunId(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export interface RunPaths {
  runId: string;
  /** output/NC/wake-37183 */
  countyDir: string;
  /** output/NC/wake-37183/<runId> */
  runDir: string;
  file(name: string): string;
  /** Path relative to the run folder, for the report. */
  rel(abs: string): string;
}

/** Create output/<STATE>/<county>-<fips>/<runId>/ (specs/07). */
export function createRunFolder(outBase: string, county: County, now = new Date()): RunPaths {
  const countyDir = join(outBase, county.state, `${countySlug(county)}-${county.fips}`);
  let runId = makeRunId(now);
  // Two runs in the same second get a numeric suffix rather than sharing a folder.
  for (let i = 2; existsSync(join(countyDir, runId)); i++) runId = `${makeRunId(now)}-${i}`;
  const runDir = join(countyDir, runId);
  mkdirSync(runDir, { recursive: true });
  return {
    runId,
    countyDir,
    runDir,
    file: (name) => join(runDir, name),
    rel: (abs) => (abs.startsWith(runDir) ? abs.slice(runDir.length + 1).replace(/\\/g, "/") : abs),
  };
}

/** Point `latest` at this run: a symlink, or latest.txt where symlinks aren't available (Windows). */
export function updateLatest(paths: RunPaths, platform = process.platform): void {
  const link = join(paths.countyDir, "latest");
  if (platform !== "win32") {
    try {
      rmSync(link, { force: true });
      symlinkSync(paths.runId, link, "dir");
      return;
    } catch {
      // Fall through to latest.txt.
    }
  }
  writeFileSync(join(paths.countyDir, "latest.txt"), `${paths.runId}\n`);
}
