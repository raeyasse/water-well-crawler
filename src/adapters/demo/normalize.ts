import type { WellRecord } from "../../schema/well.ts";
import { emptyWell } from "../../schema/well.ts";
import { cleanString, metersToFeet, parseDate, parseNumber } from "../../schema/units.ts";
import type { NormalizedWell, RawRecord } from "../types.ts";

const WELL_TYPES: Record<string, WellRecord["well_type"]> = {
  domestic: "domestic",
  "public supply": "public_supply",
  irrigation: "irrigation",
  monitoring: "monitoring",
  geothermal: "geothermal",
  industrial: "industrial",
};

const WELL_STATUSES: Record<string, WellRecord["well_status"]> = {
  active: "active",
  abandoned: "abandoned",
  plugged: "plugged",
  proposed: "proposed",
};

const MAPPED = new Set([
  "_sourceId", "_sourceUrl", "WellID", "PermitNo", "OwnerName", "DrillerName", "DrillerLicense", "WellUse", "Status",
  "Latitude", "Longitude", "LocationMethod", "Address", "DateCompleted", "TotalDepth", "DepthUnits", "CasingDepthFt",
  "CasingDiamIn", "CasingMaterial", "StaticWaterLevelFt", "YieldGPM", "Aquifer", "WaterLevels", "HasLog", "WellName",
]);

/** Pure mapping from the demo site's JSON (or DOM-scraped row) to the common schema. */
export function normalizeDemo(raw: RawRecord): NormalizedWell {
  const id = cleanString(raw.WellID);
  if (!id) throw new Error("missing WellID");
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!MAPPED.has(k) && v !== null && v !== "") extra[k] = v;

  const use = cleanString(raw.WellUse);
  let well_type: WellRecord["well_type"] = null;
  if (use) {
    well_type = WELL_TYPES[use.toLowerCase()] ?? "other";
    if (well_type === "other") extra.original_well_type = use;
  }

  const status = cleanString(raw.Status);
  let well_status: WellRecord["well_status"] = null;
  if (status) {
    well_status = WELL_STATUSES[status.toLowerCase()] ?? "unknown";
    if (well_status === "unknown") extra.original_status = status;
  }

  let total_depth_ft = parseNumber(raw.TotalDepth);
  if (total_depth_ft !== null && cleanString(raw.DepthUnits)?.toLowerCase() === "m") {
    extra.original_total_depth = `${total_depth_ft} m`;
    total_depth_ft = metersToFeet(total_depth_ft);
  }

  const completion_date = parseDate(raw.DateCompleted);
  if (completion_date === null && cleanString(raw.DateCompleted)) extra.original_date_completed = raw.DateCompleted;

  const levels = Array.isArray(raw.WaterLevels) ? (raw.WaterLevels as Record<string, unknown>[]) : [];

  return {
    ...emptyWell(),
    source_id: id,
    source_url: cleanString(raw._sourceUrl),
    well_name: cleanString(raw.WellName),
    well_type,
    well_status,
    latitude: parseNumber(raw.Latitude),
    longitude: parseNumber(raw.Longitude),
    location_accuracy: cleanString(raw.LocationMethod),
    address: cleanString(raw.Address),
    owner_name: cleanString(raw.OwnerName),
    driller_name: cleanString(raw.DrillerName),
    driller_license: cleanString(raw.DrillerLicense),
    permit_number: cleanString(raw.PermitNo),
    completion_date,
    total_depth_ft,
    casing_depth_ft: parseNumber(raw.CasingDepthFt),
    casing_diameter_in: parseNumber(raw.CasingDiamIn),
    casing_material: cleanString(raw.CasingMaterial),
    static_water_level_ft: parseNumber(raw.StaticWaterLevelFt),
    yield_gpm: parseNumber(raw.YieldGPM),
    aquifer: cleanString(raw.Aquifer),
    water_levels: levels.map((l) => ({ date: parseDate(l.date), depth_to_water_ft: parseNumber(l.depth_ft) })),
    extra,
  };
}
