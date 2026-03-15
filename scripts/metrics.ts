#!/usr/bin/env node
/* eslint-disable complexity, max-lines -- standalone CLI script, not library code */
// Workflow metrics — parses Gitea comments and git history to produce
// trend data on review quality, round counts, and finding patterns.
// Usage: node scripts/metrics.ts [--since <pr-number>] [--json] [--reviews-dirs <dir1> <dir2> ...]
// Output: markdown to .claude/workflow-stats.md + stdout (or JSON with --json).
// Reads yolo dispatch DB for timing/cost data if available.

import { giteaSafe, parseLinkedIssue, parseComments } from "./lib.ts";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// --- CLI args ---
const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const sinceIdx = args.indexOf("--since");
const sincePr = sinceIdx !== -1 ? parseInt(args[sinceIdx + 1], 10) : 0;

// --reviews-dirs <dir1> <dir2> ... — optional extra directories containing review retrospective files.
// Consumes all remaining args after --reviews-dirs until the next flag (--*) or end of args.
const reviewsDirsIdx = args.indexOf("--reviews-dirs");
const extraReviewsDirs: string[] = [];
if (reviewsDirsIdx !== -1) {
  for (let i = reviewsDirsIdx + 1; i < args.length; i++) {
    if (args[i].startsWith("--")) break;
    extraReviewsDirs.push(resolve(args[i]));
  }
}

// --- Types ---
interface PRMetrics {
  pr: number;
  issue: number | null;
  title: string;
  reviewRounds: number;
  specReviewRounds: number;
  totalBlockingFindings: number;
  totalSuggestionFindings: number;
  findingsByCategory: Record<string, number>;
  disputedFindings: number;
  firstReviewDate: string | null;
  mergeDate: string | null;
  timeToMergeHours: number | null;
}

interface AggregateMetrics {
  totalPRs: number;
  avgReviewRounds: number;
  medianReviewRounds: number;
  avgSpecReviewRounds: number;
  avgBlockingFindings: number;
  avgTimeToMergeHours: number | null;
  firstRoundApproveRate: number;
  findingCategoryTotals: Record<string, number>;
  disputeRate: number;
  trendByWindow: TrendWindow[];
  retrospectiveSummary: RetroSummary;
}

interface TrendWindow {
  label: string;
  prs: number;
  avgRounds: number;
  avgBlocking: number;
  firstRoundApproveRate: number;
}

interface RetroSummary {
  totalFiles: number;
  bySkill: Record<string, number>;
  topPromptFixes: string[];
}

// --- Yolo dispatch types ---
interface DispatchRow {
  command: string;
  agent: string;
  issue_number: number;
  duration_ms: number | null;
  cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  success: number;
  started_at: string;
}

interface SkillStats {
  skill: string;
  invocations: number;
  avgDurationMin: number;
  totalCost: number;
  avgTokensK: number;
  successRate: number;
}

interface IssueCostSummary {
  issue: number;
  totalCost: number;
  totalDurationMin: number;
  totalTokensK: number;
  dispatches: number;
  reviewRounds: number;
}

const YOLO_DB_PATH = join(ROOT, "..", "narrator-yolo", "data", "narrator-yolo.db");

