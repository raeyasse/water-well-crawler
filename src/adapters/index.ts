import { InputError } from "../core/errors.ts";
import { fakeAdapter } from "./fake/index.ts";
import { makeDemoAdapter } from "./demo/index.ts";
import { caAdapter } from "./ca/index.ts";
import type { StateAdapter } from "./types.ts";

/**
 * Registry: state code -> adapter. Registering here is the only core change needed to add a state.
 */
export const adapters: Record<string, StateAdapter> = {
  CA: caAdapter,
};

/**
 * Development adapters, selected with the hidden `--adapter <id>` flag for any state.
 * They exercise the full pipeline without touching a real agency site.
 */
export const devAdapters: Record<string, StateAdapter> = {
  fake: fakeAdapter,
  demo: makeDemoAdapter({ auth: false }),
  "demo-auth": makeDemoAdapter({ auth: true }),
};

export function getAdapter(state: string, override?: string): StateAdapter {
  if (override) {
    const dev = devAdapters[override] ?? adapters[override.toUpperCase()];
    if (!dev) throw new InputError(`Unknown --adapter "${override}". Available: ${[...Object.keys(devAdapters), ...Object.keys(adapters)].join(", ")}`);
    return dev;
  }
  const adapter = adapters[state];
  if (!adapter) {
    const supported = Object.keys(adapters);
    throw new InputError(`No adapter for ${state} yet. Supported: ${supported.length ? supported.join(", ") : "(none registered yet)"}`);
  }
  return adapter;
}
