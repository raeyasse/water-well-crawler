import pino, { type Logger, type Level } from "pino";
import pretty from "pino-pretty";

export type { Logger };

export const REDACTED = "[REDACTED]";

/** Object keys whose values are always redacted (specs/06). */
const SECRET_KEY = /password|passwd|token|secret|key|credential|cookie|authorization/i;
/** Keys that look sensitive by name but only ever hold key names, not values. */
const SAFE_KEYS = new Set(["missingKeys", "credentialsUsed", "keyNames"]);

/**
 * Holds secret values to scrub from every log line. Values are registered as credentials resolve;
 * any WELLS_* environment variable value is registered up front.
 */
export class SecretRegistry {
  private readonly values = new Set<string>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    for (const [k, v] of Object.entries(env)) if (k.startsWith("WELLS_") && v) this.add(v);
  }

  add(value: string): void {
    // Very short values would redact unrelated text; they still never appear because keys are redacted.
    if (value.length >= 3) this.values.add(value);
  }

  scrubString(s: string): string {
    let out = s;
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join(REDACTED);
    return out;
  }

  scrub(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return this.scrubString(value);
    if (value === null || typeof value !== "object" || depth > 8) return value;
    if (value instanceof Error) {
      return { type: value.name, message: this.scrubString(value.message), stack: value.stack && this.scrubString(value.stack) };
    }
    if (Array.isArray(value)) return value.map((v) => this.scrub(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && !SAFE_KEYS.has(k) && v !== undefined ? REDACTED : this.scrub(v, depth + 1);
    }
    return out;
  }
}

export interface LoggerOptions {
  level?: Level;
  /** JSON-lines log file; omitted for commands that write nothing (check, list-states). */
  file?: string;
  /** Pretty console output on stderr. Default true. */
  console?: boolean;
  secrets?: SecretRegistry;
  bindings?: Record<string, unknown>;
  /** Extra destination for tests. */
  stream?: NodeJS.WritableStream;
}

export interface RunLogger {
  log: Logger;
  secrets: SecretRegistry;
  flush(): void;
}

export function createLogger(opts: LoggerOptions = {}): RunLogger {
  const level = opts.level ?? "info";
  const secrets = opts.secrets ?? new SecretRegistry();
  const streams: pino.StreamEntry[] = [];
  let fileDest: pino.DestinationStream & { flushSync?: () => void } | undefined;

  if (opts.file) {
    fileDest = pino.destination({ dest: opts.file, sync: true, mkdir: true });
    streams.push({ level, stream: fileDest });
  }
  if (opts.console !== false) {
    streams.push({
      level,
      stream: pretty({
        destination: 2,
        sync: true,
        colorize: process.stderr.isTTY,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname,runId,state,countyFips,adapter",
        // Detail lives in run-log.jsonl; the console shows messages only unless debugging.
        hideObject: level !== "debug",
      }),
    });
  }
  if (opts.stream) streams.push({ level, stream: opts.stream });

  const log = pino(
    {
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      hooks: {
        // Scrub every argument (objects and message strings) before pino serializes it.
        logMethod(args, method) {
          const scrubbed = args.map((a) => secrets.scrub(a)) as Parameters<typeof method>;
          return method.apply(this, scrubbed);
        },
      },
    },
    pino.multistream(streams.length ? streams : [{ level, stream: { write: () => true } }]),
  ).child(opts.bindings ?? {});

  return {
    log,
    secrets,
    flush() {
      fileDest?.flushSync?.();
    },
  };
}
