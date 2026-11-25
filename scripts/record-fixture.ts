/**
 * Record a fixture for an adapter against the live site (specs/10, layer 2):
 *   npm run record-fixture -- --state CA --county <small county> [--adapter demo]
 * Browser adapters: test/fixtures/<state>/<county>.har. API adapters (usesBrowser: false):
 * test/fixtures/<state>/<county>.responses.json (URL -> JSON body). Plus the expected wells.json.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildScrapeOptions } from "../src/core/config.ts";
import { countySlug } from "../src/core/counties.ts";
import { resolveTarget, runScrape } from "../src/core/run.ts";

const { values } = parseArgs({ options: { state: { type: "string" }, county: { type: "string" }, adapter: { type: "string" } } });
if (!values.state || !values.county) {
  process.stderr.write("Usage: npm run record-fixture -- --state <s> --county <c> [--adapter <id>]\n");
  process.exit(3);
}
const { state, county, adapter } = resolveTarget(values.state, values.county, values.adapter);
const dir = join("test", "fixtures", state.toLowerCase());
mkdirSync(dir, { recursive: true });
const slug = countySlug(county);
const opts = buildScrapeOptions({ state: values.state, county: values.county, adapter: values.adapter, out: join(dir, ".record-output") });

let result;
if (adapter.usesBrowser === false) {
  const responses: Record<string, unknown> = {};
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const url = String(input);
    if (/application\/json|text\/plain/.test(res.headers.get("content-type") ?? "") && !url.endsWith("/robots.txt")) {
      responses[url] = await res.clone().json().catch(() => undefined);
    }
    return res;
  };
  result = await runScrape(opts, { fetch: recordingFetch });
  writeFileSync(join(dir, `${slug}.responses.json`), `${JSON.stringify(responses)}\n`);
} else {
  result = await runScrape(opts, { recordHar: join(dir, `${slug}.har`) });
}
copyFileSync(join(result.runDir, "wells.json"), join(dir, `${slug}.expected.wells.json`));
process.stderr.write(`\nFixture written to ${dir}/${slug}.*\nRecord the date in the adapter README.\n`);
process.exitCode = result.exitCode;
