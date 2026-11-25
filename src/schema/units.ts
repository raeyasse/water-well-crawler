/** Unit conversion and value-cleaning helpers shared by adapter normalize() functions (specs/07). */

export const FEET_PER_METER = 3.280839895;
export const INCHES_PER_CM = 0.3937007874;
export const GPM_PER_LPS = 15.850323141;

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export const metersToFeet = (m: number): number => round(m * FEET_PER_METER);
export const cmToInches = (cm: number): number => round(cm * INCHES_PER_CM);
export const mmToInches = (mm: number): number => round((mm / 10) * INCHES_PER_CM);
export const lpsToGpm = (lps: number): number => round(lps * GPM_PER_LPS);
export const lpmToGpm = (lpm: number): number => round((lpm / 60) * GPM_PER_LPS);

/** Trim strings; empty strings and non-strings become null. Numbers are stringified. */
export function cleanString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/** Parse "1,234.5", "120 ft", 42 -> number; anything unparseable -> null. */
export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = cleanString(value);
  if (s === null) return null;
  const m = s.replace(/,/g, "").match(/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse common source date formats to ISO YYYY-MM-DD:
 * ISO strings, MM/DD/YYYY, M/D/YY, YYYYMMDD, and epoch milliseconds (ArcGIS).
 * Returns null when unparseable.
 */
export function parseDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = cleanString(value);
  if (s === null) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);

  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:\s.*)?$/);
  if (m) {
    let y = +m[3]!;
    if (m[3]!.length === 2) y += y > new Date().getUTCFullYear() % 100 ? 1900 : 2000;
    return ymd(y, +m[1]!, +m[2]!);
  }

  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);

  return null;
}

function ymd(y: number, mo: number, d: number): string | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export function inBounds(lat: number, lon: number, box: BoundingBox): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lon >= box.minLon && lon <= box.maxLon;
}
