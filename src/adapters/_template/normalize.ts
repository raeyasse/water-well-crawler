import { emptyWell } from "../../schema/well.ts";
import { cleanString, parseDate, parseNumber } from "../../schema/units.ts";
import type { NormalizedWell, RawRecord } from "../types.ts";

/** Pure function: raw source record -> normalized well. Unknown source fields go into `extra`. */
export function normalizeTemplate(raw: RawRecord): NormalizedWell {
  const id = cleanString(raw._sourceId);
  if (!id) throw new Error("missing source id");
  return {
    ...emptyWell(),
    source_id: id,
    source_url: cleanString(raw._sourceUrl),
    latitude: parseNumber(raw.lat), // TODO: source field names
    longitude: parseNumber(raw.lon),
    total_depth_ft: parseNumber(raw.depth),
    completion_date: parseDate(raw.completed),
    extra: {},
  };
}
