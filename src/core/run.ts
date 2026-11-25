import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { platform, release } from "node:os";
import type { BrowserSession } from "../browser/launch.ts";
import { TOOL_NAME, TOOL_VERSION, buildUserAgent, playwrightVersion } from "../browser/launch.ts";
import { detectBlock } from "../browser/helpers.ts";
import { describeCredentials, makeCredentialSet, resolveCredentials, type CredentialSet, type ResolveEnv } from "../credentials/resolve.ts";
import { createLogger } from "../logging/logger.ts";
import {
  FieldCoverage,
  WarningTally,
  completenessPercent,
  computeStatus,
  headline,
  writeReport,
  type ReportError,
  type RunCounts,
  type RunReport,
} from "../logging/report.ts";
import { createRunFolder, updateLatest } from "../output/paths.ts";
import { JsonLinesWriter, WellWriter } from "../output/writer.ts";
import { inBounds } from "../schema/units.ts";
import { META_FIELDS, PERSON_FIELDS, WELL_FIELDS, WellRecordSchema, type WellRecord } from "../schema/well.ts";
import type { DocumentRef, RawRecord, StateAdapter } from "../adapters/types.ts";
import { getAdapter } from "../adapters/index.ts";
import type { ScrapeOptions } from "./config.ts";
import { resolveCounty, type County } from "./counties.ts";
import type { ScrapeContext } from "./context.ts";
import { BlockedError, InputError, SiteChangedError, WellsError } from "./errors.ts";
import { checkRobots } from "./robots.ts";
import { authenticate, logRetry, openSession, type Session } from "./session.ts";
import { retry } from "./retry.ts";
import { resolveStateCode, STATES } from "./states.ts";

export interface RunDeps {
  /** Use this adapter instead of the registry (tests). */
  adapter?: StateAdapter;
  /** Aborts the run like Ctrl+C. */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  sessionEnv?: ResolveEnv;
  fetch?: typeof fetch;
  /** Disable console logging (tests). */
  quiet?: boolean;
  /** Called with a function that closes files and writes the report immediately (second Ctrl+C). */
  onEmergencyClose?: (fn: () => Promise<void>) => void;
  now?: () => Date;
  /** Record or replay the browser traffic as a HAR (fixture tests). */
  recordHar?: string;
  replayHar?: string;
}

export interface RunResult {
  exitCode: number;
  report: RunReport;
  runDir: string;
}

/** Resolve state, adapter and county; throws InputError (exit 3) with a helpful message. */
export function resolveTarget(stateInput: string, countyInput: string, adapterOverride?: string, injected?: StateAdapter): { state: string; adapter: StateAdapter; county: County } {
  const state = resolveStateCode(stateInput);
  if (!state) throw new InputError(`Unknown state "${stateInput}". Use a USPS code or full name: ${Object.keys(STATES).join(", ")}.`);
  const adapter = injected ?? getAdapter(state, adapterOverride);
  const county = resolveCounty(state, countyInput);
  return { state, adapter, county };
}

