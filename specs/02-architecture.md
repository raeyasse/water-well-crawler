# 02 — Architecture

## Tech stack

| Concern | Choice | Why |
|---------|--------|-----|
| Runtime | Node.js 22 LTS | Required by the brief; current LTS |
| Language | TypeScript (strict) | Adapters are many and similar; types keep them consistent |
| Browser automation | **Playwright** (Chromium) | Handles SPAs, waits automatically, can intercept network responses, saves login sessions, records traces. Preferred over Selenium for speed and API quality. |
| CLI | `commander` | Small, standard |
| Validation | `zod` | Validates normalized records and config |
| Logging | `pino` (+ `pino-pretty` for console) | Fast JSON-lines logging |
| CSV | `csv-stringify` | Streaming CSV writer |
| Env files | `dotenv` | Local credential lookup (see 06) |
| Tests | `vitest` + Playwright HAR replay | See 10 |

No other runtime dependencies without a reason recorded in the PR.

## Module map

```
src/
  cli/              # command definitions, argument parsing, exit codes
  core/
    run.ts          # orchestrates one run (see flow below)
    context.ts      # ScrapeContext passed to adapters
    counties.ts     # state/county name -> FIPS resolution
    rate-limit.ts   # politeness delay / concurrency guard
    retry.ts        # retry with backoff
  browser/
    launch.ts       # Playwright launch, context, storageState
    capture.ts      # network-response capture helpers
    helpers.ts      # waitForResults, paginate, safeClick, screenshot
  credentials/
    resolve.ts      # local credential lookup chain
  output/
    writer.ts       # streaming CSV/JSON writers
    paths.ts        # run folder layout
  logging/
    logger.ts       # pino setup, secret redaction
    report.ts       # builds run-report.md / run-report.json
  schema/
    well.ts         # zod WellRecord schema
    units.ts        # unit conversion helpers
  adapters/
    index.ts        # registry: state code -> adapter
    _template/      # copy to start a new state
    nc/             # example: one folder per state
      index.ts
      normalize.ts
      selectors.ts
      README.md     # source URL, quirks, last verified date
data/
  counties.csv      # Census county FIPS reference (bundled)
test/
  fixtures/<state>/ # recorded HAR files + expected outputs
```

## Run flow

```
CLI args
  -> validate state, resolve county to FIPS            (03, counties.ts)
  -> look up adapter in registry                        (04)
  -> create run folder, start logger                    (07, 08)
  -> if adapter.requiresAuth: resolve credentials       (06)
  -> launch browser (reuse saved session if valid)      (05)
  -> adapter.scrape(ctx, county)  ── yields raw records
        for each raw record:
          adapter.normalize(raw) -> zod validate
            valid   -> write to CSV/JSON stream
            invalid -> count + log warning, keep raw in invalid.jsonl
  -> close browser
  -> write run report (always, even on failure)         (08)
  -> exit with status code                              (03)
```

Records are **streamed**: written as they arrive, not held in memory, so large counties and crashes don't lose everything.

## Key boundaries

- **Core never knows site details.** All URLs, selectors, and field mappings live in the adapter.
- **Adapters never touch the filesystem or logger setup directly.** They use what `ScrapeContext` gives them (logger, rate limiter, credentials, download helper).
- **Normalization is a pure function** (`raw -> WellRecord`), so it can be unit-tested without a browser.

## Configuration

Defaults live in code; overrides come from CLI flags, then an optional `wells.config.json` in the working directory. Precedence: CLI flag > config file > default. Config is validated with zod at startup.
