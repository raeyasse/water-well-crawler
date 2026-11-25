import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { adapters, getAdapter } from "../adapters/index.ts";
import { TOOL_VERSION } from "../browser/launch.ts";
import { openSession } from "../core/session.ts";
import { runCheck } from "../core/check.ts";
import { buildScrapeOptions, loadConfigFile, type ScrapeFlags } from "../core/config.ts";
import { DEFAULT_TIMEOUTS } from "../core/context.ts";
import { AuthFailedError, InputError, WellsError } from "../core/errors.ts";
import { runScrape } from "../core/run.ts";
import { resolveStateCode, STATES } from "../core/states.ts";
import { listDays } from "../output/daily.ts";
import { startServer } from "../server/server.ts";
import { saveSession } from "../credentials/sessions.ts";
import { createLogger } from "../logging/logger.ts";

/** Exit codes (specs/03): 0 success, 1 partial, 2 failed, 3 invalid input, 4 credentials, 5 blocked. */

const program = new Command()
  .name("wells")
  .description("Collect public water well records for a US state + county from state agency websites.")
  .version(TOOL_VERSION)
  .showHelpAfterError();

program
  .command("scrape")
  .description("Collect wells for one county")
  .requiredOption("--state <s>", "USPS code or full name (NC, North Carolina)")
  .requiredOption("--county <c>", 'County name ("Wake", "wake county") or 5-digit FIPS (37183)')
  .option("--out <dir>", "base output folder (default ./output)")
  .option("--format <list>", "any of csv,json (default csv,json)")
  .option("--docs", "also download well-log documents when the adapter supports it")
  .option("--no-owner", "drop owner/person-name fields from output")
  .option("--max-records <n>", "stop after n records")
  .option("--delay <ms>", "minimum delay between navigations/requests (default 1500)")
  .option("--headed", "show the browser window")
  .option("--trace", "save a Playwright trace to the run folder")
  .option("--keep-raw", "also save raw captured responses to raw/")
  .option("--log-level <lvl>", "debug, info, warn, error (default info)")
  .option("--ignore-robots", "proceed despite robots.txt, only if the adapter documents permission")
  .addOption(new Option("--adapter <id>", "use a development adapter (fake, demo, demo-auth)").hideHelp())
  .action(async (flags: ScrapeFlags) => {
    const opts = buildScrapeOptions(flags, loadConfigFile());
    const controller = new AbortController();
    let emergency: (() => Promise<void>) | undefined;
    let sigints = 0;
    process.on("SIGINT", () => {
      sigints++;
      if (sigints === 1) {
        process.stderr.write("\nStopping after the current step… (Ctrl+C again to force)\n");
        controller.abort();
      } else {
        process.stderr.write("\nForcing exit after closing files…\n");
        void (emergency?.() ?? Promise.resolve()).finally(() => process.exit(1));
      }
    });
    const result = await runScrape(opts, { signal: controller.signal, onEmergencyClose: (fn) => (emergency = fn) });
    process.exitCode = result.exitCode;
  });

program
  .command("list-states")
  .description("Print supported states and adapter capabilities")
  .action(() => {
    const rows = Object.entries(adapters);
    if (!rows.length) {
      process.stdout.write("No state adapters are registered yet (pilot state pending — see specs/11, M3).\nDevelopment adapters: fake, demo, demo-auth (use --adapter <id>).\n");
      return;
    }
    for (const [code, a] of rows) {
      const caps = Object.entries(a.capabilities).filter(([, v]) => v).map(([k]) => k).join(", ");
      process.stdout.write(`${code}  ${a.sourceName} v${a.version}\n    ${a.sourceUrl}\n    login: ${a.requiresAuth ? "required" : "no"} · ${caps} · last verified ${a.lastVerified}\n`);
    }
  });