/** One execution of `wells scrape` (specs/02 run flow). Always writes the log and report. */
export async function runScrape(opts: ScrapeOptions, deps: RunDeps = {}): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const { state, adapter, county } = resolveTarget(opts.state, opts.county, opts.adapter, deps.adapter);

  const paths = createRunFolder(opts.out, county, startedAt);
  const { log, secrets, flush } = createLogger({
    level: opts.logLevel,
    file: paths.file("run-log.jsonl"),
    console: !deps.quiet,
    bindings: { runId: paths.runId, state, countyFips: county.fips, adapter: `${adapter.state}@${adapter.version}` },
  });

  log.info(
    {
      event: "run.start",
      args: { ...opts, timeouts: undefined },
      tool: `${TOOL_NAME} ${TOOL_VERSION}`,
      adapterVersion: adapter.version,
      node: process.version,
      playwright: playwrightVersion(),
      os: `${platform()} ${release()}`,
    },
    `Run ${paths.runId} → ${paths.runDir}`,
  );
  log.info({ event: "county.resolved", input: opts.county, county: county.name, fips: county.fips }, `County: ${county.name}, ${state} (FIPS ${county.fips})`);

  const controller = new AbortController();
  let interrupted = false;
  let maxRecordsHit = false;
  deps.signal?.addEventListener("abort", () => {
    interrupted = true;
    log.warn({ event: "run.interrupted" }, "Interrupted — finishing current step, then writing outputs");
    controller.abort("interrupted");
  });

  const counts: RunCounts = {
    siteReportedTotal: null,
    pagesVisited: 0,
    recordsSeen: 0,
    recordsWritten: 0,
    duplicatesSkipped: 0,
    invalid: 0,
    documentsDownloaded: 0,
    documentsFailed: 0,
  };
  const warnings = new WarningTally();
  const errors: ReportError[] = [];
  const notes: string[] = [];
  let credentials: CredentialSet = makeCredentialSet();
  let fatal: WellsError | Error | undefined;
  let currentPage = 0;

  const omitFields = opts.owner ? [] : PERSON_FIELDS;
  const writer = new WellWriter({ formats: opts.formats, file: paths.file, omitFields });
  const invalidWriter = new JsonLinesWriter(paths.file("invalid.jsonl"));
  const coverage = new FieldCoverage(WELL_FIELDS.filter((f) => !META_FIELDS.includes(f) && !omitFields.includes(f)));
  const seenIds = new Set<string>();
  let session: Session | undefined;
  let rawCount = 0;

  const warn = (msg: string, data?: Record<string, unknown>): void => {
    warnings.add(msg);
    log.warn({ event: "warning", ...data }, msg);
  };

  const rejectRecord = (raw: RawRecord, errs: string[]): void => {
    counts.invalid++;
    invalidWriter.write({ raw, errors: errs });
    log.warn({ event: "record.invalid", source_id: raw._sourceId ?? null, errors: errs }, "record.invalid");
  };

  // --- finalize: always runs exactly once (normal end, error, or second Ctrl+C) ---
  let finalizing: Promise<RunResult> | undefined;
  const finalize = (closeBrowser: boolean): Promise<RunResult> =>
    (finalizing ??= (async () => {
      if (closeBrowser) await stopAndClose(session, opts.trace ? paths.file("trace.zip") : undefined);
      await Promise.all([writer.close(), invalidWriter.close()]);

      const fatalInfo = fatal ? { exitCode: fatal instanceof WellsError ? fatal.exitCode : 2, blocked: fatal instanceof BlockedError } : undefined;
      const { status, exitCode } = computeStatus({ counts, errorCount: errors.length, fatal: fatalInfo, aborted: interrupted, maxRecordsHit });
      if (maxRecordsHit) notes.push(`Stopped after --max-records ${opts.maxRecords}.`);
      if (interrupted) notes.push("Run was interrupted (Ctrl+C); outputs contain records collected so far.");
      const pct = completenessPercent(counts.siteReportedTotal, counts.recordsWritten);
      if (pct !== null && pct < 99 && !maxRecordsHit && !interrupted && status !== "blocked") {
        notes.push(`Collected ${counts.recordsWritten} of ${counts.siteReportedTotal} records the site reported (${pct}%). Gap: ${counts.duplicatesSkipped} duplicates skipped, ${counts.invalid} invalid, remainder not returned by the site or lost to page errors.`);
      }

      const endedAt = now();
      const outputs = [...writer.files, "invalid.jsonl", "run-log.jsonl", "run-report.json", "run-report.md"];
      if (rawCount) outputs.push("raw/");
      if (counts.documentsDownloaded) outputs.push("documents/");
      if (errors.some((e) => e.screenshot)) outputs.push("screenshots/");
      if (opts.trace && session?.browser) outputs.push("trace.zip");

      const report: RunReport = {
        runId: paths.runId,
        status,
        exitCode,
        input: { state: opts.state, county: opts.county },
        resolved: { state, county: county.name, fips: county.fips },
        adapter: { name: adapter.sourceName, version: adapter.version, lastVerified: adapter.lastVerified, sourceUrl: adapter.sourceUrl },
        timing: { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), durationSec: Math.round((endedAt.getTime() - startedAt.getTime()) / 100) / 10 },
        counts,
        completeness: { expected: counts.siteReportedTotal, collected: counts.recordsWritten, percent: pct },
        fieldCoverage: coverage.result(),
        warnings: warnings.list(),
        errors,
        notes,
        credentialsUsed: describeCredentials(credentials),
        outputs,
        environment: { tool: `${TOOL_NAME} ${TOOL_VERSION}`, node: process.version, playwright: playwrightVersion(), os: `${platform()} ${release()}` },
      };
      writeReport(report, paths.file);
      updateLatest(paths);
      log.info({ event: "run.end", status, exitCode, counts, durationSec: report.timing.durationSec }, `run.end: ${status}`);
      flush();
      if (!deps.quiet) process.stderr.write(`\n${headline(report).join("\n")}\nReport: ${paths.file("run-report.md")}\n`);
      return { exitCode, report, runDir: paths.runDir };
    })());

  deps.onEmergencyClose?.(async () => {
    await finalize(false);
  });

  try {
    // Credentials are resolved before the browser launches; missing keys exit 4.
    if (adapter.requiresAuth) {
      credentials = resolveCredentials(state, adapter.credentialKeys ?? [], { env: deps.env, cwd: deps.cwd, ...deps.sessionEnv });
      for (const v of Object.values(credentials.values)) secrets.add(v);
      log.info({ event: "credentials.resolved", credentialsUsed: describeCredentials(credentials) }, "credentials.resolved");
    }

    if (opts.docs && !(adapter.capabilities.documents && adapter.documents)) {
      warn(`--docs ignored: ${adapter.sourceName} does not support document downloads`);
    }

    const robotsPaths = adapter.robotsPaths ?? [new URL(adapter.sourceUrl).pathname || "/"];
    if (robotsPaths.length) {
      const robots = await checkRobots(adapter.sourceUrl, robotsPaths, buildUserAgent("Mozilla/5.0", opts.contact), deps.fetch);
      log.info({ event: "robots.checked", url: robots.url, allowed: robots.allowed, disallowed: robots.disallowedPaths, unavailable: robots.unavailable }, `robots.txt: ${robots.allowed ? "allowed" : "disallowed"}`);
      if (!robots.allowed) {
        if (opts.ignoreRobots && adapter.robotsPermission) {
          log.warn({ event: "robots.ignored", permission: adapter.robotsPermission }, `Proceeding despite robots.txt: ${adapter.robotsPermission}`);
          notes.push(`robots.txt disallows ${robots.disallowedPaths.join(", ")}; proceeded with --ignore-robots (${adapter.robotsPermission}).`);
        } else {
          const hint = opts.ignoreRobots ? " (--ignore-robots ignored: the adapter README documents no permission)" : "";
          throw new BlockedError(`robots.txt disallows ${robots.disallowedPaths.join(", ")}${hint}`);
        }
      }
    }

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
      maxRecords: opts.maxRecords,
      docs: opts.docs,
      screenshotDir: paths.file("screenshots"),
      relPath: paths.rel,
      sessionEnv: deps.sessionEnv,
      recordHar: deps.recordHar,
      replayHar: deps.replayHar,
      fetch: deps.fetch,
      onBody: opts.keepRaw
        ? (res) => {
            mkdirSync(paths.file("raw"), { recursive: true });
            writeFileSync(paths.file(join("raw", `${String(++rawCount).padStart(4, "0")}.json`)), JSON.stringify({ url: res.url, status: res.status, body: res.body }, null, 2));
          }
        : undefined,
    });
    const ctx = session.ctx;

    // Tracing stays off during login (traces capture typed input) and starts after.
    if (adapter.requiresAuth) await authenticate(adapter, session, state, log, deps.sessionEnv);
    if (opts.trace && session.browser) await session.browser.context.tracing.start({ screenshots: true, snapshots: true });

    let recordsSincePage = 0;
    for await (const ev of adapter.scrape(ctx, county)) {
      if (ev.type === "total") {
        counts.siteReportedTotal = ev.count;
        log.info({ event: "site.total", count: ev.count }, `Site reports ${ev.count} wells`);
      } else if (ev.type === "page") {
        currentPage = ev.index;
        counts.pagesVisited++;
        log.info(
          { event: "page.done", index: ev.index, of: ev.of, recordsOnPage: recordsSincePage, total: counts.recordsWritten },
          `page ${ev.index}${ev.of ? `/${ev.of}` : ""} · ${counts.recordsWritten} wells`,
        );
        recordsSincePage = 0;
      } else if (ev.type === "warning") {
        warn(ev.message, ev.data === undefined ? undefined : { data: ev.data });
      } else {
        recordsSincePage++;
        await processRecord(ev.raw);
      }
      if (controller.signal.aborted) break;
    }
  } catch (err) {
    fatal = await classifyError(err, session);
    const shot = (fatal as BlockedError | SiteChangedError).screenshot ?? (await session?.ctx.screenshot(`error-page-${currentPage}`).catch(() => undefined));
    errors.push({ name: fatal.name, msg: fatal.message, page: currentPage || undefined, screenshot: shot });
    if (fatal instanceof BlockedError) {
      log.error({ event: "blocked", reason: fatal.message, screenshot: shot }, `Blocked: ${fatal.message}`);
    } else {
      log.error({ event: "error", name: fatal.name, message: fatal.message, stack: fatal.stack, screenshot: shot }, `${fatal.name}: ${fatal.message}`);
    }
    if (fatal instanceof SiteChangedError) {
      notes.push(`Adapter ${adapter.state} v${adapter.version} (last verified ${adapter.lastVerified}) may be out of date. Run \`wells check --state ${state}\`.`);
    }
  }
  return finalize(true);

  async function processRecord(raw: RawRecord): Promise<void> {
    counts.recordsSeen++;
    let normalized: ReturnType<StateAdapter["normalize"]>;
    try {
      normalized = adapter.normalize(raw, county);
    } catch (err) {
      rejectRecord(raw, [(err as Error).message]);
      return;
    }
    if (!normalized) {
      rejectRecord(raw, ["rejected by adapter normalize()"]);
      return;
    }
    const record: WellRecord = {
      ...normalized,
      source_state: state,
      county_fips: county.fips,
      county_name: county.name,
      source_name: adapter.sourceName,
      scraped_at: now().toISOString(),
      adapter_version: adapter.version,
    };

    if (adapter.bounds && record.latitude !== null && record.longitude !== null && !inBounds(record.latitude, record.longitude, adapter.bounds)) {
      record.extra = { ...record.extra, original_latitude: record.latitude, original_longitude: record.longitude };
      record.latitude = null;
      record.longitude = null;
      warn(`Coordinates outside ${state} bounding box set to null`, { source_id: record.source_id });
    }

    const parsed = WellRecordSchema.safeParse(record);
    if (!parsed.success) {
      rejectRecord(raw, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
      return;
    }
    // zod's output follows schema key order, so written files have a stable field order.
    const well = parsed.data;
    if (seenIds.has(well.source_id)) {
      counts.duplicatesSkipped++;
      log.debug({ event: "record.duplicate", source_id: well.source_id }, "record.duplicate");
      return;
    }
    seenIds.add(well.source_id);

    if (opts.docs && adapter.capabilities.documents && adapter.documents && session) {
      const docs = await downloadDocuments(session.ctx, adapter.documents(raw), well.source_id);
      well.documents = [...well.documents.filter((d) => !docs.some((x) => x.url === d.url)), ...docs];
    }

    writer.write(well);
    coverage.add(writer.project(well));
    counts.recordsWritten++;
    if (opts.maxRecords && counts.recordsWritten >= opts.maxRecords && !controller.signal.aborted) {
      maxRecordsHit = true;
      log.info({ event: "max-records", max: opts.maxRecords }, `Reached --max-records ${opts.maxRecords}`);
      controller.abort("max-records");
    }
  }

  async function downloadDocuments(ctx: ScrapeContext, refs: DocumentRef[], sourceId: string): Promise<WellRecord["documents"]> {
    const out: WellRecord["documents"] = [];
    const dir = paths.file(join("documents", sourceId.replace(/[^a-z0-9._-]+/gi, "_")));
    for (const ref of refs) {
      if (controller.signal.aborted) break;
      const filename = (ref.filename ?? (basename(new URL(ref.url).pathname) || "document")).replace(/[^a-z0-9._-]+/gi, "_");
      try {
        await ctx.politeWait();
        const res = await retry(() => ctx.browserContext.request.get(ref.url, { timeout: opts.timeouts.navigationMs }), {
          signal: controller.signal,
          onRetry: logRetry(log, `document ${ref.url}`),
        });
        if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
        mkdirSync(dir, { recursive: true });
        const dest = join(dir, filename);
        writeFileSync(dest, await res.body());
        counts.documentsDownloaded++;
        out.push({ url: ref.url, type: ref.type, local_path: paths.rel(dest) });
      } catch (err) {
        counts.documentsFailed++;
        warn("Document download failed", { url: ref.url, error: (err as Error).message });
        out.push({ url: ref.url, type: ref.type });
      }
    }
    return out;
  }
}

/** A SiteChangedError on a page that is actually a CAPTCHA/challenge is reported as blocked. */
async function classifyError(err: unknown, session: Session | undefined): Promise<Error> {
  const e = err instanceof Error ? err : new Error(String(err));
  if (!(e instanceof BlockedError) && session?.browser) {
    const reason = await detectBlock(session.browser.page).catch(() => null);
    if (reason) {
      const blocked = new BlockedError(reason, { cause: e });
      blocked.screenshot = await session.ctx.screenshot("blocked").catch(() => undefined);
      return blocked;
    }
  }
  return e;
}

async function stopAndClose(session: Session | undefined, tracePath: string | undefined): Promise<void> {
  const browser: BrowserSession | undefined = session?.browser;
  if (!browser) return;
  if (tracePath) await browser.context.tracing.stop({ path: tracePath }).catch(() => undefined);
  await session!.close();
}
