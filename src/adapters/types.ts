import type { County } from "../core/counties.ts";
import type { ScrapeContext } from "../core/context.ts";
import type { BoundingBox } from "../schema/units.ts";
import type { WellRecord } from "../schema/well.ts";

export type { County, ScrapeContext };

export type RawRecord = Record<string, unknown> & { _sourceId?: string; _sourceUrl?: string };

export type AdapterEvent =
  | { type: "total"; count: number }
  | { type: "record"; raw: RawRecord }
  | { type: "page"; index: number; of?: number }
  | { type: "warning"; message: string; data?: unknown };

export interface DocumentRef {
  url: string;
  /** e.g. "well_log", "permit" */
  type: string;
  /** Saved file name; derived from the URL when omitted. */
  filename?: string;
}

/** Fields core fills in; normalize() returns everything else. */
export type CoreFields = "source_state" | "county_fips" | "county_name" | "source_name" | "scraped_at" | "adapter_version";
export type NormalizedWell = Omit<WellRecord, CoreFields>;

export type MethodKind = "api" | "browser" | "download";

/** One independent way to collect a county's records. A failure in one never stops the others. */
export interface CollectionMethod {
  kind: MethodKind;
  /** Same meaning as StateAdapter.robotsPaths, for this method only. */
  robotsPaths?: string[];
  scrape(ctx: ScrapeContext, county: County): AsyncIterable<AdapterEvent>;
}

/** One state's well database (specs/04). Core never contains state-specific logic. */
export interface StateAdapter {
  /** USPS code, e.g. "NC" */
  state: string;
  /** Human name of the source, e.g. "NC DEQ Well Construction Records" */
  sourceName: string;
  /** Landing page used to start a run */
  sourceUrl: string;
  /** Bump when selectors/mapping change */
  version: string;
  /** Date the adapter was last verified against the live site (ISO) */
  lastVerified: string;

  requiresAuth: boolean;
  /** Credential keys this adapter needs, e.g. ["USERNAME", "PASSWORD"] (specs/06) */
  credentialKeys?: string[];

  capabilities: {
    construction: boolean;
    waterLevels: boolean;
    quality: boolean;
    documents: boolean;
  };

  /** County used by `wells check`. */
  sampleCounty: string;

  /**
   * Paths (or absolute URLs on other hosts, e.g. an API host) checked against robots.txt at run start.
   * Default: the sourceUrl path. An empty list skips the check (offline adapters).
   */
  robotsPaths?: string[];
  /** Set only when the adapter README documents permission to proceed despite robots.txt. */
  robotsPermission?: string;

  /** State bounding box; coordinates outside it are nulled with a warning. */
  bounds?: BoundingBox;

  /** False for adapters that don't need a browser (e.g. a documented JSON API). Default true. */
  usesBrowser?: boolean;

  /** Optional: sign in. Called only if requiresAuth and no valid saved session. */
  login?(ctx: ScrapeContext): Promise<void>;

  /** Optional: check whether the current session is still signed in. */
  isLoggedIn?(ctx: ScrapeContext): Promise<boolean>;

  /**
   * Navigate to the county's results and yield raw records one at a time.
   * Should yield `{ type: "total", count }` once if the site reports a total.
   */
  scrape(ctx: ScrapeContext, county: County): AsyncIterable<AdapterEvent>;

  /**
   * Every collection method the source offers; all are attempted on each run, in order.
   * Omit for single-method adapters: `scrape` is then the only method.
   */
  methods?: CollectionMethod[];

  /** Pure function: raw record -> normalized well. Throw or return null to reject. */
  normalize(raw: RawRecord, county: County): NormalizedWell | null;

  /** Optional: list document URLs for a record when --docs is set. */
  documents?(raw: RawRecord): DocumentRef[];
}
