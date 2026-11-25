# 04 — State Adapters

Each supported state has one adapter: a folder under `src/adapters/<state-code>/` that knows how to navigate that state's well database and map its fields to the common schema.

## Interface

```ts
export interface StateAdapter {
  /** USPS code, e.g. "NC" */
  state: string;
  /** Human name of the source, e.g. "NC DEQ Well Construction Records" */
  sourceName: string;
  /** Landing page used to start a run */
  sourceUrl: string;
  /** Semver-ish version of this adapter; bump when selectors/mapping change */
  version: string;
  /** Date the adapter was last verified against the live site (ISO) */
  lastVerified: string;

  requiresAuth: boolean;
  /** Credential keys this adapter needs, e.g. ["USERNAME", "PASSWORD"] (see 06) */
  credentialKeys?: string[];

  capabilities: {
    construction: boolean;
    waterLevels: boolean;
    quality: boolean;
    documents: boolean;
  };

  /** Optional: sign in. Called only if requiresAuth and no valid saved session. */
  login?(ctx: ScrapeContext): Promise<void>;

  /** Optional: check whether the current session is still signed in. */
  isLoggedIn?(ctx: ScrapeContext): Promise<boolean>;

  /**
   * Navigate to the county's results and yield raw records one at a time.
   * Should yield `{ type: "total", count }` once if the site reports a total.
   */
  scrape(ctx: ScrapeContext, county: County): AsyncIterable<AdapterEvent>;

  /** Pure function: raw record -> normalized WellRecord (07). Throw or return null to reject. */
  normalize(raw: RawRecord, county: County): WellRecord | null;

  /** Optional: list document URLs for a record when --docs is set. */
  documents?(raw: RawRecord): DocumentRef[];
}

export type AdapterEvent =
  | { type: "total"; count: number }
  | { type: "record"; raw: RawRecord }
  | { type: "page"; index: number; of?: number }
  | { type: "warning"; message: string; data?: unknown };

export interface County { state: string; name: string; fips: string; }
export type RawRecord = Record<string, unknown> & { _sourceId?: string; _sourceUrl?: string };
```

## ScrapeContext (provided by core)

```ts
interface ScrapeContext {
  page: Page;                    // Playwright page, already launched
  browserContext: BrowserContext;
  log: Logger;                   // child logger tagged with adapter + runId
  credentials: CredentialSet;    // resolved keys; never log values
  politeWait(): Promise<void>;   // enforces --delay between actions
  capture: ResponseCapture;      // network JSON capture helpers (05)
  options: { maxRecords?: number; docs: boolean; headed: boolean };
  signal: AbortSignal;           // set on Ctrl+C or max-records reached
}
```

Adapters MUST check `ctx.signal.aborted` between pages and stop cleanly.

## Registry

`src/adapters/index.ts` exports a map:

```ts
export const adapters: Record<string, StateAdapter> = { NC: ncAdapter /*, TX: txAdapter */ };
```

Registering is the only core change needed to add a state.

## Writing a new adapter (checklist)

1. **Research the site** before coding, and record findings in the adapter's `README.md`:
   - Source URL, owning agency, terms of use, `robots.txt` rules.
   - Is login required? What kind (account, API key, MFA)?
   - How to filter by county (dropdown, map extent, URL parameter, search field).
   - **Open DevTools → Network** while searching. Note any JSON/XHR endpoints the page calls (common: ArcGIS REST `/query`, `/api/...`). These drive the capture strategy (05).
   - Pagination style: numbered pages, "next" button, infinite scroll, or offset in requests.
   - Field list and units for each record; sample of 3 real records.
2. Copy `src/adapters/_template/` to `src/adapters/<xx>/`.
3. Put all selectors in `selectors.ts`, preferring role/label/text locators (`getByRole`, `getByLabel`) over CSS classes, which change with each SPA build.
4. Implement `scrape()` using the capture-first strategy (05): drive the UI to trigger the site's own requests, collect the JSON responses, fall back to DOM parsing only if no usable response exists.
5. Implement `normalize()` mapping to the schema in 07. Unknown/extra source fields go into `extra`.
6. Record a fixture HAR for one small county and write tests (10).
7. Add to the registry, run `wells check --state <xx>`, then a full run on the fixture county.
8. Set `lastVerified` and `version`.

## Rules for adapters

- MUST only access pages and endpoints the public site itself uses, at a polite rate.
- MUST NOT bypass CAPTCHAs or access controls; on detection, yield a warning and throw a `BlockedError` (09).
- MUST NOT call the site's backend endpoints directly with forged parameters to exceed what the UI permits (e.g. raising page size beyond the UI's options) unless the agency documents that API as public.
- SHOULD yield the site's reported total so the report can compare expected vs collected.
- SHOULD set `_sourceId` (the site's own well/permit ID) and `_sourceUrl` (detail page link) on every raw record.
