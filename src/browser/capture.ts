import type { Page, Response } from "playwright";
import { TransientError } from "../core/errors.ts";
import { parseRetryAfter } from "../core/retry.ts";
import type { Logger } from "../logging/logger.ts";

export interface CaptureFilter {
  url: RegExp | string | ((url: string) => boolean);
  method?: string;
  /** Require a JSON content-type. Default true. */
  json?: boolean;
}

export interface CapturedResponse {
  url: string;
  status: number;
  body: unknown;
}

type Item = CapturedResponse | TransientError;

/** Async queue of parsed JSON bodies for responses matching one filter. */
export class CaptureQueue {
  private readonly items: Item[] = [];
  private waiters: ((item: Item) => void)[] = [];
  stopped = false;

  constructor(
    readonly filter: CaptureFilter,
    private readonly defaultTimeoutMs: number,
    private readonly onStop: (q: CaptureQueue) => void,
  ) {}

  /** @internal */
  push(item: Item): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  /** Next matching response; rejects with TransientError on timeout or a 429/5xx response. */
  next({ timeoutMs = this.defaultTimeoutMs }: { timeoutMs?: number } = {}): Promise<CapturedResponse> {
    const ready = this.items.shift();
    if (ready) return ready instanceof Error ? Promise.reject(ready) : Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const waiter = (item: Item): void => {
        clearTimeout(timer);
        if (item instanceof Error) reject(item);
        else resolve(item);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new TransientError(`No response matching ${describe(this.filter.url)} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** A response already received, without waiting. */
  tryNext(): CapturedResponse | undefined {
    const i = this.items.findIndex((x) => !(x instanceof Error));
    return i === -1 ? undefined : (this.items.splice(i, 1)[0] as CapturedResponse);
  }

  /** Discard anything buffered (e.g. before triggering a fresh request). */
  clear(): void {
    this.items.length = 0;
  }

  stop(): void {
    this.stopped = true;
    this.onStop(this);
  }
}

function describe(url: CaptureFilter["url"]): string {
  return typeof url === "function" ? "filter" : String(url);
}

function matches(filter: CaptureFilter, response: Response): boolean {
  const url = response.url();
  const { url: pattern } = filter;
  const urlOk = typeof pattern === "string" ? url.includes(pattern) : pattern instanceof RegExp ? pattern.test(url) : pattern(url);
  if (!urlOk) return false;
  if (filter.method && response.request().method() !== filter.method.toUpperCase()) return false;
  return true;
}

export interface CaptureOptions {
  log: Logger;
  defaultTimeoutMs: number;
  /** Called with every captured body (used by --keep-raw). */
  onBody?: (res: CapturedResponse) => void;
}

/** Listens to page responses and routes matching JSON bodies to collect() queues (specs/05). */
export class ResponseCapture {
  private readonly queues = new Set<CaptureQueue>();
  private attached = false;

  constructor(
    private readonly page: Page | undefined,
    private readonly opts: CaptureOptions,
  ) {}

  collect(filter: CaptureFilter): CaptureQueue {
    if (!this.page) throw new Error("capture is unavailable for adapters with usesBrowser: false");
    if (!this.attached) {
      this.page.on("response", (r) => void this.handle(r));
      this.attached = true;
    }
    const q = new CaptureQueue(filter, this.opts.defaultTimeoutMs, (x) => this.queues.delete(x));
    this.queues.add(q);
    return q;
  }

  private async handle(response: Response): Promise<void> {
    const targets = [...this.queues].filter((q) => matches(q.filter, response));
    if (!targets.length) return;
    const status = response.status();
    const url = response.url();

    if (status === 429 || status >= 500) {
      const err = new TransientError(`HTTP ${status} from ${url}`, parseRetryAfter(response.headers()["retry-after"]));
      this.opts.log.debug({ event: "capture.response", url, status }, "capture.response");
      for (const q of targets) q.push(err);
      return;
    }

    const contentType = response.headers()["content-type"] ?? "";
    const wantJson = targets.some((q) => q.filter.json !== false);
    if (wantJson && !/json/i.test(contentType)) return;

    let body: unknown;
    try {
      body = /json/i.test(contentType) ? await response.json() : await response.text();
    } catch (err) {
      this.opts.log.debug({ event: "capture.unreadable", url, err: String(err) }, "capture.unreadable");
      return;
    }
    const captured = { url, status, body };
    this.opts.log.debug({ event: "capture.response", url, status, records: countRecords(body) }, "capture.response");
    this.opts.onBody?.(captured);
    for (const q of targets) q.push(captured);
  }
}

/** Best-effort record count for the log: first array found at the top level or one level down. */
function countRecords(body: unknown): number | undefined {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body === "object") {
    for (const v of Object.values(body)) if (Array.isArray(v)) return v.length;
  }
  return undefined;
}
