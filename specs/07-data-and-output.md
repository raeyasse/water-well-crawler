# 07 — Data Schema and Output Files

## WellRecord (normalized)

Defined once in `src/schema/well.ts` as a zod schema. All adapters produce this shape. Fields the source doesn't provide are `null`, never omitted.

| Field | Type | Notes |
|-------|------|-------|
| `source_state` | string | USPS code |
| `county_fips` | string | 5 digits |
| `county_name` | string | Canonical name from `counties.csv` |
| `source_name` | string | Adapter `sourceName` |
| `source_id` | string | The site's own well / permit / record ID |
| `source_url` | string \| null | Link to the record's detail page |
| `well_name` | string \| null | Name or label if any |
| `well_type` | string \| null | Normalized: `domestic`, `public_supply`, `irrigation`, `monitoring`, `industrial`, `geothermal`, `other`, `unknown` |
| `well_status` | string \| null | Normalized: `active`, `abandoned`, `plugged`, `proposed`, `unknown` |
| `latitude` | number \| null | WGS84 decimal degrees |
| `longitude` | number \| null | WGS84 decimal degrees |
| `location_accuracy` | string \| null | As reported (e.g. "GPS", "address geocoded") |
| `address` | string \| null | |
| `owner_name` | string \| null | Dropped when `--no-owner` |
| `driller_name` | string \| null | |
| `driller_license` | string \| null | |
| `permit_number` | string \| null | |
| `completion_date` | string \| null | ISO `YYYY-MM-DD` |
| `total_depth_ft` | number \| null | Feet |
| `casing_depth_ft` | number \| null | Feet |
| `casing_diameter_in` | number \| null | Inches |
| `casing_material` | string \| null | |
| `static_water_level_ft` | number \| null | Feet below land surface, at completion |
| `yield_gpm` | number \| null | Gallons per minute |
| `aquifer` | string \| null | |
| `water_levels` | array | `{ date, depth_to_water_ft, method? }[]`; empty if none |
| `water_quality` | array | `{ date, parameter, value, unit, flag? }[]`; empty if none |
| `documents` | array | `{ url, local_path?, type }[]` |
| `extra` | object | Any other source fields, keys as the source names them |
| `scraped_at` | string | ISO timestamp |
| `adapter_version` | string | |

### Normalization rules

- **Units**: convert to feet, inches, gpm. Shared helpers in `src/schema/units.ts` (meters→feet, cm→inches, L/s→gpm). Keep the original value in `extra` if conversion was applied.
- **Coordinates**: convert from source projection to WGS84 if needed (e.g. State Plane). Use `proj4` only if an adapter needs it. Reject coordinates outside the state's bounding box as `null` + warning.
- **Dates**: parse source formats to ISO; unparseable → `null` + original in `extra`.
- **Enums**: each adapter maps its own values to the normalized lists above; unmapped → `other`/`unknown` with the original in `extra`.
- **Trimming**: trim strings; empty strings → `null`.
- **Within-run duplicates**: if `source_id` repeats in one run (common with overlapping pages), keep the first and count the duplicate. No cross-run dedup.

## Output layout

```
output/
  NC/
    wake-37183/
      2026-10-24T19-30-05Z/          # one folder per run (UTC timestamp)
        wells.csv
        wells.json
        invalid.jsonl                  # raw records that failed normalization/validation
        run-log.jsonl                  # 08
        run-report.md                  # 08
        run-report.json                # 08
        screenshots/                   # only on errors
        raw/                           # only with --keep-raw
        documents/<source_id>/...      # only with --docs
        trace.zip                      # only with --trace
      latest -> 2026-10-24T19-30-05Z  # symlink (or latest.txt on Windows)
```

## File formats

- **wells.json**: JSON array of WellRecord, written streaming (`[`, records separated by `,\n`, `]`). Valid JSON even if the run stops early — the writer closes the array in a `finally` block.
- **wells.csv**: UTF-8 with BOM (opens cleanly in Excel), header row, one row per well. Nested arrays (`water_levels`, `water_quality`, `documents`) and `extra` are written as JSON strings in their columns. Additionally, if any record has water levels or quality data, write `water_levels.csv` and `water_quality.csv` in long format keyed by `source_id`.
- **invalid.jsonl**: one line per rejected record: `{ raw, errors }`.
