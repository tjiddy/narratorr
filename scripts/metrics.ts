#!/usr/bin/env node
// Workflow metrics — parses GitHub comments and git history to produce
// trend data on review quality, round counts, and finding patterns.
// Usage: node scripts/metrics.ts [--since <pr-number>] [--json]
// Output: markdown to .narratorr/workflow-stats.md + stdout (or JSON with --json).
// Pulls dispatch data from the narrator-automate API (http://192.168.0.22:3031).

import { ghSafe, parseLinkedIssue, parseComments, JQ, GH_FIELDS } from "./lib.ts";
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

const AUTOMATION_API = "http://192.168.0.22:3031";

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

// --- Automation dispatch types ---
interface DispatchSummary {
  issueNumber: number;
  dispatches: number;
  totalCost: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  reviewRounds: number;
  lastDispatch: string;
}

// --- Fetch dispatch summaries from narrator-automate API ---
function fetchDispatchSummaries(): DispatchSummary[] | null {
  try {
    const tmpFile = join(process.env.TEMP ?? "/tmp", "narratorr-dispatches.json");
    execFileSync("curl", ["-sf", "--max-time", "5", "-o", tmpFile, `${AUTOMATION_API}/api/dispatches/summary`], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(readFileSync(tmpFile, "utf-8"));
  } catch {
    return null;
  }
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
  const { ok, output: commentsRaw } = ghSafe("api", `repos/{owner}/{repo}/issues/${prNumber}/comments`, "--paginate", "--jq", JQ.COMMENTS);
  if (!ok) return null;

  const comments = parseComments(commentsRaw);

  // Count PR review rounds (## Verdict: in reviewer comments)
  const verdicts = comments.filter(c => c.body.includes("## Verdict:"));
  const reviewRounds = verdicts.length;

  // Count spec review rounds (from linked issue)
  let specReviewRounds = 0;
  if (issue) {
    const { ok: issueOk, output: issueComments } = ghSafe("api", `repos/{owner}/{repo}/issues/${issue}/comments`, "--paginate", "--jq", JQ.COMMENTS);
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
function readRetrospectives(): RetroSummary {
  const localDir = join(ROOT, ".narratorr", "cl", "reviews");
  const allDirs = [localDir].filter(d => existsSync(d));

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
      retrospectiveSummary: readRetrospectives(),
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
    retrospectiveSummary: readRetrospectives(),
  };
}

// --- Format output ---
function formatMarkdown(agg: AggregateMetrics, prs: PRMetrics[], dispatches: DispatchSummary[] | null): string {
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

  // --- Automation dispatch data ---
  if (dispatches && dispatches.length > 0) {
    const totalIssues = dispatches.length;
    const totalDispatches = dispatches.reduce((a, d) => a + d.dispatches, 0);
    const totalCost = dispatches.reduce((a, d) => a + d.totalCost, 0);
    const totalDurationHrs = dispatches.reduce((a, d) => a + d.totalDurationMs, 0) / 1000 / 60 / 60;
    const totalInputM = dispatches.reduce((a, d) => a + d.totalInputTokens, 0) / 1e6;
    const totalOutputM = dispatches.reduce((a, d) => a + d.totalOutputTokens, 0) / 1e6;
    const avgCost = totalCost / totalIssues;
    const avgDurationMin = dispatches.reduce((a, d) => a + d.totalDurationMs, 0) / totalIssues / 1000 / 60;
    const avgRounds = dispatches.reduce((a, d) => a + d.reviewRounds, 0) / totalIssues;

    lines.push("## Automation Overview\n");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Issues automated | ${totalIssues} |`);
    lines.push(`| Total dispatches | ${totalDispatches} |`);
    lines.push(`| Total cost | $${totalCost.toFixed(2)} |`);
    lines.push(`| Avg cost/issue | $${avgCost.toFixed(2)} |`);
    lines.push(`| Total agent time | ${totalDurationHrs.toFixed(1)} hours |`);
    lines.push(`| Avg time/issue | ${avgDurationMin.toFixed(0)} min |`);
    lines.push(`| Avg review rounds | ${avgRounds.toFixed(1)} |`);
    lines.push(`| Input tokens | ${totalInputM.toFixed(1)}M |`);
    lines.push(`| Output tokens | ${totalOutputM.toFixed(1)}M |`);
    lines.push("");

    // Most expensive issues
    const byCost = [...dispatches].sort((a, b) => b.totalCost - a.totalCost).slice(0, 10);
    lines.push("## Most Expensive Issues\n");
    lines.push("| Issue | Dispatches | Rounds | Duration | Cost |");
    lines.push("|-------|------------|--------|----------|------|");
    for (const d of byCost) {
      const durMin = Math.round(d.totalDurationMs / 1000 / 60);
      lines.push(`| #${d.issueNumber} | ${d.dispatches} | ${d.reviewRounds} | ${durMin}m | $${d.totalCost.toFixed(2)} |`);
    }
    lines.push("");

    // Most review rounds
    const byRounds = [...dispatches].sort((a, b) => b.reviewRounds - a.reviewRounds).slice(0, 10);
    lines.push("## Most Review Rounds\n");
    lines.push("| Issue | Rounds | Dispatches | Cost |");
    lines.push("|-------|--------|------------|------|");
    for (const d of byRounds) {
      lines.push(`| #${d.issueNumber} | ${d.reviewRounds} | ${d.dispatches} | $${d.totalCost.toFixed(2)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Main ---
async function main() {
  // Fetch all PRs
  const { ok, output: prsRaw } = ghSafe("pr", "list", "--state", "all", "--limit", "200", "--json", GH_FIELDS.PRS_LIST, "--jq", JQ.PRS_LIST);
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
  const localReviewsDir = join(ROOT, ".narratorr", "cl", "reviews");
  const hasReviews = existsSync(localReviewsDir);
  console.error(`Retrospectives: ${hasReviews ? localReviewsDir : "none found"}`);

  // Collect metrics for each PR
  const allMetrics: PRMetrics[] = [];
  for (const prNum of prNumbers) {
    const { ok: prOk, output: prOutput } = ghSafe("pr", "view", String(prNum), "--json", GH_FIELDS.PR, "--jq", JQ.PR);
    if (!prOk) continue;

    const metrics = collectPRMetrics(prOutput, prNum);
    if (metrics) allMetrics.push(metrics);
    process.stderr.write(".");
  }
  console.error("");

  // Compute aggregates
  const aggregates = computeAggregates(allMetrics);

  // Fetch dispatch data from automation API
  console.error("Fetching dispatch data from automation API...");
  const dispatches = fetchDispatchSummaries();
  if (dispatches) {
    console.error(`Loaded ${dispatches.length} issue summaries from automation API`);
  } else {
    console.error("Automation API unreachable (optional — run without dispatch data)");
  }

  const markdown = formatMarkdown(aggregates, allMetrics, dispatches);

  // Always write to .narratorr/workflow-stats.md
  const outDir = join(ROOT, ".narratorr");
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
