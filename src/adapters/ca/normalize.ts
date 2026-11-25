import type { WellRecord } from "../../schema/well.ts";
import { emptyWell } from "../../schema/well.ts";
import { cleanString, parseDate, parseNumber } from "../../schema/units.ts";
import type { NormalizedWell, RawRecord } from "../types.ts";

/** Bulletin 118 well-use categories -> schema well_type. */
const WELL_TYPES: Record<string, WellRecord["well_type"]> = {
  domestic: "domestic",
  irrigation: "irrigation",
  monitoring: "monitoring",
  "public supply": "public_supply",
  industrial: "industrial",
  other: "other",
  unknown: "unknown",
};

/** Record types that end a well's life. Other record types say nothing about current status. */
const DESTROYED = new Set(["destruction", "drill and destroy"]);

/** Service bookkeeping fields that are not well data. */
const DROP = new Set(["OBJECTID", "GlobalID", "Draw", "MODIFIED_BY", "LAST_MODIFIED_DATE", "SOURCE", "Shape", "DATE_DATA_REFERS_TO"]);

/** Fields mapped into the schema; everything else non-empty goes to `extra`. */
const MAPPED = new Set([
  "_sourceId", "_sourceUrl", "WCRNumber", "CountyName", "B118WellUse", "RecordType", "DecimalLatitude", "DecimalLongitude",
  "LLAccuracy", "MethodofDeterminationLL", "WellLocation", "City", "DrillerName", "DrillerLicenseNumber", "PermitNumber",
  "DateWorkEnded", "TotalCompletedDepth", "CasingDiameter", "StaticWaterLevel", "WellYield", "WellYieldUnitofMeasure", "WCRLinks",
]);

const DATE_FIELDS = new Set(["PermitDate", "ReceivedDate"]);

/** Pure mapping from one DWR Well Completion Report (ArcGIS attributes) to the common schema. */
export function normalizeCa(raw: RawRecord): NormalizedWell {
  const id = cleanString(raw.WCRNumber);
  if (!id) throw new Error("missing WCRNumber");

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (MAPPED.has(k) || DROP.has(k)) continue;
    if (DATE_FIELDS.has(k)) {
      const d = parseDate(v);
      if (d) extra[k] = d;
      continue;
    }
    const s = typeof v === "number" ? v : cleanString(v);
    if (s !== null && s !== "None") extra[k] = s;
  }

  const use = cleanString(raw.B118WellUse);
  let well_type: WellRecord["well_type"] = null;
  if (use && use !== "None") {
    well_type = WELL_TYPES[use.toLowerCase()] ?? "other";
    if (!WELL_TYPES[use.toLowerCase()]) extra.original_well_use = use;
  }

  const recordType = cleanString(raw.RecordType);
  if (recordType) extra.RecordType = recordType;
  const well_status: WellRecord["well_status"] = recordType && DESTROYED.has(recordType.toLowerCase()) ? "plugged" : null;

  // Depth: completed depth when reported, otherwise drilled depth (both in feet on the DWR form).
  const total_depth_ft = parseNumber(raw.TotalCompletedDepth) ?? parseNumber(raw.TotalDrillDepth);

  let yield_gpm = parseNumber(raw.WellYield);
  const yieldUnit = cleanString(raw.WellYieldUnitofMeasure);
  if (yield_gpm !== null && yieldUnit && yieldUnit.toUpperCase() !== "GPM") {
    extra.original_well_yield = `${yield_gpm} ${yieldUnit}`;
    yield_gpm = null;
  }

  const accuracy = [cleanString(raw.LLAccuracy), cleanString(raw.MethodofDeterminationLL)].filter((x) => x && x !== "None" && x !== "Unknown");
  const address = [cleanString(raw.WellLocation), cleanString(raw.City)].filter(Boolean).join(", ") || null;
  const completion_date = parseDate(raw.DateWorkEnded);
  if (completion_date === null && raw.DateWorkEnded !== null && raw.DateWorkEnded !== undefined) extra.original_date_work_ended = raw.DateWorkEnded;

  const reportUrl = cleanString(raw.WCRLinks);
  const lat = parseNumber(raw.DecimalLatitude);
  const lon = parseNumber(raw.DecimalLongitude);

  return {
    ...emptyWell(),
    source_id: id,
    source_url: reportUrl,
    well_type,
    well_status,
    // 0,0 and missing coordinates are placeholders, not locations.
    latitude: lat && lon ? lat : null,
    longitude: lat && lon ? lon : null,
    location_accuracy: accuracy.length ? accuracy.join(" — ") : null,
    address,
    driller_name: cleanString(raw.DrillerName),
    driller_license: cleanString(raw.DrillerLicenseNumber),
    permit_number: cleanString(raw.PermitNumber),
    completion_date,
    total_depth_ft,
    casing_diameter_in: parseNumber(raw.CasingDiameter),
    static_water_level_ft: parseNumber(raw.StaticWaterLevel),
    yield_gpm,
    documents: reportUrl ? [{ url: reportUrl, type: "well_completion_report" }] : [],
    extra,
  };
}
