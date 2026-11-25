# 10 — Testing

Runner: `vitest`. Goal: everything except the live site is tested offline and deterministically.

## Layers

### 1. Unit tests (no browser)

- `counties.ts`: name normalization, ambiguous names (MD Baltimore city/county, VA independent cities), parishes (LA), boroughs/census areas (AK), typos → suggestions, FIPS input.
- `units.ts`: conversions and rounding.
- `credentials/resolve.ts`: lookup order across env / `.env` / user file, missing-key error lists names only. Uses temp dirs and a fake env.
- `logger.ts`: redaction — a log call containing `password`, `WELLS_*` values never emits them.
- `report.ts`: status rules from 08 given synthetic counts.
- Each adapter's `normalize()`: table-driven tests from real sample raw records (stored in `test/fixtures/<state>/raw-samples.json`) to expected WellRecords.

### 2. Adapter replay tests (browser, no network)

- Record a HAR once against the live site for one small county: `playwright` `recordHar` via a script `npm run record-fixture -- --state NC --county <small>`.
- Tests replay it with `context.routeFromHAR(file, { notFound: "abort" })` and run the full `scrape → normalize → write` path.
- Assert: record count, a snapshot of the first N normalized records, the report counts, and output files exist and parse.
- Fixtures are committed; re-record when the site changes (document date in adapter README).

### 3. Core integration test

- A tiny **fake SPA** served locally (static HTML + JS that fetches JSON with pagination, a login form, and an optional CAPTCHA-like element) exercises: capture helpers, pagination helper, session reuse, blocking detection, retries (server returns 503 then 200), Ctrl+C handling, partial-result writing.

### 4. Live smoke tests (opt-in)

- `npm run test:live` runs `wells check` for every registered adapter against the real sites. Not run in CI by default; run before releases or on a manual schedule.

## CI

- On every push: lint (`eslint`), typecheck (`tsc --noEmit`), unit + replay + integration tests.
- Playwright browsers installed in CI via `npx playwright install --with-deps chromium`.
