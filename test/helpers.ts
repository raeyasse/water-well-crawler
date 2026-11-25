import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildScrapeOptions, type ScrapeFlags, type ScrapeOptions } from "../src/core/config.ts";

export function tempDir(prefix = "wells-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Isolated user config dir (credentials + sessions) for one test. */
export function isolatedEnv(extra: Record<string, string> = {}) {
  const home = tempDir("wells-home-");
  const env = { XDG_CONFIG_HOME: join(home, ".config"), APPDATA: join(home, "AppData"), ...extra };
  return { env, home, sessionEnv: { env, home } };
}

export function options(flags: Partial<ScrapeFlags> = {}, out = tempDir()): ScrapeOptions {
  const opts = buildScrapeOptions({ state: "NC", county: "Wake", delay: "0", out, ...flags });
  return { ...opts, timeouts: { navigationMs: 15_000, resultsMs: 5_000, actionMs: 5_000 } };
}

export const readJson = <T = unknown>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
export const readLines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
