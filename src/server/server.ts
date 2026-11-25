import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolveStateCode } from "../core/states.ts";
import { listDays, readRecords, type RecordFilter } from "../output/daily.ts";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10_000;
const PARAMS = new Set(["date", "from", "to", "state", "county", "limit", "offset"]);

class BadRequest extends Error {}

function day(name: string, value: string | null): string | undefined {
  if (value === null) return undefined;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : undefined;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new BadRequest(`${name} must be a valid YYYY-MM-DD date`);
  return value;
}

function int(name: string, value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < min || n > max) throw new BadRequest(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

function parseFilter(q: URLSearchParams): RecordFilter {
  for (const k of q.keys()) if (!PARAMS.has(k)) throw new BadRequest(`Unknown parameter "${k}". Use: ${[...PARAMS].join(", ")}`);
  const date = day("date", q.get("date"));
  const from = day("from", q.get("from"));
  const to = day("to", q.get("to"));
  if (date && (from || to)) throw new BadRequest("Use either date or from/to");
  if (from && to && from > to) throw new BadRequest("from must not be after to");
  const stateInput = q.get("state");
  const state = stateInput === null ? undefined : resolveStateCode(stateInput);
  if (state === null) throw new BadRequest(`Unknown state "${stateInput}"`);
  const countyFips = q.get("county") ?? undefined;
  if (countyFips !== undefined && !/^\d{5}$/.test(countyFips)) throw new BadRequest("county must be a 5-digit FIPS code");
  return { from: date ?? from, to: date ?? to, state, countyFips };
}

/** Read-only JSON API over stored runs. Binds to loopback: records can contain owner names. */
export async function startServer(out: string, port: number): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    const handle = async (): Promise<void> => {
      if (req.method !== "GET") return send(405, { error: "Only GET is supported" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const q = url.searchParams;
      if (url.pathname === "/days") return send(200, await listDays(out, parseFilter(q)));
      if (url.pathname === "/records") {
        const filter = parseFilter(q);
        const limit = int("limit", q.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
        const offset = int("offset", q.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
        return send(200, { limit, offset, ...(await readRecords(out, filter, limit, offset)) });
      }
      send(404, { error: "Not found. Use /records or /days" });
    };
    handle().catch((err: Error) => send(err instanceof BadRequest ? 400 : 500, { error: err instanceof BadRequest ? err.message : "Internal error" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
