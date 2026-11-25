import { describe, expect, it } from "vitest";
import { normalizeCountyName, resolveCounty } from "../../src/core/counties.ts";
import { InputError } from "../../src/core/errors.ts";
import { resolveStateCode } from "../../src/core/states.ts";

describe("resolveStateCode", () => {
  it.each([
    ["NC", "NC"],
    ["nc", "NC"],
    ["North Carolina", "NC"],
    ["  north   carolina ", "NC"],
    ["Narnia", null],
  ])("%s -> %s", (input, code) => expect(resolveStateCode(input)).toBe(code));
});

describe("normalizeCountyName", () => {
  it.each([
    ["Wake County", "wake"],
    ["  wake  ", "wake"],
    ["Orleans Parish", "orleans"],
    ["Juneau City and Borough", "juneau"],
    ["Bethel Census Area", "bethel"],
    ["Saint Louis County", "st louis"],
    ["St. Louis", "st louis"],
    ["Baltimore city", "baltimore city"],
  ])("%s -> %s", (input, out) => expect(normalizeCountyName(input)).toBe(out));
});

describe("resolveCounty", () => {
  it("matches with or without 'County', any case", () => {
    expect(resolveCounty("NC", "Wake").fips).toBe("37183");
    expect(resolveCounty("NC", "wake county").fips).toBe("37183");
    expect(resolveCounty("NC", "WAKE COUNTY").name).toBe("Wake County");
  });

  it("accepts a FIPS code", () => {
    expect(resolveCounty("NC", "37183").name).toBe("Wake County");
    expect(() => resolveCounty("NC", "24005")).toThrow(InputError);
  });

  it("reports Baltimore city vs Baltimore County as ambiguous, with FIPS", () => {
    expect(() => resolveCounty("MD", "Baltimore")).toThrow(/ambiguous.*Baltimore County \(24005\).*Baltimore city \(24510\)/);
    expect(resolveCounty("MD", "Baltimore County").fips).toBe("24005");
    expect(resolveCounty("MD", "baltimore city").fips).toBe("24510");
  });

  it("handles Virginia independent cities", () => {
    expect(() => resolveCounty("VA", "Fairfax")).toThrow(/ambiguous/);
    expect(resolveCounty("VA", "Fairfax city").fips).toBe("51600");
    expect(resolveCounty("VA", "Fairfax County").fips).toBe("51059");
  });

  it("handles parishes and boroughs", () => {
    expect(resolveCounty("LA", "Orleans").fips).toBe("22071");
    expect(resolveCounty("LA", "orleans parish").fips).toBe("22071");
    expect(resolveCounty("AK", "Juneau").fips).toBe("02110");
    expect(resolveCounty("AK", "Bethel").fips).toBe("02050");
  });

  it("unifies st./saint", () => {
    expect(resolveCounty("MO", "Saint Louis County").fips).toBe("29189");
    expect(resolveCounty("MO", "St. Louis County").fips).toBe("29189");
  });

  it("suggests up to 3 close names on a typo", () => {
    try {
      resolveCounty("NC", "Wkae");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      expect((err as Error).message).toMatch(/Closest: .*Wake County/);
      expect((err as Error).message.split("Closest: ")[1]!.split(", ")).toHaveLength(3);
    }
  });
});
