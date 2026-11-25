import { writeFileSync } from "node:fs";

/** Run report (specs/08), written in `finally` as run-report.json and run-report.md. */

export type RunStatus = "success" | "partial" | "failed" | "blocked";

export interface RunCounts {
  siteReportedTotal: number | null;
  pagesVisited: number;
  recordsSeen: number;
  recordsWritten: number;
  duplicatesSkipped: number;
  invalid: number;
  documentsDownloaded: number;
  documentsFailed: number;
}

export interface ReportError {
  msg: string;
  name?: string;
  page?: number;
  screenshot?: string;
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  exitCode: number;
  input: { state: string; county: string };
  resolved: { state: string; county: string; fips: string };
  adapter: { name: string; version: string; lastVerified: string; sourceUrl: string };
  timing: { startedAt: string; endedAt: string; durationSec: number };
  counts: RunCounts;
  completeness: { expected: number | null; collected: number; percent: number | null };
  fieldCoverage: Record<string, number>;
  warnings: { msg: string; count: number }[];
  errors: ReportError[];
  notes: string[];
  credentialsUsed: string[];
  outputs: string[];
  environment: { tool: string; node: string; playwright: string; os: string };
}

export interface StatusInput {
  counts: Pick<RunCounts, "siteReportedTotal" | "recordsWritten">;
  errorCount: number;
  /** Error that ended the run, if any. */
  fatal?: { exitCode: number; blocked: boolean };
  aborted: boolean;
  maxRecordsHit: boolean;
}

export const COMPLETENESS_THRESHOLD = 99;

export function completenessPercent(expected: number | null, collected: number): number | null {
  if (expected === null) return null;
  if (expected === 0) return 100;
  return Math.round((collected / expected) * 10000) / 100;
}

/** Status and exit code rules from specs/08 + 03. */
export function computeStatus(input: StatusInput): { status: RunStatus; exitCode: number } {
  const { counts, fatal } = input;
  if (fatal?.blocked) return { status: "blocked", exitCode: 5 };
  if (fatal && counts.recordsWritten === 0) return { status: "failed", exitCode: fatal.exitCode === 4 ? 4 : 2 };

  const pct = completenessPercent(counts.siteReportedTotal, counts.recordsWritten);
  const incomplete = pct !== null && pct < COMPLETENESS_THRESHOLD;
  if (fatal || input.errorCount > 0 || input.aborted || input.maxRecordsHit || incomplete) {
    return { status: "partial", exitCode: 1 };
  }
  return { status: "success", exitCode: 0 };
}

const BADGE: Record<RunStatus, string> = {
  success: "✅ SUCCESS",
  partial: "⚠️ PARTIAL",
  failed: "❌ FAILED",
  blocked: "⛔ BLOCKED",
};

const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;

/** Short headline block shared by the console summary and the top of run-report.md. */
export function headline(r: RunReport): string[] {
  const total = r.counts.siteReportedTotal;
  return [
    `${BADGE[r.status]} — ${r.resolved.county}, ${r.resolved.state} (FIPS ${r.resolved.fips})`,
    `Records written: ${r.counts.recordsWritten}${total !== null ? ` of ${total} reported by site (${r.completeness.percent}%)` : " (site reported no total)"}`,
    `Duration: ${formatDuration(r.timing.durationSec)} · Exit code ${r.exitCode}`,
  ];
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

export function renderMarkdown(r: RunReport): string {
  const lines: string[] = [];
  const [title, ...rest] = headline(r);
  lines.push(`# ${title}`, "", ...rest.map((l) => `**${l}**  `), "", `Run \`${r.runId}\``, "");

  if (r.notes.length) lines.push(...r.notes.map((n) => `> ${n}`), "");

  lines.push("## Counts", "", "| Count | Value |", "|---|---|");
  for (const [k, v] of Object.entries(r.counts)) lines.push(`| ${k} | ${v ?? "—"} |`);
  lines.push(
    `| completeness | ${r.completeness.percent === null ? "—" : `${r.completeness.percent}%`} |`,
    "",
  );

  lines.push("## Field coverage", "", "Share of written records with a non-empty value.", "", "| Field | Coverage |", "|---|---|");
  const coverage = Object.entries(r.fieldCoverage);
  if (coverage.length) for (const [f, v] of coverage) lines.push(`| ${f} | ${pct(v)} |`);
  else lines.push("| (no records) | — |");
  lines.push("");

  lines.push("## Warnings and errors", "");
  if (!r.warnings.length && !r.errors.length) lines.push("None.", "");
  for (const w of r.warnings) lines.push(`- ⚠️ ${w.msg}${w.count > 1 ? ` (×${w.count})` : ""}`);
  for (const e of r.errors) {
    const where = e.page !== undefined ? ` (page ${e.page})` : "";
    const shot = e.screenshot ? ` — [screenshot](${e.screenshot})` : "";
    lines.push(`- ❌ ${e.name ? `${e.name}: ` : ""}${e.msg}${where}${shot}`);
  }
  if (r.warnings.length || r.errors.length) lines.push("");

  lines.push("## Output files", "", ...r.outputs.map((o) => `- [${o}](${o})`), "");

  lines.push(
    "## Adapter and environment",
    "",
    `- Adapter: ${r.adapter.name} v${r.adapter.version} (last verified ${r.adapter.lastVerified})`,
    `- Source: ${r.adapter.sourceUrl}`,
    `- Input: state \`${r.input.state}\`, county \`${r.input.county}\``,
    `- Credentials used: ${r.credentialsUsed.length ? r.credentialsUsed.join(", ") : "none"}`,
    `- Started ${r.timing.startedAt}, ended ${r.timing.endedAt}`,
    `- ${r.environment.tool} · Node ${r.environment.node} · Playwright ${r.environment.playwright} · ${r.environment.os}`,
    "",
  );
  return lines.join("\n");
}

export function writeReport(r: RunReport, file: (name: string) => string): void {
  writeFileSync(file("run-report.json"), `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync(file("run-report.md"), renderMarkdown(r));
}

/** Group warning messages with counts, preserving first-seen order. */
export class WarningTally {
  private readonly map = new Map<string, number>();
  add(msg: string): void {
    this.map.set(msg, (this.map.get(msg) ?? 0) + 1);
  }
  list(): { msg: string; count: number }[] {
    return [...this.map].map(([msg, count]) => ({ msg, count }));
  }
}

/** Tracks per-field non-null counts across written records. */
export class FieldCoverage {
  private readonly hits = new Map<string, number>();
  private total = 0;

  constructor(private readonly fields: string[]) {}

  add(record: Record<string, unknown>): void {
    this.total++;
    for (const f of this.fields) {
      const v = record[f];
      const present = Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && !(typeof v === "object" && Object.keys(v).length === 0);
      if (present) this.hits.set(f, (this.hits.get(f) ?? 0) + 1);
    }
  }

  result(): Record<string, number> {
    if (!this.total) return {};
    return Object.fromEntries(this.fields.map((f) => [f, Math.round(((this.hits.get(f) ?? 0) / this.total) * 1000) / 1000]));
  }
}
