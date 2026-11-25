import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * A tiny fake well-records SPA (specs/10, layer 3). Static HTML + JS that fetches paginated JSON,
 * with optional login, CAPTCHA-like widget, flaky 503s, and a DOM-only mode (no JSON responses).
 */

export interface FakeSpaOptions {
  port?: number;
  /** Wells per county (Wake). Other counties get fewer. */
  totalWells?: number;
  pageSize?: number;
  requireAuth?: boolean;
  username?: string;
  password?: string;
  captcha?: boolean;
  /** First request for this page number returns 503 (with Retry-After: 0). */
  flaky503Page?: number;
  /** Results arrive as HTML fragments instead of JSON (exercises the DOM fallback). */
  domOnly?: boolean;
  robotsDisallow?: boolean;
  /** Delay before each API response, ms. */
  latencyMs?: number;
}

export interface FakeSpa {
  url: string;
  stats: { wellRequests: number; logins: number; failed503: number };
  close(): Promise<void>;
}

const COUNTIES = [
  { fips: "37183", name: "Wake County" },
  { fips: "37135", name: "Orange County" },
  { fips: "37063", name: "Durham County" },
];

const USES = ["Domestic", "Domestic", "Irrigation", "Monitoring", "Public Supply", "Geothermal", "Test Hole"];
const STATUSES = ["Active", "Active", "Active", "Abandoned", "Plugged", "Inactive?"];

export function countyWellCount(fips: string, total: number): number {
  if (fips === "37183") return total;
  if (fips === "37135") return 7;
  return 0;
}

/**
 * Deterministic wells. Quirks on purpose: well #13 has no ID (invalid), well #21 has 0,0 coordinates
 * (out of bounds), every 9th depth is in meters, and pages overlap by one record (duplicates).
 */
export function makeWell(fips: string, i: number): Record<string, unknown> {
  const id = `${fips}-${String(i).padStart(4, "0")}`;
  const meters = i % 9 === 0;
  return {
    WellID: i === 13 ? "" : id,
    PermitNo: `P${fips.slice(2)}${String(i * 7).padStart(5, "0")}`,
    OwnerName: `Owner ${i}`,
    DrillerName: ["Acme Drilling", "Tar Heel Wells", "Piedmont Pump"][i % 3],
    DrillerLicense: `DL-${1000 + (i % 3)}`,
    WellUse: USES[i % USES.length],
    Status: STATUSES[i % STATUSES.length],
    Latitude: i === 21 ? 0 : 35.6 + ((i * 37) % 400) / 1000,
    Longitude: i === 21 ? 0 : -78.9 + ((i * 53) % 600) / 1000,
    LocationMethod: i % 4 === 0 ? "Address geocoded" : "GPS",
    Address: `${100 + i} Well Rd`,
    DateCompleted: `${(i % 12) + 1}/${(i % 27) + 1}/${1985 + (i % 38)}`,
    TotalDepth: meters ? Math.round(30 + (i % 50)) : 120 + ((i * 11) % 380),
    DepthUnits: meters ? "m" : "ft",
    CasingDepthFt: 40 + (i % 60),
    CasingDiamIn: [4, 6, 6, 8][i % 4],
    CasingMaterial: i % 2 ? "PVC" : "Steel",
    StaticWaterLevelFt: 10 + (i % 40),
    YieldGPM: i % 5 === 0 ? null : 5 + (i % 25),
    Aquifer: i % 3 === 0 ? "Crystalline bedrock" : null,
    HasLog: i % 10 === 0,
    WaterLevels: i % 15 === 0 ? [{ date: "2020-05-01", depth_ft: 22.5 }, { date: "2023-05-01", depth_ft: 24.1 }] : [],
    BasinCode: `B${i % 4}`,
  };
}