program
  .command("check")
  .description("Smoke-test one adapter against the live site (writes nothing to output/)")
  .requiredOption("--state <s>", "USPS code or full name")
  .option("--headed", "show the browser window")
  .addOption(new Option("--adapter <id>").hideHelp())
  .action(async (flags: { state: string; headed?: boolean; adapter?: string }) => {
    const state = requireState(flags.state);
    const adapter = getAdapter(state, flags.adapter);
    const config = loadConfigFile();
    const { log } = createLogger({ level: "info", bindings: { state, adapter: `${adapter.state}@${adapter.version}` } });
    const result = await runCheck({
      adapter,
      state,
      log,
      delay: config.delay ?? 1500,
      headed: flags.headed ?? false,
      contact: config.contact,
      timeouts: { ...DEFAULT_TIMEOUTS, ...config.timeouts },
    });
    process.stderr.write(`\n${result.pass ? "PASS" : "FAIL"}: ${adapter.sourceName} v${adapter.version} (last verified ${adapter.lastVerified})\n`);
    if (!result.pass) process.stderr.write(`Screenshots: ${result.screenshotDir}\n`);
    process.exitCode = result.exitCode;
  });

program
  .command("login")
  .description("Open a headed browser to sign in manually (e.g. MFA) and save the session")
  .requiredOption("--state <s>", "USPS code or full name")
  .addOption(new Option("--adapter <id>").hideHelp())
  .action(async (flags: { state: string; adapter?: string }) => {
    const state = requireState(flags.state);
    const adapter = getAdapter(state, flags.adapter);
    if (!adapter.requiresAuth) throw new InputError(`${adapter.sourceName} does not require login.`);
    const config = loadConfigFile();
    const { log } = createLogger({ level: "warn" });
    const session = await openSession({
      adapter,
      state,
      log,
      delay: 0,
      headed: true,
      contact: config.contact,
      timeouts: { ...DEFAULT_TIMEOUTS, ...config.timeouts },
      signal: new AbortController().signal,
      screenshotDir: mkdtempSync(join(tmpdir(), "well-scraper-login-")),
      useSavedSession: false,
    });
    try {
      await session.ctx.page.goto(adapter.sourceUrl);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      await rl.question("Sign in in the browser window (complete any MFA/CAPTCHA yourself), then press Enter here… ");
      rl.close();
      if (adapter.isLoggedIn && !(await adapter.isLoggedIn(session.ctx))) throw new AuthFailedError("Still signed out; session not saved.");
      const file = await saveSession(session.ctx.browserContext, state);
      process.stderr.write(`Session saved to ${file}\n`);
    } finally {
      await session.close();
    }
  });

program
  .command("days")
  .description("List stored records grouped by the UTC day they were collected")
  .option("--out <dir>", "base output folder (default ./output)")
  .action(async (flags: { out?: string }) => {
    const { days, skipped } = await listDays(flags.out ?? loadConfigFile().out ?? "./output");
    for (const d of days) process.stdout.write(`${d.date}  ${d.records} records, ${d.runs.length} run(s)\n`);
    for (const s of skipped) process.stderr.write(`Warning: ${s.file}: ${s.reason}\n`);
  });

program
  .command("serve")
  .description("Serve stored records as a read-only local JSON API")
  .option("--out <dir>", "base output folder (default ./output)")
  .option("--port <n>", "port on 127.0.0.1", "4600")
  .action(async (flags: { out?: string; port: string }) => {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new InputError(`--port must be 0-65535 (got "${flags.port}")`);
    const { url } = await startServer(flags.out ?? loadConfigFile().out ?? "./output", port);
    process.stderr.write(`Serving ${url}/records and ${url}/days (Ctrl+C to stop)\n`);
  });

function requireState(input: string): string {
  const state = resolveStateCode(input);
  if (!state) throw new InputError(`Unknown state "${input}". Use a USPS code or full name: ${Object.keys(STATES).join(", ")}.`);
  return state;
}

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof WellsError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(`Unexpected error: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 2;
  }
}