// --- Read yolo dispatches (uses node subprocess to access better-sqlite3 from yolo's node_modules) ---
function readYoloDispatches(): DispatchRow[] | null {
  if (!existsSync(YOLO_DB_PATH)) return null;

  const yoloRoot = resolve(ROOT, "..", "narrator-yolo");
  const query = `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { readonly: true });
    const rows = db.prepare('SELECT command, agent, issue_number, duration_ms, cost, input_tokens, output_tokens, success, started_at FROM dispatches ORDER BY started_at').all();
    console.log(JSON.stringify(rows));
  `;

  try {
    const result = execFileSync("node", ["-e", query, YOLO_DB_PATH], {
      encoding: "utf-8",
      cwd: yoloRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(result.trim());
  } catch {
    return null;
  }
}

function parseSkillName(command: string): string {
  // "/implement 329" → "implement", "$review-pr 338" → "review-pr"
  return command.replace(/^[/$]/, "").replace(/\s+\d+$/, "");
}

function computeSkillStats(dispatches: DispatchRow[]): SkillStats[] {
  const bySkill = new Map<string, DispatchRow[]>();
  for (const d of dispatches) {
    const skill = parseSkillName(d.command);
    if (!bySkill.has(skill)) bySkill.set(skill, []);
    bySkill.get(skill)!.push(d);
  }

  const stats: SkillStats[] = [];
  for (const [skill, rows] of bySkill) {
    const withDuration = rows.filter(r => r.duration_ms && r.duration_ms > 100);
    const withTokens = rows.filter(r => r.input_tokens);
    const avgDur = withDuration.length > 0
      ? withDuration.reduce((a, r) => a + r.duration_ms!, 0) / withDuration.length / 60000
      : 0;
    const totalCost = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
    const avgTokens = withTokens.length > 0
      ? withTokens.reduce((a, r) => a + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0) / withTokens.length / 1000
      : 0;
    const successRate = rows.length > 0
      ? rows.filter(r => r.success).length / rows.length * 100
      : 0;

    stats.push({
      skill,
      invocations: rows.length,
      avgDurationMin: Math.round(avgDur * 10) / 10,
      totalCost: Math.round(totalCost * 100) / 100,
      avgTokensK: Math.round(avgTokens),
      successRate: Math.round(successRate),
    });
  }

  return stats.sort((a, b) => b.invocations - a.invocations);
}

function computeIssueCosts(dispatches: DispatchRow[]): IssueCostSummary[] {
  const byIssue = new Map<number, DispatchRow[]>();
  for (const d of dispatches) {
    if (!d.issue_number) continue;
    if (!byIssue.has(d.issue_number)) byIssue.set(d.issue_number, []);
    byIssue.get(d.issue_number)!.push(d);
  }

  const summaries: IssueCostSummary[] = [];
  for (const [issue, rows] of byIssue) {
    const totalCost = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
    const totalDur = rows.filter(r => r.duration_ms).reduce((a, r) => a + (r.duration_ms ?? 0), 0) / 60000;
    const totalTokens = rows.reduce((a, r) => a + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0) / 1000;
    const reviewRounds = rows.filter(r => parseSkillName(r.command).includes("review-pr")).length;

    summaries.push({
      issue,
      totalCost: Math.round(totalCost * 100) / 100,
      totalDurationMin: Math.round(totalDur * 10) / 10,
      totalTokensK: Math.round(totalTokens),
      dispatches: rows.length,
      reviewRounds,
    });
  }

  return summaries.sort((a, b) => b.totalCost - a.totalCost);
}

// --- Parse findings JSON from a review comment body ---
function parseFindings(body: string): Array<{ id: string; severity: string; category: string }> {
  const jsonMatch = body.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((f: Record<string, unknown>) => ({
      id: String(f.id ?? ""),
      severity: String(f.severity ?? ""),
      category: String(f.category ?? ""),
    }));
  } catch {
    return [];
  }
}

// --- Parse response dispositions ---
function parseDispositions(body: string): Array<{ finding: string; resolution: string }> {
  const dispositions: Array<{ finding: string; resolution: string }> = [];
  const rows = body.matchAll(/\|\s*(F\d+\w*)\s*\|[^|]*\|\s*(\w+)\s*\|/g);
  for (const m of rows) {
    dispositions.push({ finding: m[1], resolution: m[2].toLowerCase() });
  }
  return dispositions;
}

// --- Collect PR metrics ---
function collectPRMetrics(prOutput: string, prNumber: number): PRMetrics | null {
  const titleMatch = prOutput.match(/^#\d+\s+\[\w+\]\s+(.+)$/m);
  const title = titleMatch?.[1] ?? `PR #${prNumber}`;
  const linkedIssue = parseLinkedIssue(prOutput);
  const issue = linkedIssue ? parseInt(linkedIssue, 10) : null;

  // Fetch PR comments
  const { ok, output: commentsRaw } = giteaSafe("pr-comments", String(prNumber));
  if (!ok) return null;

  const comments = parseComments(commentsRaw);

  // Count PR review rounds (## Verdict: in pr_reviewer comments)
  const verdicts = comments.filter(c => c.body.includes("## Verdict:"));
  const reviewRounds = verdicts.length;

  // Count spec review rounds (from linked issue)
  let specReviewRounds = 0;
  if (issue) {
    const { ok: issueOk, output: issueComments } = giteaSafe("issue-comments", String(issue));
    if (issueOk) {
      const iComments = parseComments(issueComments);
      specReviewRounds = iComments.filter(c => c.body.includes("## Spec Review") && c.body.includes("## Verdict:")).length;
    }
  }

  // Aggregate findings across all review rounds
  let totalBlocking = 0;
  let totalSuggestion = 0;
  let disputed = 0;
  const categoryTotals: Record<string, number> = {};

  for (const v of verdicts) {
    const findings = parseFindings(v.body);
    for (const f of findings) {
      if (f.severity === "blocking") totalBlocking++;
      else if (f.severity === "suggestion") totalSuggestion++;
      if (f.category) categoryTotals[f.category] = (categoryTotals[f.category] ?? 0) + 1;
    }
  }

  // Count disputed findings from response comments
  const responses = comments.filter(c => c.body.includes("## Review Response"));
  for (const r of responses) {
    const disps = parseDispositions(r.body);
    disputed += disps.filter(d => d.resolution === "disputed").length;
  }

  // Timing
  const firstReviewDate = verdicts.length > 0 ? verdicts[0].date : null;
  const lastVerdict = verdicts.length > 0 ? verdicts[verdicts.length - 1] : null;
  const mergeDate = lastVerdict?.body.includes("## Verdict: approve") ? lastVerdict.date : null;

  let timeToMergeHours: number | null = null;
  if (firstReviewDate && mergeDate) {
    const diff = new Date(mergeDate).getTime() - new Date(firstReviewDate).getTime();
    timeToMergeHours = Math.round((diff / (1000 * 60 * 60)) * 10) / 10;
  }

  return {
    pr: prNumber,
    issue,
    title,
    reviewRounds,
    specReviewRounds,
    totalBlockingFindings: totalBlocking,
    totalSuggestionFindings: totalSuggestion,
    findingsByCategory: categoryTotals,
    disputedFindings: disputed,
    firstReviewDate,
    mergeDate,
    timeToMergeHours,
  };
}

// --- Read retrospective files ---
function readRetrospectives(additionalDirs: string[] = []): RetroSummary {
  const localDir = join(ROOT, ".claude", "cl", "reviews");
  const allDirs = [localDir, ...additionalDirs].filter(d => existsSync(d));

  if (allDirs.length === 0) return { totalFiles: 0, bySkill: {}, topPromptFixes: [] };

  const bySkill: Record<string, number> = {};
  const promptFixes: string[] = [];
  let totalFiles = 0;

  for (const dir of allDirs) {
    const files = readdirSync(dir).filter(f => f.endsWith(".md"));
    console.error(`  ${dir}: ${files.length} files`);
    totalFiles += files.length;

    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");

      // Parse skill from frontmatter
      const skillMatch = content.match(/^skill:\s*(.+)$/m);
      if (skillMatch) {
        const skill = skillMatch[1].trim();
        bySkill[skill] = (bySkill[skill] ?? 0) + 1;
      }

      // Extract prompt fix suggestions
      const fixMatches = content.matchAll(/\*\*Prompt fix:\*\*\s*(.+?)(?:\n###|\n---|\n$|$)/gs);
      for (const m of fixMatches) {
        const fix = m[1].trim();
        if (fix && fix.length > 10) promptFixes.push(fix);
      }
    }
  }

  return { totalFiles, bySkill, topPromptFixes: promptFixes.slice(0, 10) };
}

// --- Compute aggregates ---
function computeAggregates(prs: PRMetrics[]): AggregateMetrics {
  const reviewed = prs.filter(p => p.reviewRounds > 0);
  if (reviewed.length === 0) {
    return {
      totalPRs: prs.length,
      avgReviewRounds: 0,
      medianReviewRounds: 0,
      avgSpecReviewRounds: 0,
      avgBlockingFindings: 0,
      avgTimeToMergeHours: null,
      firstRoundApproveRate: 0,
      findingCategoryTotals: {},
      disputeRate: 0,
      trendByWindow: [],
      retrospectiveSummary: readRetrospectives(extraReviewsDirs),
    };
  }

  const rounds = reviewed.map(p => p.reviewRounds);
  rounds.sort((a, b) => a - b);
  const median = rounds.length % 2 === 0
    ? (rounds[rounds.length / 2 - 1] + rounds[rounds.length / 2]) / 2
    : rounds[Math.floor(rounds.length / 2)];

  const avgRounds = rounds.reduce((a, b) => a + b, 0) / rounds.length;
  const avgBlocking = reviewed.reduce((a, p) => a + p.totalBlockingFindings, 0) / reviewed.length;
  const firstRoundApproves = reviewed.filter(p => p.reviewRounds === 1).length;

  const specReviewed = prs.filter(p => p.specReviewRounds > 0);
  const avgSpecRounds = specReviewed.length > 0
    ? specReviewed.reduce((a, p) => a + p.specReviewRounds, 0) / specReviewed.length
    : 0;

  const withTiming = reviewed.filter(p => p.timeToMergeHours !== null);
  const avgTime = withTiming.length > 0
    ? Math.round((withTiming.reduce((a, p) => a + p.timeToMergeHours!, 0) / withTiming.length) * 10) / 10
    : null;

  const categoryTotals: Record<string, number> = {};
  for (const p of reviewed) {
    for (const [cat, count] of Object.entries(p.findingsByCategory)) {
      categoryTotals[cat] = (categoryTotals[cat] ?? 0) + count;
    }
  }

  const totalFindings = reviewed.reduce((a, p) => a + p.totalBlockingFindings + p.totalSuggestionFindings, 0);
  const totalDisputed = reviewed.reduce((a, p) => a + p.disputedFindings, 0);

  // Trend: split into windows of ~5 PRs
  const windowSize = Math.max(3, Math.ceil(reviewed.length / 4));
  const trendWindows: TrendWindow[] = [];
  for (let i = 0; i < reviewed.length; i += windowSize) {
    const window = reviewed.slice(i, i + windowSize);
    const wRounds = window.map(p => p.reviewRounds);
    const wBlocking = window.map(p => p.totalBlockingFindings);
    const wFirstApprove = window.filter(p => p.reviewRounds === 1).length;
    trendWindows.push({
      label: `PRs #${window[0].pr}-#${window[window.length - 1].pr}`,
      prs: window.length,
      avgRounds: Math.round((wRounds.reduce((a, b) => a + b, 0) / wRounds.length) * 10) / 10,
      avgBlocking: Math.round((wBlocking.reduce((a, b) => a + b, 0) / wBlocking.length) * 10) / 10,
      firstRoundApproveRate: Math.round((wFirstApprove / window.length) * 100),
    });
  }

  return {
    totalPRs: prs.length,
    avgReviewRounds: Math.round(avgRounds * 10) / 10,
    medianReviewRounds: median,
    avgSpecReviewRounds: Math.round(avgSpecRounds * 10) / 10,
    avgBlockingFindings: Math.round(avgBlocking * 10) / 10,
    avgTimeToMergeHours: avgTime,
    firstRoundApproveRate: Math.round((firstRoundApproves / reviewed.length) * 100),
    findingCategoryTotals: categoryTotals,
    disputeRate: totalFindings > 0 ? Math.round((totalDisputed / totalFindings) * 100) : 0,
    trendByWindow: trendWindows,
    retrospectiveSummary: readRetrospectives(extraReviewsDirs),
  };
}

// --- Format output ---
function formatMarkdown(agg: AggregateMetrics, prs: PRMetrics[], dispatches: DispatchRow[] | null): string {
  const lines: string[] = ["# Workflow Metrics\n"];
  lines.push(`*Generated: ${new Date().toISOString().slice(0, 16)}*\n`);

  // Summary
  lines.push("## Summary\n");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total PRs analyzed | ${agg.totalPRs} |`);
  lines.push(`| Avg PR review rounds | ${agg.avgReviewRounds} |`);
  lines.push(`| Median PR review rounds | ${agg.medianReviewRounds} |`);
  lines.push(`| Avg spec review rounds | ${agg.avgSpecReviewRounds} |`);
  lines.push(`| Avg blocking findings/PR | ${agg.avgBlockingFindings} |`);
  lines.push(`| First-round approve rate | ${agg.firstRoundApproveRate}% |`);
  lines.push(`| Dispute rate | ${agg.disputeRate}% |`);
  if (agg.avgTimeToMergeHours !== null) {
    lines.push(`| Avg time to merge (hours) | ${agg.avgTimeToMergeHours} |`);
  }
  lines.push("");

  // Finding categories
  const sorted = Object.entries(agg.findingCategoryTotals).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    lines.push("## Finding Categories (all time)\n");
    lines.push("| Category | Count |");
    lines.push("|----------|-------|");
    for (const [cat, count] of sorted) {
      lines.push(`| ${cat} | ${count} |`);
    }
    lines.push("");
  }

  // Trends
  if (agg.trendByWindow.length > 1) {
    lines.push("## Trends\n");
    lines.push("| Window | PRs | Avg Rounds | Avg Blocking | 1st-Round Approve |");
    lines.push("|--------|-----|------------|--------------|-------------------|");
    for (const w of agg.trendByWindow) {
      lines.push(`| ${w.label} | ${w.prs} | ${w.avgRounds} | ${w.avgBlocking} | ${w.firstRoundApproveRate}% |`);
    }
    lines.push("");
  }

  // Worst offenders (most review rounds)
  const worstPRs = [...prs].filter(p => p.reviewRounds > 1).sort((a, b) => b.reviewRounds - a.reviewRounds).slice(0, 5);
  if (worstPRs.length > 0) {
    lines.push("## Most Review Rounds\n");
    lines.push("| PR | Issue | Rounds | Blocking | Title |");
    lines.push("|----|-------|--------|----------|-------|");
    for (const p of worstPRs) {
      lines.push(`| #${p.pr} | ${p.issue ? "#" + p.issue : "-"} | ${p.reviewRounds} | ${p.totalBlockingFindings} | ${p.title.slice(0, 50)} |`);
    }
    lines.push("");
  }

  // Retrospective summary
  const retro = agg.retrospectiveSummary;
  if (retro.totalFiles > 0) {
    lines.push("## Prompt Improvement Retrospectives\n");
    lines.push(`Total retrospective files: ${retro.totalFiles}\n`);
    if (Object.keys(retro.bySkill).length > 0) {
      lines.push("| Skill | Retrospectives |");
      lines.push("|-------|---------------|");
      for (const [skill, count] of Object.entries(retro.bySkill).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${skill} | ${count} |`);
      }
      lines.push("");
    }
    if (retro.topPromptFixes.length > 0) {
      lines.push("### Recent Prompt Fix Suggestions\n");
      for (const fix of retro.topPromptFixes) {
        lines.push(`- ${fix.slice(0, 200)}`);
      }
      lines.push("");
    }
  }

  // --- Yolo dispatch data ---
  if (dispatches && dispatches.length > 0) {
    const skillStats = computeSkillStats(dispatches);
    const issueCosts = computeIssueCosts(dispatches);

    lines.push("## Skill Performance (from yolo dispatches)\n");
    lines.push("| Skill | Invocations | Avg Duration | Avg Tokens | Total Cost | Success |");
    lines.push("|-------|-------------|-------------|------------|------------|---------|");
    for (const s of skillStats) {
      lines.push(`| ${s.skill} | ${s.invocations} | ${s.avgDurationMin}m | ${s.avgTokensK}k | $${s.totalCost.toFixed(2)} | ${s.successRate}% |`);
    }
    lines.push("");

    // Cost per issue (top 10)
    const topIssues = issueCosts.slice(0, 10);
    if (topIssues.length > 0) {
      lines.push("## Cost Per Issue (top 10)\n");
      lines.push("| Issue | Dispatches | Review Rounds | Duration | Tokens | Cost |");
      lines.push("|-------|------------|---------------|----------|--------|------|");
      for (const ic of topIssues) {
        lines.push(`| #${ic.issue} | ${ic.dispatches} | ${ic.reviewRounds} | ${ic.totalDurationMin}m | ${ic.totalTokensK}k | $${ic.totalCost.toFixed(2)} |`);
      }
      lines.push("");

      // Aggregate cost stats
      const totalCost = issueCosts.reduce((a, ic) => a + ic.totalCost, 0);
      const avgCost = totalCost / issueCosts.length;
      const totalDur = issueCosts.reduce((a, ic) => a + ic.totalDurationMin, 0);
      lines.push("## Cost Summary\n");
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Total issues tracked | ${issueCosts.length} |`);
      lines.push(`| Total cost (Claude) | $${totalCost.toFixed(2)} |`);
      lines.push(`| Avg cost per issue | $${avgCost.toFixed(2)} |`);
      lines.push(`| Total agent time | ${Math.round(totalDur)}m (${(totalDur / 60).toFixed(1)}h) |`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// --- Main ---
async function main() {
  // Fetch all PRs
  const { ok, output: prsRaw } = giteaSafe("prs", "all");
  if (!ok) {
    console.error("ERROR: Failed to fetch PRs:", prsRaw);
    process.exit(1);
  }

  // Parse PR numbers
  const prNumbers: number[] = [];
  for (const line of prsRaw.split("\n")) {
    const match = line.match(/^#(\d+)\s+\[/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= sincePr) prNumbers.push(num);
    }
  }

  console.error(`Analyzing ${prNumbers.length} PRs...`);

  // Log review dirs being scanned
  const localReviewsDir = join(ROOT, ".claude", "cl", "reviews");
  const reviewDirsToScan = [localReviewsDir, ...extraReviewsDirs].filter(d => existsSync(d));
  console.error(`Analyzing learning files from ${reviewDirsToScan.length} director${reviewDirsToScan.length === 1 ? "y" : "ies"}...`);

  // Collect metrics for each PR
  const allMetrics: PRMetrics[] = [];
  for (const prNum of prNumbers) {
    const { ok: prOk, output: prOutput } = giteaSafe("pr", String(prNum));
    if (!prOk) continue;

    const metrics = collectPRMetrics(prOutput, prNum);
    if (metrics) allMetrics.push(metrics);
    process.stderr.write(".");
  }
  console.error("");

  // Compute aggregates
  const aggregates = computeAggregates(allMetrics);

  // Read yolo dispatch data
  const dispatches = readYoloDispatches();
  if (dispatches) {
    console.error(`Loaded ${dispatches.length} yolo dispatches`);
  } else {
    console.error("No yolo dispatch DB found (optional)");
  }

  const markdown = formatMarkdown(aggregates, allMetrics, dispatches);

  // Always write to .claude/workflow-stats.md
  const outDir = join(ROOT, ".claude");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "workflow-stats.md");
  writeFileSync(outPath, markdown);
  console.error(`Written to ${outPath}`);

  // Also output to stdout
  if (jsonOutput) {
    console.log(JSON.stringify({ aggregates, prs: allMetrics }, null, 2));
  } else {
    console.log(markdown);
  }
}

main().catch(e => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
