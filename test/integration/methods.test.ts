import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAdapter, fakeRecord } from "../../src/adapters/fake/index.ts";
import type { CollectionMethod, MethodKind, StateAdapter } from "../../src/adapters/types.ts";
import { BlockedError } from "../../src/core/errors.ts";
import { runScrape } from "../../src/core/run.ts";
import { options, readJson } from "../helpers.ts";

const method = (kind: MethodKind, attempted: string[], opts: { records?: number; fail?: Error } = {}): CollectionMethod => ({
  kind,
  robotsPaths: [],
  async *scrape(_ctx, county) {
    attempted.push(kind);
    for (let i = 1; i <= (opts.records ?? 0); i++) yield { type: "record", raw: fakeRecord(county, i) };
    if (opts.fail) throw opts.fail;
    yield { type: "total", count: opts.records ?? 0 };
  },
});
const withMethods = (...methods: CollectionMethod[]): StateAdapter => ({ ...fakeAdapter, methods });

describe("independent collection methods", () => {
  const boom = new Error("boom");

  it.each([0, 1, 2])("attempts every method when method %i fails", async (bad) => {
    const attempted: string[] = [];
    const kinds: MethodKind[] = ["api", "browser", "download"];
    const adapter = withMethods(...kinds.map((k, i) => method(k, attempted, { records: 3, fail: i === bad ? boom : undefined })));
    const { exitCode, report, runDir } = await runScrape(options(), { adapter, quiet: true });
    expect(attempted).toEqual(kinds);
    expect(exitCode).toBe(1);
    expect(report.methods.map((m) => m.status)).toEqual(kinds.map((_, i) => (i === bad ? "failed" : "success")));
    expect(report.errors).toEqual([expect.objectContaining({ method: kinds[bad], msg: "boom" })]);
    // Records from all three are kept, including those collected before the failure.
    expect(readJson<unknown[]>(join(runDir, "wells.json"))).toHaveLength(9);
    expect(report.counts.duplicatesKept).toBe(6);
  });

  it("attempts the rest after a block, and is only blocked overall when all are", async () => {
    const blocked = new BlockedError("captcha");
    const attempted: string[] = [];
    const some = await runScrape(options(), { adapter: withMethods(method("api", attempted, { fail: blocked }), method("download", attempted, { records: 2 })), quiet: true });
    expect(attempted).toEqual(["api", "download"]);
    expect(some.report.status).toBe("partial");
    const all = await runScrape(options(), { adapter: withMethods(method("api", [], { fail: blocked }), method("download", [], { fail: blocked })), quiet: true });
    expect(all.exitCode).toBe(5);
  });

  it("success everywhere is exit 0, and --max-records caps each method", async () => {
    const attempted: string[] = [];
    const adapter = withMethods(method("api", attempted, { records: 5 }), method("download", attempted, { records: 5 }));
    expect((await runScrape(options(), { adapter, quiet: true })).exitCode).toBe(0);
    const capped = await runScrape(options({ maxRecords: "2" }), { adapter, quiet: true });
    expect(capped.report.methods.map((m) => m.recordsWritten)).toEqual([2, 2]);
  });

  it("Ctrl+C stops the remaining methods", async () => {
    const controller = new AbortController();
    const attempted: string[] = [];
    const first: CollectionMethod = {
      kind: "api",
      robotsPaths: [],
      async *scrape(_ctx, county) {
        yield { type: "record", raw: fakeRecord(county, 1) };
        controller.abort();
        yield { type: "page", index: 1 };
      },
    };
    const { report } = await runScrape(options(), { adapter: withMethods(first, method("download", attempted)), quiet: true, signal: controller.signal });
    expect(attempted).toEqual([]);
    expect(report.methods[1]!.status).toBe("not-run");
    expect(report.status).toBe("partial");
  });
});
