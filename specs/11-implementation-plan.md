# 11 — Implementation Plan

Build in this order. Each milestone ends with its acceptance criteria met and tests passing.

## M0 — Project scaffold

- `package.json` (type: module, Node ≥ 22), TypeScript strict, eslint, vitest, `bin: wells`.
- `.gitignore` (`node_modules`, `output/`, `.env`, `sessions/`, `*.zip`), `.env.example`.
- Install Playwright + Chromium.

**Done when:** `npx wells --help` prints commands; `npm test` runs.

## M1 — Core without a browser

- CLI parsing and exit codes (03).
- County resolver + bundled `data/counties.csv` from the Census Bureau (FIPS, state, county name).
- Logger with redaction; run folder creation; streaming CSV/JSON writers; report builder (07, 08).
- WellRecord zod schema and unit helpers.
- A **fake adapter** (yields synthetic records) to exercise the pipeline end to end.

**Done when:** `wells scrape --state NC --county Wake` with the fake adapter writes `wells.csv`, `wells.json`, `run-log.jsonl`, and both reports; invalid input exits 3 with helpful messages.

## M2 — Browser layer and credentials

- Playwright launch, capture helpers, pagination helper, politeness delay, robots check, blocking detection, screenshots, `--trace` (05).
- Credential lookup chain, session save/reuse, `wells login` (06).
- Retry/backoff and error types; SIGINT handling (09).
- Fake SPA test server + integration tests (10).

**Done when:** integration tests pass for capture, DOM fallback, pagination, session reuse, 503 retry, CAPTCHA → exit 5, Ctrl+C → partial outputs + report.

## M3 — First real adapter (pilot state)

- **Decision needed: pilot state.** Pick one whose well database is public, needs no login, and covers the counties you care about first.
- Do the site research checklist (04) and write the adapter README.
- Implement `scrape`, `normalize`, selectors; record fixture; write replay tests.

**Done when:** a full live run for one real county completes with status `success`, completeness ≥ 99% of the site's reported total, and spot-checking 10 random records against the website shows correct values.

## M4 — Hardening

- `wells check` and `wells list-states`.
- `--docs` document downloads (if the pilot site has them).
- Field coverage in report; `--no-owner`; `--max-records`.
- README for operators: install, credentials setup, running, reading the report, troubleshooting site changes.

**Done when:** an operator who has never seen the code can install it, run a county, and interpret the report using only the README.

## M5 — Second adapter (validates the abstraction)

- Ideally a state with a different site style from the pilot (e.g. pilot = table/search SPA, second = ArcGIS map viewer), and if possible one that requires login, to exercise 06 for real.
- Any core change needed here indicates the interface (04) should be revised — update the spec alongside the code.

**Done when:** second state passes the M3 criteria with no state-specific code in `src/core`, `src/browser`, or `src/output`.

## Later (not v1)

- More state adapters.
- Resume from checkpoint for very large counties.
- OS keychain credential source.
- Optional USGS API adapter and county health department adapters.
- Optional SQLite storage behind the same writer interface, if repeated runs and deduplication become needed.

## Rough effort

| Milestone | Estimate |
|-----------|----------|
| M0–M1 | 2–3 days |
| M2 | 3–4 days |
| M3 | 2–4 days (depends heavily on the site) |
| M4 | 2 days |
| M5 | 2–4 days |
| Each further state | 1–3 days + upkeep when sites change |
