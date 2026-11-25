import { SiteChangedError } from "../../core/errors.ts";
import { LAYER_URL, PORTAL_URL } from "./service.ts";
import type { ScrapeContext } from "../types.ts";

/** What the state's dataset page currently publishes. */
export interface CaSources {
  itemId?: string;
  csvUrl?: string;
}

const agencyHost = (url: string): boolean => {
  const u = new URL(url);
  return u.protocol === "https:" && /(^|\.)(ca\.gov|arcgis\.com)$/.test(u.hostname);
};

/** Find the ArcGIS item and the well-completion-report CSV among a dataset page's links. */
export function findSources(links: string[]): CaSources {
  const ok = links.filter((l) => URL.canParse(l) && agencyHost(l));
  return {
    itemId: ok.map((l) => l.match(/arcgis\.com\/home\/item\.html\?(?:.*&)?id=([0-9a-f]{32})/)?.[1]).find(Boolean),
    csvUrl: ok.find((l) => /\/download\/wellcompletionreports\.csv$/i.test(new URL(l).pathname)),
  };
}

export async function discoverFromPage(ctx: ScrapeContext): Promise<CaSources> {
  const html = await ctx.fetchText(PORTAL_URL);
  return findSources([...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&")));
}

/** Resolve an ArcGIS item to its current service layer. */
export async function layerForItem(ctx: ScrapeContext, itemId: string): Promise<string> {
  const itemUrl = `https://www.arcgis.com/sharing/rest/content/items/${itemId}`;
  await ctx.assertRobots(itemUrl);
  const item = await ctx.fetchJson<{ url?: string }>(itemUrl, { f: "json" });
  if (!item.url || !URL.canParse(item.url) || !agencyHost(item.url)) throw new SiteChangedError(`ArcGIS item ${itemId} has no service URL`);
  const layer = /\/\d+$/.test(item.url) ? item.url : `${item.url.replace(/\/$/, "")}/0`;
  await ctx.assertRobots(layer);
  return layer;
}

/** Current layer URL; falls back to the last known one so a portal outage doesn't stop the API method. */
export async function discoverLayer(ctx: ScrapeContext, find: (ctx: ScrapeContext) => Promise<CaSources>): Promise<string> {
  try {
    const { itemId } = await find(ctx);
    if (!itemId) throw new SiteChangedError("dataset page lists no ArcGIS service");
    const layer = await layerForItem(ctx, itemId);
    ctx.log.info({ event: "source.discovered", url: layer }, `Discovered ${layer}`);
    return layer;
  } catch (err) {
    ctx.log.warn({ event: "source.fallback", url: LAYER_URL, error: (err as Error).message }, `Source discovery failed (${(err as Error).message}); using the last known service`);
    await ctx.assertRobots(LAYER_URL);
    return LAYER_URL;
  }
}
