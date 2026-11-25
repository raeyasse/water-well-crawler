# 01 — Overview

## Problem

Water well records in the US are held mostly by **state agencies** (environmental, natural resources, or water departments), each with its own website. Many are modern single-page apps or map viewers, so a plain HTTP fetcher can't read them. Collecting records for a county today means clicking through a different site for each state.

## Goal

Given a **State** and a **County**, the tool:

1. Picks the adapter for that state's public well database.
2. Opens the site in a headless browser, signing in with locally stored credentials only if the site requires it.
3. Filters to the county, walks through every page of results, and collects each well record.
4. Normalizes records into a common schema.
5. Writes `wells.csv` and `wells.json` to a run folder.
6. Writes a structured log and a run report summarizing what happened.

## In scope (v1)

- CLI tool, run on demand.
- State agency well databases, one adapter per state.
- Fields: location and construction data (always), water levels and water quality when the source provides them.
- Optional download of scanned well logs (PDF/images) behind a `--docs` flag.
- Local credential lookup for sites that need a login.
- Output as files only.

## Out of scope (v1)

- Databases of any kind, and deduplication across runs.
- Web UI or API server.
- Scheduled / recurring runs.
- Federal APIs (USGS) and county health department sites. The adapter interface MUST NOT prevent adding these later.
- Bypassing CAPTCHAs, paywalls, rate limits, or any access control. If a site blocks automation, the adapter reports it and stops.
- Collecting personal data beyond what the source publishes. Owner names, if published, are kept as-is but SHOULD be excludable via a flag (`--no-owner`).

## Users

A single operator running the tool from a terminal on their own machine (Windows, macOS, or Linux).

## Success criteria

- Running `wells scrape --state <XX> --county <name>` for a supported state produces a complete, correctly normalized CSV/JSON of that county's wells, with a record count that matches what the site reports (or the report explains the gap).
- A failed or interrupted run still leaves a log, a report, and whatever records were collected.
- Adding a new state requires only a new adapter folder plus a registry entry — no core changes.

## Glossary

| Term | Meaning |
|------|---------|
| Adapter | The state-specific module that knows how to navigate one website and map its data |
| Run | One execution of `wells scrape` for one state + county |
| Raw record | Data exactly as captured from the site, before normalization |
| Well record | A normalized record matching the schema in 07 |
| FIPS | Federal 5-digit county code (2-digit state + 3-digit county) |
