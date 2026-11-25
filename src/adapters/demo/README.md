# Demo adapter (development only)

Reference adapter for the local fake SPA in `test/fake-spa/server.ts`. It is not a real agency site;
it exists to exercise the capture-first strategy, DOM fallback, pagination, retries, login and session reuse.

| | |
|---|---|
| Source URL | `http://127.0.0.1:4599/` (override with `WELLS_DEMO_URL`) |
| Terms of use | Disclaimer dialog — accepted explicitly and logged (`terms.accepted`) |
| robots.txt | `Allow: /` |
| Login | `demo-auth` only: `WELLS_<STATE>_USERNAME` / `WELLS_<STATE>_PASSWORD` (fake SPA: `demo` / `s3cret-pass`) |
| County filter | "County" dropdown, option value = FIPS |
| Data endpoint | `GET /api/wells?county=<fips>&page=<n>` → `{ total, page, pages, wells[] }` |
| Pagination | "Next" button; on a failed page the site shows "Retry" |
| Last verified | 2026-10-24 |

## Quirks (deliberate, to test normalization)

- Well #13 has no ID → `invalid.jsonl`.
- Well #21 has 0,0 coordinates → nulled with a bounding-box warning.
- Every 9th well's depth is in meters → converted, original kept in `extra.original_total_depth`.
- Each page repeats the previous page's last well → counted as `duplicatesSkipped`.
- `WellUse` "Test Hole" → `other`; `Status` "Inactive?" → `unknown` (originals kept in `extra`).
