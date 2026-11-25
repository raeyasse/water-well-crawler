# 03 — Command-Line Interface

Binary name: `wells` (via `package.json` `bin`). Also runnable as `npx wells` or `npm run wells --`.

## Commands

### `wells scrape`

Collect wells for one county.

```
wells scrape --state <state> --county <county> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--state <s>` | required | USPS code or full name (`NC`, `North Carolina`, case-insensitive) |
| `--county <c>` | required | County name, with or without "County" (`Wake`, `wake county`). FIPS code also accepted (`37183`). |
| `--out <dir>` | `./output` | Base output folder |
| `--format <list>` | `csv,json` | Any of `csv`, `json` |
| `--docs` | off | Also download well-log documents (PDF/images) when the adapter supports it |
| `--no-owner` | off | Drop owner/person-name fields from output |
| `--max-records <n>` | none | Stop after n records (testing / sampling) |
| `--delay <ms>` | `1500` | Minimum delay between page navigations / requests |
| `--headed` | off | Show the browser window (debugging, or manual login) |
| `--trace` | off | Save a Playwright trace to the run folder |
| `--keep-raw` | off | Also save raw captured responses to `raw/` |
| `--log-level <lvl>` | `info` | `debug`, `info`, `warn`, `error` |

### `wells list-states`

Prints supported states with adapter name, source URL, whether login is required, and capabilities (construction / water levels / quality / documents).

### `wells check --state <s>`

Smoke test for one adapter: opens the site, confirms key pages and selectors still work, fetches one page of results for a sample county, and reports pass/fail. Writes nothing to `output/`. Use when a site may have changed.

### `wells login --state <s>`

Opens a headed browser on the state site so the operator can sign in manually (useful for MFA). On success, saves the session to the local session store (see 06). Only for adapters with `requiresAuth: true`.

## Input resolution

1. **State**: match against USPS codes and full names. Unknown → exit 3 with a list of valid states.
2. **Unsupported state** (valid but no adapter) → exit 3: `No adapter for TX yet. Supported: NC, ...`.
3. **County**: normalize (lowercase, trim, strip `county`/`parish`/`borough`/`census area`, unify `st.`/`saint`), then match within the state using `data/counties.csv`.
   - Exact match → use it.
   - Multiple matches (e.g. Baltimore city vs Baltimore County, MD) → exit 3 listing the options with their FIPS codes.
   - No match → exit 3 and suggest up to 3 closest names (edit distance).
4. The resolved county (name + FIPS) is printed at the start of the run and recorded in the report.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success: all records collected |
| 1 | Partial: run ended early or some pages failed, but records were written |
| 2 | Failed: no records written due to an error |
| 3 | Invalid input (state/county/options) |
| 4 | Credentials required but not found or rejected |
| 5 | Blocked by the site (CAPTCHA, access denied, robots/ToS stop) |

## Console output

Human-friendly progress on stderr (spinner or one line per page: `page 4/37 · 400 wells`), and a final summary block matching the top of the run report. Machine-readable detail goes to the log file, not the console.
