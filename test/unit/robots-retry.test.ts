import { describe, expect, it, vi } from "vitest";
import { BlockedError, TransientError } from "../../src/core/errors.ts";
import { parseRetryAfter, retry } from "../../src/core/retry.ts";
import { isAllowed } from "../../src/core/robots.ts";

describe("robots.txt", () => {
  const txt = `
User-agent: *
Disallow: /private/
Allow: /private/public-wells
Disallow: /*.pdf$

User-agent: well-scraper
User-agent: other
Disallow: /search
`;
  it("applies the most specific rule for the wildcard group", () => {
    expect(isAllowed(txt, "SomeBot", "/wells")).toBe(true);
    expect(isAllowed(txt, "SomeBot", "/private/x")).toBe(false);
    expect(isAllowed(txt, "SomeBot", "/private/public-wells/1")).toBe(true);
    expect(isAllowed(txt, "SomeBot", "/a/b.pdf")).toBe(false);
    expect(isAllowed(txt, "SomeBot", "/a/b.pdf?x")).toBe(true);
  });
  it("uses a named group when the agent matches", () => {
    expect(isAllowed(txt, "well-scraper", "/search")).toBe(false);
    expect(isAllowed(txt, "well-scraper", "/private/x")).toBe(true);
  });
  it("empty robots allows everything", () => expect(isAllowed("", "x", "/")).toBe(true));
});

describe("retry", () => {
  const noSleep = vi.fn(async () => {});

  it("retries transient errors with backoff and honors Retry-After", async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await retry(
      async () => {
        if (++n < 3) throw new TransientError("503", n === 2 ? 10_000 : undefined);
        return "ok";
      },
      { baseMs: 100, jitter: false, sleep: noSleep, onRetry: ({ waitMs }) => waits.push(waitMs) },
    );
    expect(out).toBe("ok");
    expect(waits).toEqual([100, 10_000]);
  });

  it("does not retry non-transient errors", async () => {
    let n = 0;
    await expect(retry(async () => { n++; throw new BlockedError("captcha"); }, { sleep: noSleep })).rejects.toThrow(BlockedError);
    expect(n).toBe(1);
  });

  it("gives up after the attempt limit", async () => {
    let n = 0;
    await expect(retry(async () => { n++; throw new TransientError("x"); }, { attempts: 3, sleep: noSleep })).rejects.toThrow("x");
    expect(n).toBe(3);
  });

  it("parseRetryAfter handles seconds and dates", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});
