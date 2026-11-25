import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_TIMEOUTS, type Timeouts } from "./context.ts";
import { InputError } from "./errors.ts";
import type { OutputFormat } from "../output/writer.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const FormatList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean))
  .pipe(z.array(z.enum(["csv", "json"])).min(1, "at least one format"));

/** wells.config.json in the working directory (specs/02). All fields optional. */
export const ConfigFileSchema = z
  .object({
    out: z.string(),
    format: FormatList,
    delay: z.number().int().min(0),
    logLevel: z.enum(LOG_LEVELS),
    contact: z.string(),
    headed: z.boolean(),
    timeouts: z
      .object({ navigationMs: z.number().int().positive(), resultsMs: z.number().int().positive(), actionMs: z.number().int().positive() })
      .partial(),
  })
  .partial()
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export function loadConfigFile(cwd = process.cwd()): ConfigFile {
  const file = join(cwd, "wells.config.json");
  if (!existsSync(file)) return {};
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new InputError(`wells.config.json is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ConfigFileSchema.safeParse(json);
  if (!parsed.success) throw new InputError(`wells.config.json is invalid: ${formatZodError(parsed.error)}`);
  return parsed.data;
}

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Options for one scrape run, after merging CLI flag > config file > default. */
export interface ScrapeOptions {
  state: string;
  county: string;
  out: string;
  formats: OutputFormat[];
  docs: boolean;
  owner: boolean;
  maxRecords?: number;
  delay: number;
  headed: boolean;
  trace: boolean;
  keepRaw: boolean;
  logLevel: LogLevel;
  ignoreRobots: boolean;
  contact?: string;
  timeouts: Timeouts;
  /** Development adapter id that replaces the registry lookup (fake, demo, demo-auth). */
  adapter?: string;
}

/** Raw CLI flags as commander provides them (strings, undefined when not passed). */
export interface ScrapeFlags {
  state: string;
  county: string;
  out?: string;
  format?: string;
  docs?: boolean;
  owner?: boolean;
  maxRecords?: string;
  delay?: string;
  headed?: boolean;
  trace?: boolean;
  keepRaw?: boolean;
  logLevel?: string;
  ignoreRobots?: boolean;
  adapter?: string;
}

function intFlag(name: string, value: string | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim()) || Number(value) < min) throw new InputError(`--${name} must be an integer ≥ ${min} (got "${value}")`);
  return Number(value);
}

export function buildScrapeOptions(flags: ScrapeFlags, config: ConfigFile = {}): ScrapeOptions {
  const formatInput = flags.format ?? config.format ?? ["csv", "json"];
  const parsedFormats = FormatList.safeParse(formatInput);
  if (!parsedFormats.success) throw new InputError(`--format must be a list of csv,json (got "${String(formatInput)}")`);
  const formats: OutputFormat[] = [...new Set(parsedFormats.data)];

  const logLevel = (flags.logLevel ?? config.logLevel ?? "info").toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) throw new InputError(`--log-level must be one of ${LOG_LEVELS.join(", ")}`);

  return {
    state: flags.state,
    county: flags.county,
    out: flags.out ?? config.out ?? "./output",
    formats,
    docs: flags.docs ?? false,
    owner: flags.owner ?? true,
    maxRecords: intFlag("max-records", flags.maxRecords, 1),
    delay: intFlag("delay", flags.delay, 0) ?? config.delay ?? 1500,
    headed: flags.headed ?? config.headed ?? false,
    trace: flags.trace ?? false,
    keepRaw: flags.keepRaw ?? false,
    logLevel: logLevel as LogLevel,
    ignoreRobots: flags.ignoreRobots ?? false,
    contact: config.contact,
    timeouts: { ...DEFAULT_TIMEOUTS, ...config.timeouts },
    adapter: flags.adapter,
  };
}
