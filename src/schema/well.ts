import { z } from "zod";

/** Normalized well record (specs/07). Fields the source doesn't provide are null, never omitted. */

export const WELL_TYPES = [
  "domestic",
  "public_supply",
  "irrigation",
  "monitoring",
  "industrial",
  "geothermal",
  "other",
  "unknown",
] as const;

export const WELL_STATUSES = ["active", "abandoned", "plugged", "proposed", "unknown"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const nullableString = z.string().min(1).nullable();
const nullableNumber = z.number().finite().nullable();

export const WaterLevelSchema = z.object({
  date: isoDate.nullable(),
  depth_to_water_ft: z.number().finite().nullable(),
  method: z.string().optional(),
});

export const WaterQualitySchema = z.object({
  date: isoDate.nullable(),
  parameter: z.string().min(1),
  value: z.union([z.number(), z.string()]).nullable(),
  unit: z.string().nullable(),
  flag: z.string().optional(),
});

export const DocumentSchema = z.object({
  url: z.string().url(),
  local_path: z.string().optional(),
  type: z.string(),
});

export const WellRecordSchema = z.object({
  source_state: z.string().regex(/^[A-Z]{2}$/),
  county_fips: z.string().regex(/^\d{5}$/),
  county_name: z.string().min(1),
  source_name: z.string().min(1),
  source_id: z.string().min(1),
  source_url: z.string().url().nullable(),
  well_name: nullableString,
  well_type: z.enum(WELL_TYPES).nullable(),
  well_status: z.enum(WELL_STATUSES).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  location_accuracy: nullableString,
  address: nullableString,
  owner_name: nullableString,
  driller_name: nullableString,
  driller_license: nullableString,
  permit_number: nullableString,
  completion_date: isoDate.nullable(),
  total_depth_ft: nullableNumber,
  casing_depth_ft: nullableNumber,
  casing_diameter_in: nullableNumber,
  casing_material: nullableString,
  static_water_level_ft: nullableNumber,
  yield_gpm: nullableNumber,
  aquifer: nullableString,
  water_levels: z.array(WaterLevelSchema),
  water_quality: z.array(WaterQualitySchema),
  documents: z.array(DocumentSchema),
  extra: z.record(z.string(), z.unknown()),
  scraped_at: z.string().datetime(),
  adapter_version: z.string().min(1),
});

export type WellRecord = z.infer<typeof WellRecordSchema>;
export type WaterLevel = z.infer<typeof WaterLevelSchema>;
export type WaterQuality = z.infer<typeof WaterQualitySchema>;
export type WellDocument = z.infer<typeof DocumentSchema>;

/** Column order for wells.csv and field-coverage reporting. */
export const WELL_FIELDS = Object.keys(WellRecordSchema.shape) as (keyof WellRecord)[];

/** Fields removed from output by --no-owner. */
export const PERSON_FIELDS: (keyof WellRecord)[] = ["owner_name"];

/** Fields filled by core rather than adapters, excluded from field coverage. */
export const META_FIELDS: (keyof WellRecord)[] = [
  "source_state",
  "county_fips",
  "county_name",
  "source_name",
  "scraped_at",
  "adapter_version",
];

/** All fields null/empty, so adapters only set what the source provides. */
export function emptyWell(): Omit<
  WellRecord,
  "source_state" | "county_fips" | "county_name" | "source_name" | "source_id" | "scraped_at" | "adapter_version"
> {
  return {
    source_url: null,
    well_name: null,
    well_type: null,
    well_status: null,
    latitude: null,
    longitude: null,
    location_accuracy: null,
    address: null,
    owner_name: null,
    driller_name: null,
    driller_license: null,
    permit_number: null,
    completion_date: null,
    total_depth_ft: null,
    casing_depth_ft: null,
    casing_diameter_in: null,
    casing_material: null,
    static_water_level_ft: null,
    yield_gpm: null,
    aquifer: null,
    water_levels: [],
    water_quality: [],
    documents: [],
    extra: {},
  };
}