function pageOf(fips: string, page: number, total: number, pageSize: number) {
  const n = countyWellCount(fips, total);
  const pages = Math.max(1, Math.ceil(n / pageSize));
  // Each page after the first repeats the previous page's last well (overlap → duplicate).
  const start = (page - 1) * pageSize + 1;
  const ids = [];
  if (page > 1 && start - 1 >= 1) ids.push(start - 1);
  for (let i = start; i <= Math.min(page * pageSize, n); i++) ids.push(i);
  return { total: n, page, pages, pageSize, wells: ids.map((i) => makeWell(fips, i)) };
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function renderRows(data: ReturnType<typeof pageOf>): string {
  return data.wells
    .map((w) => `<tr><td><a href="/well/${esc(w.WellID)}">${esc(w.WellID)}</a></td><td>${esc(w.PermitNo)}</td><td>${esc(w.OwnerName)}</td><td>${esc(w.WellUse)}</td><td>${esc(w.Status)}</td><td>${esc(w.TotalDepth)}${w.DepthUnits === "m" ? " m" : ""}</td><td>${esc(w.DateCompleted)}</td></tr>`)
    .join("");
}

function appHtml(o: Required<Pick<FakeSpaOptions, "captcha" | "domOnly" | "requireAuth">>): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Demo Well Records</title>
<style>body{font-family:sans-serif;margin:2rem}dialog{padding:1.5rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>
</head><body>
<h1>Demo Well Records</h1>
${o.captcha ? '<div class="g-recaptcha" data-sitekey="fake-key">Please verify you are human</div>' : ""}
<div id="app">Loading…</div>
<script>
const DOM_ONLY = ${o.domOnly};
const REQUIRE_AUTH = ${o.requireAuth};
const app = document.getElementById("app");
let county = "", page = 1;

async function boot() {
  if (REQUIRE_AUTH) {
    const me = await fetch("/api/me");
    if (me.status !== 200) return showLogin();
  }
  showDisclaimer();
}

function showLogin(error) {
  app.innerHTML = '<form id="login"><h2>Sign in</h2>' +
    (error ? '<p role="alert">' + error + '</p>' : '') +
    '<label>Username <input id="u" autocomplete="username"></label> ' +
    '<label>Password <input id="p" type="password"></label> ' +
    '<button type="submit">Sign in</button></form>';
  document.getElementById("login").onsubmit = async (e) => {
    e.preventDefault();
    const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: document.getElementById("u").value, password: document.getElementById("p").value }) });
    if (r.status === 200) showDisclaimer(); else showLogin("Invalid username or password");
  };
}

const signOutButton = () => REQUIRE_AUTH ? '<button id="signout">Sign out</button>' : '';
function wireSignOut() {
  const so = document.getElementById("signout");
  if (so) so.onclick = async () => { await fetch("/api/logout", { method: "POST" }); showLogin(); };
}

function showDisclaimer() {
  app.innerHTML = signOutButton() + '<dialog open aria-label="Terms of use"><p>These records are provided as-is.</p><button id="agree">I Agree</button></dialog>';
  wireSignOut();
  document.getElementById("agree").onclick = () => setTimeout(showSearch, 150);
}

async function showSearch() {
  const counties = await (await fetch("/api/counties")).json();
  app.innerHTML = signOutButton() +
    '<p><label for="county">County</label> <select id="county"><option value="">Select…</option>' +
    counties.map(c => '<option value="' + c.fips + '">' + c.name + '</option>').join("") +
    '</select> <button id="search">Search</button></p><div id="results"></div>';
  document.getElementById("search").onclick = () => { county = document.getElementById("county").value; page = 1; load(); };
  wireSignOut();
}

async function load() {
  const results = document.getElementById("results");
  results.innerHTML = "<p>Loading…</p>";
  const r = await fetch("/api/wells?county=" + county + "&page=" + page + (DOM_ONLY ? "&format=html" : ""));
  if (!r.ok) {
    results.innerHTML = '<p>Error loading page ' + page + '.</p><button id="retry">Retry</button>';
    document.getElementById("retry").onclick = load;
    return;
  }
  let total, pages, rowsHtml;
  if (DOM_ONLY) {
    const html = await r.text();
    const tpl = document.createElement("template"); tpl.innerHTML = html;
    const body = tpl.content.firstElementChild;
    total = +body.dataset.total; pages = +body.dataset.pages; rowsHtml = body.innerHTML;
  } else {
    const d = await r.json();
    total = d.total; pages = d.pages;
    rowsHtml = d.wells.map(w => '<tr><td><a href="/well/' + w.WellID + '">' + w.WellID + '</a></td><td>' + w.PermitNo + '</td><td>' + w.OwnerName +
      '</td><td>' + w.WellUse + '</td><td>' + w.Status + '</td><td>' + w.TotalDepth + (w.DepthUnits === "m" ? " m" : "") + '</td><td>' + w.DateCompleted + '</td></tr>').join("");
  }
  // Render on a later tick, like a real SPA re-render.
  setTimeout(() => {
    if (total === 0) { results.innerHTML = "<p>No wells found</p>"; return; }
    results.innerHTML = '<table><caption>' + total + ' wells found</caption><thead><tr><th>Well ID</th><th>Permit</th><th>Owner</th><th>Use</th><th>Status</th><th>Depth</th><th>Completed</th></tr></thead><tbody>' +
      rowsHtml + '</tbody></table><p>Page ' + page + ' of ' + pages + '</p><button id="next"' + (page >= pages ? ' disabled' : '') + '>Next</button>';
    document.getElementById("next").onclick = () => { page++; load(); };
  }, 50);
}

