/** `npm run test:live`: run `wells check` for every registered adapter against the real sites (specs/10, layer 4). */
import { adapters } from "../src/adapters/index.ts";
import { runCheck } from "../src/core/check.ts";
import { loadConfigFile } from "../src/core/config.ts";
import { DEFAULT_TIMEOUTS } from "../src/core/context.ts";
import { createLogger } from "../src/logging/logger.ts";

const config = loadConfigFile();
const entries = Object.entries(adapters);
if (!entries.length) process.stderr.write("No adapters registered; nothing to check.\n");
let failed = 0;
for (const [state, adapter] of entries) {
  const { log } = createLogger({ level: "info", bindings: { state } });
  const res = await runCheck({ adapter, state, log, delay: config.delay ?? 1500, headed: false, contact: config.contact, timeouts: { ...DEFAULT_TIMEOUTS, ...config.timeouts } });
  process.stderr.write(`${res.pass ? "PASS" : "FAIL"} ${state} ${adapter.sourceName} v${adapter.version}\n`);
  if (!res.pass) failed++;
}
process.exitCode = failed ? 1 : 0;
