# CA adapter — California DWR Well Completion Reports

| | |
|---|---|
| Source | DWR Online System for Well Completion Reports (OSWCR), published as the open dataset [Well Completion Reports](https://data.cnra.ca.gov/dataset/well-completion-reports) |
| Owning agency | California Department of Water Resources (DWR) |
| License / terms | Public domain ("Other (Public Domain)", Open Definition compliant). DWR notes the data is informational, with known missing/duplicate/incorrect values. |
| Access method | Public ArcGIS map service listed on the dataset page (ArcGIS item `c074ca40fd684e41babd776eebefd009`): `…/Environment/i07_WellCompletionReports/MapServer/0/query`. This is an agency-documented public API, so the adapter calls it directly (`usesBrowser: false`) — permitted by specs/04. |
| robots.txt | `utility.arcgis.com/robots.txt` redirects to an HTML page (no rules). Checked at every run start. |
| Login | None |
| County filter | `CountyName = '<Census name without " County">'` — all 58 counties match the Census names |
| Pagination | Keyset on `OBJECTID` (`OBJECTID > last ORDER BY OBJECTID`), 1000 per request (service max 2000). Site total from `returnCountOnly`. |
| Update cadence | Weekly (per dataset page) |
| Last verified | 2026-10-24 |
| Fixture recorded | 2026-10-24, Alpine County (677 reported / 675 written) |

## Verification (M3, 2026-10-24)

- `wells check --state CA`: pass.
- Alpine: 675 / 677 (99.7%), Yolo: 17,347 / 17,359 (99.93%) — status `success`.
- The gap is entirely duplicate `WCRNumber`s. Both Alpine duplicates are identical except `OBJECTID`/`GlobalID`
  (DWR lists duplicates as a known issue), so keeping the first is correct.
- 10 random Yolo records re-queried by `WCRNumber`: coordinates, depth, casing, static water level, yield, completion
  date, driller, report link and use all matched (10/10).

## Field mapping

| Source field | Unit | Maps to |
|---|---|---|
| `WCRNumber` | | `source_id` |
| `WCRLinks` | | `source_url`, `documents[]` (type `well_completion_report`) |
| `B118WellUse` | | `well_type` (Domestic, Irrigation, Monitoring, Public Supply, Industrial, Other, Unknown) |
| `RecordType` | | `well_status = plugged` for Destruction / Drill and Destroy; otherwise `null` (status not reported). Original in `extra.RecordType` |
| `DecimalLatitude` / `DecimalLongitude` | WGS84 | `latitude` / `longitude` (0,0 → null; outside CA bbox → null + warning) |
| `LLAccuracy` + `MethodofDeterminationLL` | | `location_accuracy` |
| `WellLocation`, `City` | | `address` |
| `DrillerName`, `DrillerLicenseNumber`, `PermitNumber` | | `driller_name`, `driller_license`, `permit_number` |
| `DateWorkEnded` | epoch ms | `completion_date` |
| `TotalCompletedDepth` (else `TotalDrillDepth`) | ft | `total_depth_ft` |
| `CasingDiameter` | in | `casing_diameter_in` |
| `StaticWaterLevel` | ft | `static_water_level_ft` |
| `WellYield` + `WellYieldUnitofMeasure` | GPM | `yield_gpm` (non-GPM → null, original in `extra`) |
| everything else non-empty | | `extra` (PLSS township/range/section, APN, perforations, drilling method, planned use, permit agency, …) |

There is no owner-name field in this source, so `--no-owner` has no effect.

## Quirks

- **Locations are coarse.** Most older records are placed at the centroid of their 1×1 mile PLSS section
  (`location_accuracy` = "Centroid of Section — Derived from TRS"). Don't treat them as exact well positions.
- **Sparse older records.** Many legacy records have only an ID, location and report link; construction fields come from the scanned PDF.
- **Documents can't be downloaded.** Report links point to a Box folder viewer, not direct files, so `--docs` is ignored
  (with a warning). The link is kept in `source_url` and `documents`.
- **ArcGIS errors arrive as HTTP 200** with an `error` body; codes ≥ 500 and 429 are retried, others are treated as a site change.
- **Service URL may move.** The earlier `gis.water.ca.gov/.../i07_WellCompletionReports` service now returns 404. If queries start failing,
  look up the current URL from the ArcGIS item on the dataset page and update `service.ts`.

## Sample records

Six real records are in `test/fixtures/ca/raw-samples.json` (Yolo County, fetched 2026-10-24), covering a fully populated
domestic well, legacy irrigation/domestic wells, a monitoring-well destruction, and an ID-only record.
