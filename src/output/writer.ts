import { createWriteStream, type WriteStream } from "node:fs";
import { once } from "node:events";
import { stringify, type Stringifier } from "csv-stringify";
import { WELL_FIELDS, type WellRecord } from "../schema/well.ts";

export type OutputFormat = "csv" | "json";

function closeStream(stream: WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  const done = once(stream, "close").then(() => undefined);
  stream.end();
  return done;
}

/** JSON array written incrementally; always valid JSON once close() runs. */
export class JsonArrayWriter {
  private readonly stream: WriteStream;
  private first = true;
  private closed = false;

  constructor(readonly path: string) {
    this.stream = createWriteStream(path, { encoding: "utf8" });
    this.stream.write("[\n");
  }

  write(value: unknown): void {
    this.stream.write((this.first ? "" : ",\n") + JSON.stringify(value));
    this.first = false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stream.write(this.first ? "]\n" : "\n]\n");
    await closeStream(this.stream);
  }
}

/** One JSON object per line. */
export class JsonLinesWriter {
  private readonly stream: WriteStream;

  constructor(readonly path: string) {
    this.stream = createWriteStream(path, { encoding: "utf8" });
  }

  write(value: unknown): void {
    this.stream.write(`${JSON.stringify(value)}\n`);
  }

  close(): Promise<void> {
    return closeStream(this.stream);
  }
}

/** Streaming CSV: UTF-8 with BOM (Excel-friendly), header row; objects/arrays become JSON strings. */
export class CsvWriter {
  private readonly stringifier: Stringifier;
  private readonly stream: WriteStream;

  constructor(
    readonly path: string,
    readonly columns: string[],
  ) {
    this.stream = createWriteStream(path);
    this.stringifier = stringify({
      header: true,
      bom: true,
      columns,
      cast: {
        object: (v) => JSON.stringify(v),
        boolean: (v) => String(v),
      },
    });
    this.stringifier.pipe(this.stream);
  }

  write(row: Record<string, unknown>): void {
    this.stringifier.write(row);
  }

  async close(): Promise<void> {
    if (this.stream.closed) return;
    const done = once(this.stream, "close");
    this.stringifier.end();
    await done;
  }
}

export interface WellWriterOptions {
  formats: OutputFormat[];
  file: (name: string) => string;
  /** Columns to drop (e.g. owner_name with --no-owner). */
  omitFields?: string[];
}

/**
 * Writes normalized records to wells.csv / wells.json as they arrive, plus long-format
 * water_levels.csv and water_quality.csv (created on the first record that has such data).
 */
export class WellWriter {
  private readonly json?: JsonArrayWriter;
  private readonly csv?: CsvWriter;
  private levels?: CsvWriter;
  private quality?: CsvWriter;
  private readonly omit: Set<string>;
  readonly files: string[] = [];
  count = 0;

  constructor(private readonly opts: WellWriterOptions) {
    this.omit = new Set(opts.omitFields ?? []);
    const columns = WELL_FIELDS.filter((f) => !this.omit.has(f));
    if (opts.formats.includes("csv")) {
      this.csv = new CsvWriter(opts.file("wells.csv"), columns);
      this.files.push("wells.csv");
    }
    if (opts.formats.includes("json")) {
      this.json = new JsonArrayWriter(opts.file("wells.json"));
      this.files.push("wells.json");
    }
  }

  /** Apply --no-owner etc. Exposed so the report's field coverage matches the files. */
  project(record: WellRecord): Record<string, unknown> {
    if (!this.omit.size) return record;
    return Object.fromEntries(Object.entries(record).filter(([k]) => !this.omit.has(k)));
  }

  write(record: WellRecord): void {
    const out = this.project(record);
    this.json?.write(out);
    this.csv?.write(out);
    if (!this.opts.formats.includes("csv")) {
      this.count++;
      return;
    }
    for (const wl of record.water_levels) {
      this.levels ??= this.openLong("water_levels.csv", ["source_id", "date", "depth_to_water_ft", "method"]);
      this.levels.write({ source_id: record.source_id, ...wl });
    }
    for (const wq of record.water_quality) {
      this.quality ??= this.openLong("water_quality.csv", ["source_id", "date", "parameter", "value", "unit", "flag"]);
      this.quality.write({ source_id: record.source_id, ...wq });
    }
    this.count++;
  }

  private openLong(name: string, columns: string[]): CsvWriter {
    this.files.push(name);
    return new CsvWriter(this.opts.file(name), columns);
  }

  async close(): Promise<void> {
    await Promise.all([this.json?.close(), this.csv?.close(), this.levels?.close(), this.quality?.close()]);
  }
}
