import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { CredentialsMissingError } from "../core/errors.ts";

/** Resolved credential values plus where each came from. Never log `values`. */
export interface CredentialSet {
  /** Adapter key name ("USERNAME") -> value */
  values: Record<string, string>;
  /** Full key ("WELLS_TX_USERNAME") -> human source label */
  sources: Record<string, string>;
  get(name: string): string;
}

export interface ResolveEnv {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
  platform?: NodeJS.Platform;
}

/** Base dir for user credentials and sessions: ~/.config/well-scraper or %APPDATA%\well-scraper. */
export function userConfigDir({ env = process.env, home = homedir(), platform = process.platform }: ResolveEnv = {}): string {
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "well-scraper");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "well-scraper");
}

export const credentialKey = (state: string, name: string): string => `WELLS_${state.toUpperCase()}_${name.toUpperCase()}`;

function readEnvFile(file: string): Record<string, string> {
  return existsSync(file) ? parse(readFileSync(file)) : {};
}

/**
 * Look up each key in order (first match wins): process env, ./.env, user credentials file (specs/06).
 * Throws CredentialsMissingError naming missing keys and the places checked — never values.
 */
export function resolveCredentials(state: string, names: string[], opts: ResolveEnv = {}): CredentialSet {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const dotenvPath = join(cwd, ".env");
  const userFile = join(userConfigDir(opts), "credentials.env");

  const layers: [label: string, vars: Record<string, string | undefined>][] = [
    ["environment variable", env],
    [".env file", readEnvFile(dotenvPath)],
    ["user credentials file", readEnvFile(userFile)],
  ];

  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const key = credentialKey(state, name);
    const layer = layers.find(([, vars]) => vars[key] !== undefined && vars[key] !== "");
    if (!layer) {
      missing.push(key);
      continue;
    }
    values[name] = layer[1][key]!;
    sources[key] = layer[0];
  }
  if (missing.length) {
    throw new CredentialsMissingError(missing, ["process environment", dotenvPath, userFile]);
  }
  return makeCredentialSet(values, sources);
}

export function makeCredentialSet(values: Record<string, string> = {}, sources: Record<string, string> = {}): CredentialSet {
  return {
    values,
    sources,
    get(name) {
      const v = values[name];
      if (v === undefined) throw new Error(`Credential ${name} was not resolved (add it to credentialKeys)`);
      return v;
    },
  };
}

/** Report lines like "WELLS_TX_USERNAME (user credentials file)". */
export function describeCredentials(set: CredentialSet): string[] {
  return Object.entries(set.sources).map(([key, source]) => `${key} (${source})`);
}
