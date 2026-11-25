import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeCa } from "../../src/adapters/ca/normalize.ts";
import { serviceCountyName, sqlString } from "../../src/adapters/ca/service.ts";
import type { RawRecord } from "../../src/adapters/types.ts";

/** Real records from the DWR service (test/fixtures/ca/raw-samples.json, fetched 2026-10-24). */
const samples = JSON.parse(readFileSync(new URL("../fixtures/ca/raw-samples.json", import.meta.url), "utf8")) as RawRecord[];
const byId = (id: string) => samples.find((s) => s.WCRNumber === id)!;

describe("CA normalize()", () => {
  it.each([
    [
      "WCR0001050",
      {
        well_type: "domestic", well_status: null, total_depth_ft: 233, casing_diameter_in: 8.625, static_water_level_ft: 48,
        yield_gpm: 50, completion_date: "1980-10-11", driller_name: "COOPER DRILLING CO", driller_license: "307389", permit_number: "80-97",
      },
    ],
    [
      "WCR1960-000815",
      {
        well_type: "domestic", total_depth_ft: 170, casing_diameter_in: 8, completion_date: "1960-07-17", address: "WOODLAND",
        location_accuracy: "Centroid of Section — Derived from TRS", latitude: 38.67039,
      },
    ],
    ["WCR1932-000021", { well_type: "irrigation", total_depth_ft: 219, casing_diameter_in: 16, completion_date: "1932-05-01" }],
    ["WCR2022-005599", { well_type: "monitoring", well_status: "plugged", static_water_level_ft: 13, permit_number: "22-006H(A)", completion_date: "2022-04-13" }],
    ["WCR0031169", { well_type: "unknown", well_status: "plugged", location_accuracy: ">50 Ft — Other", address: "WEST SACRAMENTO" }],
    [
      "WCR0113931",
      { well_type: "unknown", well_status: null, total_depth_ft: null, completion_date: null, driller_name: null, permit_number: null, yield_gpm: null },
    ],
  ])("%s", (id, expected) => {
    expect(normalizeCa(byId(id))).toMatchObject({ source_id: id, ...expected });
  });

  it("links the scanned report as source_url and document", () => {
    const raw = byId("WCR1960-000815");
    const out = normalizeCa(raw);
    expect(out.source_url).toBe(raw.WCRLinks);
    expect(out.documents).toEqual([{ url: raw.WCRLinks, type: "well_completion_report" }]);
  });

  it("keeps unmapped source fields in extra, drops service bookkeeping", () => {
    const out = normalizeCa(byId("WCR1960-000815"));
    expect(out.extra).toMatchObject({ PlannedUseFormerUse: "Water Supply Domestic", RecordType: "New", Township: expect.any(String), BaselineMeridian: expect.any(String) });
    for (const k of ["OBJECTID", "GlobalID", "MODIFIED_BY", "LAST_MODIFIED_DATE", "CountyName"]) expect(out.extra).not.toHaveProperty(k);
    expect(out.extra.ReceivedDate ?? "2000-01-01").toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to drilled depth, and rejects non-GPM yields", () => {
    const base = byId("WCR0113931");
    expect(normalizeCa({ ...base, TotalDrillDepth: "305" }).total_depth_ft).toBe(305);
    const out = normalizeCa({ ...base, WellYield: "3", WellYieldUnitofMeasure: "GPH" });
    expect(out.yield_gpm).toBeNull();
    expect(out.extra.original_well_yield).toBe("3 GPH");
  });

  it("treats 0,0 coordinates as missing", () => {
    expect(normalizeCa({ ...byId("WCR0113931"), DecimalLatitude: 0, DecimalLongitude: 0 })).toMatchObject({ latitude: null, longitude: null });
  });

  it("rejects records without a WCR number", () => {
    expect(() => normalizeCa({ ...byId("WCR0113931"), WCRNumber: " " })).toThrow(/WCRNumber/);
  });
});

it("county name and SQL helpers", () => {
  expect(serviceCountyName("Los Angeles County")).toBe("Los Angeles");
  expect(serviceCountyName("San Francisco County")).toBe("San Francisco");
  expect(sqlString("O'Brien")).toBe("'O''Brien'");
});
