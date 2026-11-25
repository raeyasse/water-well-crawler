import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContext } from "playwright";
import { userConfigDir, type ResolveEnv } from "./resolve.ts";

/** Saved Playwright storageState for one state: ~/.config/well-scraper/sessions/<state>.json */
export function sessionPath(state: string, opts?: ResolveEnv): string {
  return join(userConfigDir(opts), "sessions", `${state.toLowerCase()}.json`);
}

export function hasSession(state: string, opts?: ResolveEnv): boolean {
  return existsSync(sessionPath(state, opts));
}

export async function saveSession(context: BrowserContext, state: string, opts?: ResolveEnv): Promise<string> {
  const file = sessionPath(state, opts);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const json = JSON.stringify(await context.storageState(), null, 2);
  writeFileSync(file, json, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Not supported on this OS (Windows); file is still under the user's profile.
  }
  return file;
}

export function deleteSession(state: string, opts?: ResolveEnv): void {
  rmSync(sessionPath(state, opts), { force: true });
}
