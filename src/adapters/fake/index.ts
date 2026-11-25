import { sleep } from "../../core/retry.ts";
import { emptyWell } from "../../schema/well.ts";
import { cleanString, parseDate, parseNumber } from "../../schema/units.ts";
import type { AdapterEvent, County, RawRecord, ScrapeContext, StateAdapter } from "../types.ts";

/**
 * Synthetic adapter with no browser (specs/11, M1). Yields deterministic records for any county,
 * including one invalid record and one duplicate, to exercise normalization, validation and reporting.
 */

const TOTAL = 250;
const PAGE_SIZE = 50;
const INVALID_AT = 100;
const DUPLICATE_OF = 150;

/** Small deterministic PRNG so output is stable per county. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USES = ["Domestic", "Irrigation", "Monitoring", "Public Supply"];

export function fakeRecord(county: County, i: number): RawRecord {
  const r = rng(Number(county.fips) * 1000 + i);
  const id = `FAKE-${county.fips}-${String(i).padStart(5, "0")}`;
  return {
    _sourceId: i === INVALID_AT ? undefined : id,
    id: i === INVALID_AT ? "" : id,
    use: USES[Math.floor(r() * USES.length)],
    lat: 35 + r(),
    lon: -79 + r(),
    depth: Math.round(100 + r() * 400),
    completed: `${1 + Math.floor(r() * 12)}/${1 + Math.floor(r() * 28)}/${1980 + Math.floor(r() * 45)}`,
    owner: `Owner ${i}`,
  };
}

export const fakeAdapter: StateAdapter = {
  state: "DEV",
  sourceName: "Fake Well Source (synthetic data)",
  sourceUrl: "https://example.invalid/fake",
  version: "1.0.0",
  lastVerified: "2026-10-24",
  requiresAuth: false,
  usesBrowser: false,
  robotsPaths: [],
  sampleCounty: "Wake",
  capabilities: { construction: true, waterLevels: false, quality: false, documents: false },

  async *scrape(ctx: ScrapeContext, county: County): AsyncIterable<AdapterEvent> {
    yield { type: "total", count: TOTAL };
    const pages = Math.ceil(TOTAL / PAGE_SIZE);
    for (let p = 1; p <= pages; p++) {
      if (ctx.signal.aborted) return;
      for (let i = (p - 1) * PAGE_SIZE + 1; i <= Math.min(p * PAGE_SIZE, TOTAL); i++) {
        yield { type: "record", raw: fakeRecord(county, i) };
        if (i === DUPLICATE_OF) yield { type: "record", raw: fakeRecord(county, i) };
      }
      yield { type: "page", index: p, of: pages };
      await sleep(5);
    }
  },

  normalize(raw) {
    const id = cleanString(raw.id);
    if (!id) throw new Error("missing well id");
    const use = cleanString(raw.use)?.toLowerCase().replace(" ", "_");
    return {
      ...emptyWell(),
      source_id: id,
      well_type: use === "domestic" || use === "irrigation" || use === "monitoring" || use === "public_supply" ? use : "unknown",
      latitude: parseNumber(raw.lat),
      longitude: parseNumber(raw.lon),
      total_depth_ft: parseNumber(raw.depth),
      completion_date: parseDate(raw.completed),
      owner_name: cleanString(raw.owner),
    };
  },
};
