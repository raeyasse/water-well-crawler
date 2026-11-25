import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InputError } from "./errors.ts";

export interface County {
  state: string;
  name: string;
  fips: string;
}

const COUNTIES_CSV = fileURLToPath(new URL("../../data/counties.csv", import.meta.url));

let cache: County[] | undefined;

/** Load the bundled Census county reference (data/counties.csv). */
export function loadCounties(file = COUNTIES_CSV): County[] {
  if (cache && file === COUNTIES_CSV) return cache;
  const rows = readFileSync(file, "utf8").trim().split(/\r?\n/).slice(1);
  const counties = rows.map((line) => {
    const m = line.match(/^([A-Z]{2}),\d+,\d+,(\d{5}),"?(.*?)"?$/);
    if (!m) throw new Error(`Bad line in ${file}: ${line}`);
    return { state: m[1]!, fips: m[2]!, name: m[3]! };
  });
  if (file === COUNTIES_CSV) cache = counties;
  return counties;
}

/** Suffixes stripped during normalization; longest first so "city and borough" wins over "borough". */
const SUFFIXES = ["city and borough", "census area", "planning region", "municipality", "borough", "county", "parish"];

function basic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bste\.?(?=\s)/g, "ste")
    .replace(/\bst\./g, "st")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase, trim, strip county/parish/borough/census area, unify st./saint. */
export function normalizeCountyName(input: string): string {
  let s = basic(input);
  for (const suffix of SUFFIXES) {
    if (s.endsWith(` ${suffix}`)) {
      s = s.slice(0, -suffix.length - 1).trim();
      break;
    }
  }
  return s;
}

/**
 * Resolve a county name or FIPS within a state.
 * Throws InputError for no match (with suggestions) or ambiguous matches (with FIPS options).
 */
export function resolveCounty(state: string, input: string, all: County[] = loadCounties()): County {
  const inState = all.filter((c) => c.state === state);
  const raw = input.trim();

  if (/^\d{5}$/.test(raw)) {
    const hit = inState.find((c) => c.fips === raw);
    if (!hit) throw new InputError(`FIPS ${raw} is not a county in ${state}.`);
    return hit;
  }
  if (/^\d{3}$/.test(raw)) {
    const hit = inState.find((c) => c.fips.endsWith(raw));
    if (hit) return hit;
  }

  // Exact match on the full canonical name ("Baltimore County" vs "Baltimore city").
  const full = basic(raw);
  const exact = inState.filter((c) => basic(c.name) === full);
  if (exact.length === 1) return exact[0]!;

  const base = normalizeCountyName(raw);
  const matches = inState.filter((c) => {
    const n = normalizeCountyName(c.name);
    return n === base || n === `${base} city`;
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const options = matches.map((c) => `${c.name} (${c.fips})`).join(", ");
    throw new InputError(`County "${input}" is ambiguous in ${state}. Did you mean: ${options}? You can also pass the FIPS code.`);
  }

  const suggestions = inState
    .map((c) => ({ c, d: levenshtein(base, normalizeCountyName(c.name)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ c }) => c.name);
  throw new InputError(
    `No county "${input}" in ${state}.${suggestions.length ? ` Closest: ${suggestions.join(", ")}.` : ""}`,
  );
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** "Wake County" -> "wake", used in output folder names. */
export function countySlug(county: County): string {
  return normalizeCountyName(county.name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
