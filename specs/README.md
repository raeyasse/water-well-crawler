# Well Scraper — Specification Index

A Node.js command-line web scraper that collects **public water well records** for a given **US State + County** from state agency websites (including SPA sites built with React, Angular, ArcGIS, etc.), writes the results to plain files, and produces a log and run report when it finishes.

```
wells scrape --state NC --county Wake
```

## Design principles

1. **Simple.** No database, no server. Each run writes a folder of files.
2. **One adapter per state.** State websites differ completely, so each state gets its own small module behind a shared interface. Core code never contains state-specific logic.
3. **Browser-first, data-second.** Playwright drives a real browser so SPA sites work, but adapters prefer capturing the JSON the site loads over parsing the rendered HTML.
4. **Polite and legitimate.** Public data only, rate-limited, honest user agent, no CAPTCHA or access-control bypass.
5. **Observable.** Every run leaves a structured log and a human-readable report.

## Spec files

| # | File | Covers |
|---|------|--------|
| 01 | [01-overview.md](01-overview.md) | Goals, scope, non-goals, glossary |
| 02 | [02-architecture.md](02-architecture.md) | Tech stack, modules, run flow, folder layout |
| 03 | [03-cli.md](03-cli.md) | Commands, options, input validation, exit codes |
| 04 | [04-state-adapters.md](04-state-adapters.md) | Adapter interface, registry, how to write a new adapter |
| 05 | [05-browser-automation.md](05-browser-automation.md) | Playwright, SPA handling, pagination, politeness |
| 06 | [06-credentials.md](06-credentials.md) | Local credential lookup and session reuse |
| 07 | [07-data-and-output.md](07-data-and-output.md) | Well record schema, normalization, output files |
| 08 | [08-logging-and-report.md](08-logging-and-report.md) | Run log and end-of-run report |
| 09 | [09-errors-and-resilience.md](09-errors-and-resilience.md) | Retries, partial results, failure handling |
| 10 | [10-testing.md](10-testing.md) | Unit, fixture, and live smoke tests |
| 11 | [11-implementation-plan.md](11-implementation-plan.md) | Milestones and acceptance criteria |

## Conventions used in these specs

- **MUST / SHOULD / MAY** carry their usual meaning (required / recommended / optional).
- State codes are 2-letter USPS codes (`NC`, `TX`). Counties are identified internally by 5-digit **FIPS** code (`37183` = Wake County, NC).
- Code samples are TypeScript and are illustrative; names may change during implementation as long as behavior matches.

## Open decisions

- [ ] **Pilot state** for the first adapter (see 11-implementation-plan.md, M3).
- [ ] Whether well-log document downloads (PDF/images) are needed in v1 or deferred.
