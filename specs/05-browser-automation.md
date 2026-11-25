# 05 — Browser Automation (Playwright)

## Launch

- Chromium via Playwright, headless by default; `--headed` shows the window.
- One browser, one context, one page per run (no parallelism in v1).
- User agent: Playwright's default Chromium UA with an appended identifier, e.g. `... well-scraper/1.0 (+contact: <operator email from config>)`. The contact is optional but SHOULD be set.
- Viewport 1366×900, locale `en-US`, timezone from the OS.
- If the adapter requires auth, load the saved session (`storageState`, see 06) into the context before navigating.
- `--trace` enables `context.tracing` (screenshots + snapshots) saved as `trace.zip` in the run folder.

## Strategy: capture first, DOM second

SPAs load their data as JSON over XHR/fetch, then render it. Reading that JSON is more reliable than parsing rendered HTML, which changes with every front-end build.

1. **Capture**: before triggering a search, register a response listener filtered to the endpoint the adapter identified (URL pattern + `content-type: application/json`). Each matching response body is parsed and its records yielded.
   ```ts
   const results = ctx.capture.collect({ url: /\/query\?/, method: "GET" });
   await page.getByLabel("County").selectOption(county.name);
   await page.getByRole("button", { name: "Search" }).click();
   const batch = await results.next({ timeoutMs: 30_000 });
   ```
2. **DOM fallback**: if the site renders server-side or embeds data without a separate request, parse the results table/cards with locators. Wait for a specific "results loaded" signal (row count > 0, or a "no results" message), never fixed sleeps.

Helpers in `src/browser/capture.ts` and `helpers.ts`:

| Helper | Purpose |
|--------|---------|
| `capture.collect(filter)` | Async queue of parsed JSON bodies matching a filter |
| `waitForResults(page, {rows, empty})` | Resolves when either a results locator or empty-state locator appears |
| `paginate(page, opts)` | Generic loop for "next" button, numbered pages, or infinite scroll; stops when no next page, no new records, or abort |
| `safeClick(locator)` | Scroll into view, wait enabled, click, with retry (09) |
| `screenshotOnError(name)` | Saves PNG to `run/screenshots/` |

## SPA specifics to handle

- **Client-side routing**: wait on a locator or captured response, not on `load`/`networkidle` alone (SPAs keep connections open).
- **Lazy/virtualized tables**: only visible rows exist in the DOM. Prefer capture; otherwise scroll in steps and dedupe by `_sourceId`.
- **Map-based viewers (ArcGIS, Leaflet)**: county filtering is often a dropdown or a spatial query. Capture the feature-service `query` responses. ArcGIS servers paginate with `resultOffset`/`exceededTransferLimit`; follow the site's own paging.
- **Modals and cookie/disclaimer banners**: adapters handle any required "I agree to the terms" step explicitly and log that it was accepted. Cookie banners: choose the minimal/decline option.
- **iframes**: use `frameLocator`.
- **Downloads** (`--docs`): use `page.waitForEvent("download")` or fetch the document URL within the browser context so cookies apply. Save to `documents/<sourceId>/<filename>`.

## Politeness

- `ctx.politeWait()` between every navigation, search, and page turn; default 1500 ms plus 0–500 ms jitter.
- Check `robots.txt` at run start. If the path the adapter uses is disallowed, stop with exit 5 unless the operator passes `--ignore-robots` and the adapter README documents permission (e.g. agency guidance). Log the decision either way.
- Never more than one page-load in flight.
- On HTTP 429 or 503, back off (09) and honor `Retry-After`.

## Blocking detection

Treat as blocked and stop (exit 5): CAPTCHA widgets (reCAPTCHA, hCaptcha, Turnstile iframes), "access denied" / 403 on the landing page, or bot-challenge interstitials. Screenshot, log, and report. The tool never attempts to solve or evade these.