boot();
</script></body></html>`;
}

export async function startFakeSpa(opts: FakeSpaOptions = {}): Promise<FakeSpa> {
  const o = {
    totalWells: 137,
    pageSize: 25,
    requireAuth: false,
    username: "demo",
    password: "s3cret-pass",
    captcha: false,
    domOnly: false,
    robotsDisallow: false,
    latencyMs: 0,
    ...opts,
  };
  const stats = { wellRequests: 0, logins: 0, failed503: 0 };
  const sessions = new Set<string>();
  let flakyUsed = false;

  const authed = (req: IncomingMessage): boolean => {
    const sid = req.headers.cookie?.match(/sid=([a-z0-9]+)/)?.[1];
    return !!sid && sessions.has(sid);
  };

  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": type, ...headers });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void =>
    send(res, status, "application/json; charset=utf-8", JSON.stringify(value), headers);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/") && o.latencyMs) await new Promise((r) => setTimeout(r, o.latencyMs));

    if (url.pathname === "/robots.txt") {
      return send(res, 200, "text/plain", o.robotsDisallow ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nAllow: /\n");
    }
    if (url.pathname === "/" || url.pathname.startsWith("/well/")) {
      return send(res, 200, "text/html; charset=utf-8", appHtml(o));
    }
    if (url.pathname === "/api/me") {
      return authed(req) ? json(res, 200, { user: o.username }) : json(res, 401, { error: "signed out" });
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { username, password } = JSON.parse(body || "{}");
      if (username === o.username && password === o.password) {
        stats.logins++;
        const sid = Math.random().toString(36).slice(2);
        sessions.add(sid);
        return json(res, 200, { ok: true }, { "set-cookie": `sid=${sid}; Path=/; HttpOnly; Max-Age=3600` });
      }
      return json(res, 401, { error: "invalid" });
    }
    if (url.pathname === "/api/logout") {
      return json(res, 200, { ok: true }, { "set-cookie": "sid=; Path=/; Max-Age=0" });
    }
    if (o.requireAuth && url.pathname.startsWith("/api/") && !authed(req)) {
      return json(res, 401, { error: "signed out" });
    }
    if (url.pathname === "/api/counties") return json(res, 200, COUNTIES);
    if (url.pathname === "/api/wells") {
      stats.wellRequests++;
      const fips = url.searchParams.get("county") ?? "";
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      if (o.flaky503Page === page && !flakyUsed) {
        flakyUsed = true;
        stats.failed503++;
        return json(res, 503, { error: "try later" }, { "retry-after": "0" });
      }
      const data = pageOf(fips, page, o.totalWells, o.pageSize);
      if (url.searchParams.get("format") === "html") {
        return send(res, 200, "text/html; charset=utf-8", `<tbody data-total="${data.total}" data-pages="${data.pages}">${renderRows(data)}</tbody>`);
      }
      return json(res, 200, data);
    }
    const doc = url.pathname.match(/^\/docs\/(.+)\.pdf$/);
    if (doc) return send(res, 200, "application/pdf", Buffer.from(`%PDF-1.4\n% fake well log for ${doc[1]}\n%%EOF\n`));
    send(res, 404, "text/plain", "not found");
  });

  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// `npm run fake-spa` serves the demo site for manual runs with --adapter demo.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const auth = process.argv.includes("--auth");
  const spa = await startFakeSpa({ port: Number(process.env.PORT ?? 4599), requireAuth: auth });
  process.stderr.write(`Fake well SPA at ${spa.url}${auth ? " (login: demo / s3cret-pass)" : ""}\n`);
}
