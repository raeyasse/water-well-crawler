import { describe, expect, it } from "vitest";
import { cleanString, cmToInches, inBounds, lpsToGpm, metersToFeet, parseDate, parseNumber, round } from "../../src/schema/units.ts";

describe("unit conversions", () => {
  it("converts and rounds to 2 decimals", () => {
    expect(metersToFeet(30)).toBe(98.43);
    expect(metersToFeet(0)).toBe(0);
    expect(cmToInches(15.24)).toBe(6);
    expect(lpsToGpm(1)).toBe(15.85);
    expect(round(1.005, 1)).toBe(1);
  });
});

describe("parseNumber", () => {
  it.each([
    [42, 42],
    ["1,234.5", 1234.5],
    ["120 ft", 120],
    ["  -3 ", -3],
    ["", null],
    ["n/a", null],
    [null, null],
    [Number.NaN, null],
  ])("%j -> %j", (input, out) => expect(parseNumber(input)).toBe(out));
});

describe("parseDate", () => {
  it.each([
    ["2024-03-05", "2024-03-05"],
    ["2024-03-05T10:00:00Z", "2024-03-05"],
    ["3/5/2024", "2024-03-05"],
    ["03-05-2024", "2024-03-05"],
    ["3/5/99", "1999-03-05"],
    ["3/5/05", "2005-03-05"],
    ["20240305", "2024-03-05"],
    [Date.UTC(2020, 0, 2), "2020-01-02"],
    ["2/30/2024", null],
    ["sometime in 1990", null],
    ["", null],
  ])("%j -> %j", (input, out) => expect(parseDate(input)).toBe(out));
});

describe("cleanString", () => {
  it("trims, collapses whitespace, maps empty to null", () => {
    expect(cleanString("  a   b ")).toBe("a b");
    expect(cleanString("   ")).toBeNull();
    expect(cleanString(5)).toBe("5");
    expect(cleanString({})).toBeNull();
  });
});

it("inBounds", () => {
  const nc = { minLat: 33.75, maxLat: 36.6, minLon: -84.33, maxLon: -75.4 };
  expect(inBounds(35.8, -78.6, nc)).toBe(true);
  expect(inBounds(0, 0, nc)).toBe(false);
});
