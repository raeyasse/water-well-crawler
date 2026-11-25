import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCredentialSet, resolveCredentials, type ResolveEnv } from "../credentials/resolve.ts";
import type { Logger } from "../logging/logger.ts";
import { WellRecordSchema } from "../schema/well.ts";
import type { StateAdapter } from "../adapters/types.ts";
import { resolveCounty } from "./counties.ts";
import type { Timeouts } from "./context.ts";
import { WellsError } from "./errors.ts";
import { checkRobots } from "./robots.ts";
import { authenticate, openSession, type Session } from "./session.ts";
import { buildUserAgent } from "../browser/launch.ts";

export interface CheckStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CheckResult {
  pass: boolean;
  exitCode: number;
  steps: CheckStep[];
  screenshotDir: string;
}

export interface CheckOptions {
  adapter: StateAdapter;
  state: string;
  log: Logger;
  delay: number;
  headed: boolean;
  contact?: string;
  timeouts: Timeouts;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sessionEnv?: ResolveEnv;
  fetch?: typeof fetch;
}

/**
 * `wells check`: open the site, confirm key pages/selectors work, fetch one page of results
 * for the adapter's sample county. Writes nothing to output/ (screenshots go to a temp dir).
 */
export async function runCheck(opts: CheckOptions): Promise<CheckResult> {
  const { adapter, state, log } = opts;
  const steps: CheckStep[] = [];
  const screenshotDir = mkdtempSync(join(tmpdir(), "well-scraper-check-"));
  const step = (name: string, ok: boolean, detail: string): void => {
    steps.push({ name, ok, detail });
    log[ok ? "info" : "error"]({ event: "check.step", step: name, ok, detail }, `${ok ? "✓" : "✗"} ${name}: ${detail}`);
  };

  let session: Session | undefined;
  let exitCode = 0;
  try {
    const county = resolveCounty(state, adapter.sampleCounty);
    step("sample county", true, `${county.name} (${county.fips})`);

    const credentials = adapter.requiresAuth
      ? resolveCredentials(state, adapter.credentialKeys ?? [], { env: opts.env, cwd: opts.cwd, ...opts.sessionEnv })
      : makeCredentialSet();

    const robotsPaths = adapter.robotsPaths ?? [new URL(adapter.sourceUrl).pathname || "/"];
    if (robotsPaths.length) {
      const robots = await checkRobots(adapter.sourceUrl, robotsPaths, buildUserAgent("Mozilla/5.0", opts.contact), opts.fetch);
      step("robots.txt", robots.allowed, robots.unavailable ? `not available (${robots.unavailable}); treated as allowed` : robots.allowed ? "allowed" : `disallows ${robots.disallowedPaths.join(", ")}`);
      if (!robots.allowed) return { pass: false, exitCode: 5, steps, screenshotDir };
    }

    const controller = new AbortController();
    session = await openSession({
      adapter,
      state,
      log,
      credentials,
      delay: opts.delay,
      headed: opts.headed,
      contact: opts.contact,
      timeouts: opts.timeouts,
      signal: controller.signal,
      screenshotDir,
      sessionEnv: opts.sessionEnv,
      fetch: opts.fetch,
    });
    if (adapter.requiresAuth) step("login", true, await authenticate(adapter, session, state, log, opts.sessionEnv));

    let total: number | undefined;
    let records = 0;
    let valid = 0;
    let gotPage = false;
    for await (const ev of adapter.scrape(session.ctx, county)) {
      if (ev.type === "total") total = ev.count;
      if (ev.type === "warning") step("warning", true, ev.message);
      if (ev.type === "record") {
        records++;
        try {
          const n = adapter.normalize(ev.raw, county);
          const full = n && { ...n, source_state: state, county_fips: county.fips, county_name: county.name, source_name: adapter.sourceName, scraped_at: new Date().toISOString(), adapter_version: adapter.version };
          if (full && WellRecordSchema.safeParse(full).success) valid++;
        } catch {
          // counted as invalid
        }
      }
      if (ev.type === "page") {
        gotPage = true;
        break;
      }
    }
    step("site total", total !== undefined, total !== undefined ? `${total} wells reported` : "site did not report a total");
    const ok = (gotPage || total === 0) && (records === 0 ? total === 0 : valid > 0);
    step("first page", ok, `${records} records, ${valid} valid after normalization`);
    if (!ok) exitCode = 2;
  } catch (err) {
    const e = err as Error;
    step("error", false, `${e.name}: ${e.message}`);
    await session?.ctx.screenshot("check-error").catch(() => undefined);
    exitCode = err instanceof WellsError ? err.exitCode : 2;
  } finally {
    await session?.close();
  }
  return { pass: exitCode === 0 && steps.every((s) => s.ok || s.name === "site total"), exitCode, steps, screenshotDir };
}
