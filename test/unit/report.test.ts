import { describe, expect, it } from "vitest";
import { completenessPercent, computeStatus, FieldCoverage, WarningTally } from "../../src/logging/report.ts";

const base = { errorCount: 0, aborted: false, maxRecordsHit: false };
const counts = (recordsWritten: number, siteReportedTotal: number | null = null) => ({ recordsWritten, siteReportedTotal });

describe("computeStatus", () => {
  it("success: no errors and ≥ 99% of total", () => {
    expect(computeStatus({ ...base, counts: counts(990, 1000) })).toEqual({ status: "success", exitCode: 0 });
    expect(computeStatus({ ...base, counts: counts(50) })).toEqual({ status: "success", exitCode: 0 });
    expect(computeStatus({ ...base, counts: counts(0, 0) })).toEqual({ status: "success", exitCode: 0 });
  });

  it("partial: completeness < 99%", () => {
    expect(computeStatus({ ...base, counts: counts(989, 1000) }).status).toBe("partial");
  });

  it("partial: errors, abort, or max-records with records written", () => {
    expect(computeStatus({ ...base, errorCount: 1, counts: counts(10) })).toEqual({ status: "partial", exitCode: 1 });
    expect(computeStatus({ ...base, aborted: true, counts: counts(10) }).status).toBe("partial");
    expect(computeStatus({ ...base, maxRecordsHit: true, counts: counts(10, 10) }).status).toBe("partial");
    expect(computeStatus({ ...base, fatal: { exitCode: 2, blocked: false }, counts: counts(10) }).exitCode).toBe(1);
  });

  it("failed: fatal error with zero records", () => {
    expect(computeStatus({ ...base, errorCount: 1, fatal: { exitCode: 2, blocked: false }, counts: counts(0, 100) })).toEqual({ status: "failed", exitCode: 2 });
    expect(computeStatus({ ...base, errorCount: 1, fatal: { exitCode: 4, blocked: false }, counts: counts(0) })).toEqual({ status: "failed", exitCode: 4 });
  });

  it("blocked: always exit 5", () => {
    expect(computeStatus({ ...base, errorCount: 1, fatal: { exitCode: 5, blocked: true }, counts: counts(40) })).toEqual({ status: "blocked", exitCode: 5 });
  });
});

it("completenessPercent", () => {
  expect(completenessPercent(5231, 5229)).toBe(99.96);
  expect(completenessPercent(null, 10)).toBeNull();
  expect(completenessPercent(0, 0)).toBe(100);
});

it("FieldCoverage counts non-empty values; arrays/objects must be non-empty", () => {
  const cov = new FieldCoverage(["a", "list", "obj"]);
  cov.add({ a: 1, list: [], obj: {} });
  cov.add({ a: null, list: [1], obj: { x: 1 } });
  expect(cov.result()).toEqual({ a: 0.5, list: 0.5, obj: 0.5 });
});

it("WarningTally groups by message", () => {
  const t = new WarningTally();
  t.add("x");
  t.add("y");
  t.add("x");
  expect(t.list()).toEqual([{ msg: "x", count: 2 }, { msg: "y", count: 1 }]);
});
