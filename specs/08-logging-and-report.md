# 08 — Logging and Run Report

Every run produces two things: a **detailed log** written during the run, and a **report** written at the end. Both are written even when the run fails.

## Run log — `run-log.jsonl`

- `pino` JSON lines, one event per line, at `--log-level` (default `info`).
- Every line carries: `time`, `level`, `runId`, `state`, `countyFips`, `adapter`, `msg`.
- Console gets a pretty, shorter version on stderr; the file always gets JSON.
- Secrets redacted (06).

### Events to log

| Event | Level | Fields |
|-------|-------|--------|
| `run.start` | info | args (sanitized), tool + adapter version, node + playwright versions, OS |
| `county.resolved` | info | input, name, fips |
| `credentials.resolved` | info | key names + source (never values) |
| `robots.checked` | info | url, allowed |
| `session.reused` / `login.success` / `login.failed` | info/warn | |
| `navigate` | debug | url, status, ms |
| `capture.response` | debug | url, status, records |
| `page.done` | info | index, of, records on page, running total |
| `record.invalid` | warn | source_id, validation errors |
| `record.duplicate` | debug | source_id |
| `retry` | warn | action, attempt, error |
| `blocked` | error | reason, screenshot path |
| `error` | error | error name, message, stack, screenshot path |
| `run.end` | info | status, counts, duration |

## Run report

Written in `finally` by `src/logging/report.ts` as `run-report.json` (machine-readable) and `run-report.md` (human-readable). The console summary prints the same headline numbers.

### Contents

```json
{
  "runId": "2026-10-24T19-30-05Z",
  "status": "success | partial | failed | blocked",
  "exitCode": 0,
  "input": { "state": "NC", "county": "Wake" },
  "resolved": { "state": "NC", "county": "Wake", "fips": "37183" },
  "adapter": { "name": "...", "version": "1.2.0", "lastVerified": "2026-10-01", "sourceUrl": "..." },
  "timing": { "startedAt": "...", "endedAt": "...", "durationSec": 412 },
  "counts": {
    "siteReportedTotal": 5231,
    "pagesVisited": 53,
    "recordsSeen": 5240,
    "recordsWritten": 5229,
    "duplicatesSkipped": 9,
    "invalid": 2,
    "documentsDownloaded": 0,
    "documentsFailed": 0
  },
  "completeness": { "expected": 5231, "collected": 5229, "percent": 99.96 },
  "fieldCoverage": { "latitude": 0.98, "total_depth_ft": 0.91, "yield_gpm": 0.42 },
  "warnings": [ { "msg": "...", "count": 2 } ],
  "errors": [ { "msg": "...", "page": 37, "screenshot": "screenshots/page-37.png" } ],
  "credentialsUsed": [ "WELLS_TX_USERNAME (user credentials file)" ],
  "outputs": [ "wells.csv", "wells.json", "invalid.jsonl", "run-log.jsonl" ]
}
```

### `run-report.md` layout

1. Headline: status badge, state/county, records written vs site total, duration.
2. Counts table.
3. Field coverage table (percent of records with a non-null value per field), so gaps in the source are visible.
4. Warnings and errors (grouped, with counts and screenshot links).
5. Output files list.
6. Adapter + environment details.

### Status rules

- `success`: no errors, and collected ≥ 99% of site-reported total (or no total reported and pagination ended normally).
- `partial`: records written, but errors occurred, run was aborted, `--max-records` hit, or completeness < 99%.
- `failed`: zero records written due to error.
- `blocked`: stopped by CAPTCHA/access denial/robots.
