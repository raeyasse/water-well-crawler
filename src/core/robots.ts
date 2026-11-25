/** Minimal robots.txt evaluation (longest-match Allow/Disallow, `*` and `$` wildcards). */

interface Group {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      if (value !== "") current.rules.push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function ruleMatches(rulePath: string, path: string): boolean {
  const anchored = rulePath.endsWith("$");
  const pattern = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
}

/** Is `path` allowed for `agent`? Uses the most specific matching group, else `*`. */
export function isAllowed(robotsTxt: string, agent: string, path: string): boolean {
  const groups = parseRobots(robotsTxt);
  const a = agent.toLowerCase();
  const group = groups.find((g) => g.agents.some((x) => x !== "*" && a.includes(x))) ?? groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; path: string } | undefined;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

export interface RobotsResult {
  url: string;
  allowed: boolean;
  disallowedPaths: string[];
  /** robots.txt could not be fetched (treated as allowed). */
  unavailable?: string;
}

/**
 * Check each path against robots.txt. Paths may be absolute URLs on other hosts (e.g. an API host);
 * each origin's robots.txt is checked. A missing robots.txt allows everything.
 */
export async function checkRobots(sourceUrl: string, paths: string[], userAgent: string, fetchFn: typeof fetch = fetch): Promise<RobotsResult> {
  const byOrigin = new Map<string, string[]>();
  for (const p of paths) {
    const u = new URL(p, sourceUrl);
    byOrigin.set(u.origin, [...(byOrigin.get(u.origin) ?? []), u.pathname]);
  }
  const results = await Promise.all([...byOrigin].map(([origin, ps]) => checkOrigin(origin, ps, userAgent, fetchFn)));
  return {
    url: results.map((r) => r.url).join(", "),
    allowed: results.every((r) => r.allowed),
    disallowedPaths: results.flatMap((r) => r.disallowedPaths),
    unavailable: results.some((r) => r.unavailable) ? results.map((r) => r.unavailable).filter(Boolean).join("; ") : undefined,
  };
}

async function checkOrigin(origin: string, paths: string[], userAgent: string, fetchFn: typeof fetch): Promise<RobotsResult> {
  const url = new URL("/robots.txt", origin).toString();
  let text: string;
  try {
    const res = await fetchFn(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { url, allowed: true, disallowedPaths: [], unavailable: `HTTP ${res.status}` };
    // Some hosts redirect /robots.txt to an HTML page: that means no robots rules.
    if (/html/i.test(res.headers.get("content-type") ?? "")) return { url, allowed: true, disallowedPaths: [], unavailable: "no robots.txt (HTML page)" };
    text = await res.text();
  } catch (err) {
    return { url, allowed: true, disallowedPaths: [], unavailable: String(err) };
  }
  const disallowedPaths = paths.filter((p) => !isAllowed(text, "well-scraper", p));
  return { url, allowed: disallowedPaths.length === 0, disallowedPaths };
}
