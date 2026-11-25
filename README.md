# Well Scraper

Collects **public water well records** for a US **state + county** from state agency websites, including
single-page apps, and writes them to CSV/JSON along with a log and a run report.

```
wells scrape --state CA --county Yolo
```

The full specification is in [`specs/`](specs/README.md).

## Supported states

| State | Source | Login | Data |
|---|---|---|---|
| CA | [DWR Well Completion Reports](https://data.cnra.ca.gov/dataset/well-completion-reports) (public domain, weekly) | no | construction; scanned report links |

Details, field mapping and quirks: [`src/adapters/ca/README.md`](src/adapters/ca/README.md). Note that most California
locations are PLSS section centroids, not exact well positions.

North Carolina was evaluated first: its private-well records are held by county health departments (out of scope for v1),
and the state's groundwater site (ncwater.org) blocks AI agents in robots.txt, so it could not be researched by this project's tooling.

## Install

Requires Node.js 22 or newer.

```sh
npm install
npx playwright install chromium
npx wells --help
```

## Running a county

```sh
wells scrape --state CA --county Yolo            # or: --state California --county "yolo county"
wells scrape --state CA --county 06113           # FIPS works too
wells scrape --state CA --county "Los Angeles" --max-records 500   # sample a large county
```

| Option | Default | |
|---|---|---|
| `--out <dir>` | `./output` | Base output folder |
| `--format <list>` | `csv,json` | Any of `csv`, `json` |
| `--docs` | off | Download well-log documents (PDF/images) when the adapter supports it |
| `--no-owner` | off | Drop owner/person-name fields |
| `--max-records <n>` | none | Stop after n records (sampling) |
| `--delay <ms>` | `1500` | Minimum delay between page loads (plus 0–500 ms jitter) |
| `--headed` | off | Show the browser window |
| `--trace` | off | Save a Playwright trace (`trace.zip`) |
| `--keep-raw` | off | Save raw captured responses to `raw/` |
| `--log-level <lvl>` | `info` | `debug`, `info`, `warn`, `error` |
| `--ignore-robots` | off | Only honored when the adapter README documents permission |

Other commands:

- `wells list-states` — supported states, source URLs, login requirement, capabilities.
- `wells check --state CA` — smoke test: opens the site, checks key selectors, fetches one page of results for a sample county. Writes nothing to `output/`. Run this when a site may have changed.
- `wells login --state XX` — opens a visible browser so you can sign in yourself (MFA, CAPTCHA on the login page), then saves the session.

Defaults can be set in `wells.config.json` in the working directory (see `wells.config.example.json`).
Precedence: CLI flag > config file > default. Set `contact` there so it is included in the browser's user agent.

### Try it without a real site

```sh
wells scrape --state NC --county Wake --adapter fake           # synthetic data, no browser
npm run fake-spa                                               # terminal 1: local demo site on :4599
wells scrape --state NC --county Wake --adapter demo --docs    # terminal 2: real browser run
```

## Credentials

Most well databases need no login. For adapters that do, credentials are read **locally** as
`WELLS_<STATE>_<NAME>` (e.g. `WELLS_TX_USERNAME`), checking in order:

1. Environment variables
2. `.env` in the working directory (see `.env.example`)
3. `~/.config/well-scraper/credentials.env` (Windows: `%APPDATA%\well-scraper\credentials.env`) — keeps secrets out of the project

If a key is missing the run stops before opening a browser (exit 4) and names the missing keys. Values are never
written to logs, reports or traces. After a successful login the session is saved to
`~/.config/well-scraper/sessions/<state>.json` (mode 0600) and reused while it stays valid.

## Output

```
output/CA/yolo-06113/
  2026-10-24T19-30-05Z/
    wells.csv            # UTF-8 with BOM, opens cleanly in Excel; nested fields as JSON strings
    wells.json           # JSON array, valid even if the run stopped early
    water_levels.csv     # long format, only when the source has water levels
    water_quality.csv    # long format, only when the source has quality data
    invalid.jsonl        # records that failed normalization: { raw, errors }
    run-log.jsonl        # structured log (one JSON event per line)
    run-report.md        # human-readable report
    run-report.json      # same, machine-readable
    screenshots/  raw/  documents/<source_id>/  trace.zip   # only when relevant
  latest -> 2026-10-24T19-30-05Z
```

Every record follows the schema in [specs/07](specs/07-data-and-output.md). Fields the source doesn't provide are `null`.
Source fields with no schema equivalent are kept in `extra`.

## Reading the report

`run-report.md` starts with a status line:

| Status | Exit | Meaning |
|---|---|---|
| ✅ success | 0 | No errors, and ≥ 99% of the site's reported total collected |
| ⚠️ partial | 1 | Records written, but errors occurred, the run was stopped, `--max-records` was hit, or completeness < 99% |
| ❌ failed | 2 (4 for credentials) | Nothing written because of an error |
| ⛔ blocked | 5 | CAPTCHA, access denied, or robots.txt. The tool never tries to get around these. |

Exit 3 means invalid input (unknown state, ambiguous or unknown county, bad option); the message lists valid choices.

Then: counts (site total, pages, records seen/written, duplicates, invalid), **field coverage** (share of records
with each field filled in, which shows gaps in the source), warnings and errors with screenshot links, output files,
and adapter/environment details. Ctrl+C stops after the current step and still writes everything; press it twice to force.

## Troubleshooting a site change

Most failures over time come from a state site changing its front end. Signs: a `SiteChangedError` such as
"county dropdown not found", and a report note saying the adapter *may be out of date*.

1. Run `wells check --state XX` (add `--headed` to watch).
2. Look at `screenshots/*.png` and the saved `.html` next to them in the run folder.
3. Re-run with `--trace` and open it with `npx playwright show-trace output/.../trace.zip`.
4. Update the adapter's `selectors.ts` / capture filter, bump `version` and `lastVerified`, and re-record its fixture.

## Development

```sh
npm test            # unit + integration (fake SPA, real Chromium); no network needed
npm run typecheck
npm run lint
npm run test:live   # wells check against every registered real site (opt-in)
npm run record-fixture -- --state CA --county Alpine
```

### Adding a state

1. Research the site and fill in `src/adapters/_template/README.md` (specs/04 checklist): terms, robots.txt, login,
   county filter, the JSON endpoints in DevTools → Network, pagination, fields and units.
2. Copy `src/adapters/_template/` to `src/adapters/<xx>/`; put selectors in `selectors.ts` and the mapping in `normalize.ts`.
   `src/adapters/demo/` (browser, capture-first) and `src/adapters/ca/` (documented public API) are complete examples.
3. Add `test/fixtures/<xx>/raw-samples.json` and normalize tests; record a fixture (`npm run record-fixture`:
   a HAR for browser adapters, recorded responses for API adapters).
4. Register it in `src/adapters/index.ts` — the only core change needed.
5. `wells check --state XX`, then a full run; set `lastVerified`.

### Layout

```
src/cli/          commands, exit codes
src/core/         run orchestration, config, counties, errors, retry, politeness, robots, sessions, check
src/browser/      Playwright launch, response capture, pagination/wait/click helpers, block detection
src/credentials/  credential lookup chain, session store
src/output/       run folders, streaming CSV/JSON writers
src/logging/      pino logger with redaction, run report
src/schema/       WellRecord zod schema, unit and value helpers
src/adapters/     registry, ca (California), _template, demo (fake SPA), fake (synthetic)
data/counties.csv Census 2020 county FIPS reference
test/             unit, integration, fake SPA, fixtures
```
