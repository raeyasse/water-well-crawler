import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeDemo } from "../../src/adapters/demo/normalize.ts";
import type { RawRecord } from "../../src/adapters/types.ts";

const samples = JSON.parse(readFileSync(new URL("../fixtures/demo/raw-samples.json", import.meta.url), "utf8")) as RawRecord[];
const byId = (id: string) => samples.find((s) => s.WellID === id)!;

describe("demo adapter normalize()", () => {
  it.each([
    ["37183-0001", { well_type: "domestic", well_status: "active", total_depth_ft: 131, completion_date: "1986-02-02", yield_gpm: 6, casing_diameter_in: 6 }],
    ["37183-0009", { well_type: "irrigation", well_status: "abandoned", total_depth_ft: 127.95, completion_date: "1994-10-10" }],
    ["37183-0011", { well_type: "public_supply", well_status: "unknown", total_depth_ft: 241 }],
    ["37183-0015", { yield_gpm: null, water_levels: [{ date: "2020-05-01", depth_to_water_ft: 22.5 }, { date: "2023-05-01", depth_to_water_ft: 24.1 }] }],
  ])("%s", (id, expected) => {
    const out = normalizeDemo(byId(id));
    expect(out).toMatchObject({ source_id: id, ...expected });
  });

  it("keeps original values in extra when converting or failing to map", () => {
    expect(normalizeDemo(byId("37183-0009")).extra).toMatchObject({ original_total_depth: "39 m" });
    expect(normalizeDemo(byId("37183-0011")).extra).toMatchObject({ original_status: "Inactive?" });
  });

  it("maps unknown well uses to 'other' and keeps the original", () => {
    const raw = { ...samples.find((s) => s.WellUse === "Test Hole")!, WellID: "X-1" };
    expect(normalizeDemo(raw)).toMatchObject({ well_type: "other", extra: { original_well_type: "Test Hole" } });
  });

  it("puts unmapped source fields into extra and never omits schema fields", () => {
    const out = normalizeDemo(byId("37183-0001"));
    expect(out.extra).toEqual({ BasinCode: "B1" });
    expect(out.aquifer).toBeNull();
    expect(out.water_quality).toEqual([]);
  });

  it("rejects records without an ID", () => {
    expect(() => normalizeDemo(samples.find((s) => s.WellID === "")!)).toThrow(/WellID/);
  });

  it("nulls unparseable dates and keeps the original", () => {
    const out = normalizeDemo({ ...byId("37183-0001"), DateCompleted: "spring 1990" });
    expect(out.completion_date).toBeNull();
    expect(out.extra.original_date_completed).toBe("spring 1990");
  });
});
