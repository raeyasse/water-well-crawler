# 09 — Errors and Resilience

## Error types

Defined in `src/core/errors.ts`; each maps to an exit code and report status.

| Error | When | Exit | Retry? |
|-------|------|------|--------|
| `InputError` | Bad state/county/options | 3 | No |
| `CredentialsMissingError` | Required keys not found | 4 | No |
| `AuthFailedError` | Login rejected | 4 | No (avoid lockouts) |
| `BlockedError` | CAPTCHA, 403, bot challenge, robots disallow | 5 | No |
| `SiteChangedError` | Expected selector/endpoint not found after waits | 2 or 1 | No — signals adapter needs updating |
| `TransientError` | Timeout, network error, 429, 5xx | — | Yes |
| `ParseError` | One record can't be normalized | — | No; record goes to `invalid.jsonl`, run continues |

## Retries

- `retry(fn, { attempts: 3, baseMs: 2000, factor: 2, jitter: true })` for transient failures on navigation, page turns, and captures.
- Honor `Retry-After` on 429/503.
- After a page fails all retries: log, screenshot, and **skip to the next page** if the pagination model allows it (numbered/offset); otherwise end the run as `partial`.
- Never retry login more than once.

## Partial results

- Records are streamed to disk as they are normalized, so anything collected survives a crash.
- Writers close files in `finally` (JSON array closed, CSV flushed).
- The report is always written in `finally`, including on Ctrl+C: SIGINT sets `ctx.signal`, the adapter stops at the next checkpoint, then cleanup runs. A second Ctrl+C forces exit after closing files.

## Site-change detection

Most failures over time will be the site changing its front end. To make these obvious:

- Adapters wait for named key locators/endpoints with clear timeouts and throw `SiteChangedError("county dropdown not found")` rather than generic timeouts.
- A screenshot and the page HTML (`screenshots/<step>.html`) are saved.
- The report flags: *"Adapter NC v1.2.0 (last verified 2026-10-01) may be out of date. Run `wells check --state NC`."*

## Timeouts (defaults, configurable)

| Action | Timeout |
|--------|---------|
| Navigation | 45 s |
| Waiting for results / capture | 30 s |
| Element action | 15 s |
| Whole run | none (abort via Ctrl+C or `--max-records`) |
