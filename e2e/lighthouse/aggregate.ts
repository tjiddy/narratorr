/**
 * Aggregation script for Lighthouse reports.
 * Reads per-page JSON results from LHCI output, deduplicates findings,
 * groups by category + responsiveness, and outputs summary.md + results.json.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Lighthouse audit IDs that constitute "responsiveness"
const RESPONSIVENESS_AUDIT_IDS = new Set([
  'viewport',
  'content-width',
  'font-size',
  'tap-targets',
  'meta-viewport',
]);

export interface LighthouseAudit {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  details?: Record<string, unknown>;
}

interface LighthouseCategory {
  id: string;
  title: string;
  score: number | null;
  auditRefs?: Array<{ id: string }>;
}

export interface LighthouseResult {
  requestedUrl: string;
  finalUrl: string;
  categories: Record<string, LighthouseCategory>;
  audits: Record<string, LighthouseAudit>;
}

interface RouteResult {
  url: string;
  route: string;
  categories: Record<string, number | null>;
  responsiveness: Record<string, { score: number | null; title: string }>;
  failingAudits: Array<{ id: string; title: string; category: string }>;
}

interface AggregatedFinding {
  auditId: string;
  title: string;
  category: string;
  affectedRoutes: string[];
  count: number;
}

function findReportFiles(lhciOutputDir: string): string[] {
  const files = readdirSync(lhciOutputDir).filter((f) => f.endsWith('.json') && f.startsWith('lhr-'));

  if (files.length === 0) {
    const manifestPath = join(lhciOutputDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    for (const entry of manifest) {
      if (entry.jsonPath) files.push(entry.jsonPath);
    }
  }

  return files;
}

export function isFailingAudit(audit: LighthouseAudit): boolean {
  return (
    audit.score !== null &&
    audit.score < 1 &&
    audit.scoreDisplayMode !== 'informative' &&
    audit.scoreDisplayMode !== 'manual' &&
    audit.scoreDisplayMode !== 'notApplicable'
  );
}

/** Build a map from audit ID → Lighthouse category ID using auditRefs. */
export function buildAuditCategoryMap(lhr: LighthouseResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const [catId, cat] of Object.entries(lhr.categories)) {
    if (!cat.auditRefs) continue;
    for (const ref of cat.auditRefs) {
      // First category wins — an audit may appear in multiple categories
      if (!map.has(ref.id)) map.set(ref.id, catId);
    }
  }
  return map;
}

function collectFailingAudits(
  lhr: LighthouseResult,
  route: string,
  allFindings: Map<string, AggregatedFinding>,
): Array<{ id: string; title: string; category: string }> {
  const auditCategoryMap = buildAuditCategoryMap(lhr);
  const failingAudits: Array<{ id: string; title: string; category: string }> = [];

  for (const [auditId, audit] of Object.entries(lhr.audits)) {
    if (!isFailingAudit(audit)) continue;

    // Responsiveness audits get their own category; others map to their Lighthouse category
    const category = RESPONSIVENESS_AUDIT_IDS.has(auditId)
      ? 'responsiveness'
      : (auditCategoryMap.get(auditId) ?? 'performance');
    failingAudits.push({ id: auditId, title: audit.title, category });

    const existing = allFindings.get(auditId);
    if (existing) {
      if (!existing.affectedRoutes.includes(route)) {
        existing.affectedRoutes.push(route);
        existing.count++;
      }
    } else {
      allFindings.set(auditId, {
        auditId,
        title: audit.title,
        category,
        affectedRoutes: [route],
        count: 1,
      });
    }
  }

  return failingAudits;
}

function processReport(
  filePath: string,
  allFindings: Map<string, AggregatedFinding>,
): RouteResult {
  const lhr: LighthouseResult = JSON.parse(readFileSync(filePath, 'utf-8'));
  const url = lhr.requestedUrl || lhr.finalUrl;
  const route = extractRoute(url);

  const categories: Record<string, number | null> = {};
  for (const [id, cat] of Object.entries(lhr.categories)) {
    categories[id] = cat.score;
  }

  const responsiveness: Record<string, { score: number | null; title: string }> = {};
  for (const auditId of RESPONSIVENESS_AUDIT_IDS) {
    const audit = lhr.audits[auditId];
    if (audit) {
      responsiveness[auditId] = { score: audit.score, title: audit.title };
    }
  }

  const failingAudits = collectFailingAudits(lhr, route, allFindings);

  return { url, route, categories, responsiveness, failingAudits };
}

export function aggregate(lhciOutputDir: string, reportsDir: string): void {
  const files = findReportFiles(lhciOutputDir);

  if (files.length === 0) {
    console.error('No Lighthouse JSON reports found in', lhciOutputDir);
    process.exit(1);
  }

  const allFindings = new Map<string, AggregatedFinding>();
  const routeResults = files.map((file) => {
    const filePath = file.startsWith('/') || file.startsWith('C:') ? file : join(lhciOutputDir, file);
    return processReport(filePath, allFindings);
  });

  const sortedFindings = [...allFindings.values()].sort((a, b) => b.count - a.count);

  const summary = generateSummary(routeResults, sortedFindings);
  writeFileSync(join(reportsDir, 'summary.md'), summary);

  const resultsJson = {
    timestamp: new Date().toISOString(),
    routes: routeResults.map((r) => ({
      route: r.route,
      url: r.url,
      categories: r.categories,
      responsiveness: r.responsiveness,
    })),
    findings: sortedFindings,
    totalRoutes: routeResults.length,
    totalFindings: sortedFindings.length,
  };
  writeFileSync(join(reportsDir, 'results.json'), JSON.stringify(resultsJson, null, 2));

  console.log(summary);
}

function extractRoute(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return url;
  }
}

function generateSummary(routes: RouteResult[], findings: AggregatedFinding[]): string {
  const lines: string[] = [];
  lines.push('# Lighthouse Audit Summary');
  lines.push('');
  lines.push(`**${routes.length} routes audited** | ${findings.length} unique findings`);
  lines.push('');

  // Category scores table
  lines.push('## Scores by Route');
  lines.push('');
  lines.push('| Route | Accessibility | Performance | Best Practices | SEO |');
  lines.push('|-------|:------------:|:-----------:|:--------------:|:---:|');
  for (const r of routes) {
    const a = formatScore(r.categories['accessibility']);
    const p = formatScore(r.categories['performance']);
    const bp = formatScore(r.categories['best-practices']);
    const s = formatScore(r.categories['seo']);
    lines.push(`| \`${r.route}\` | ${a} | ${p} | ${bp} | ${s} |`);
  }
  lines.push('');

  // Group findings by category
  const byCategory = new Map<string, AggregatedFinding[]>();
  for (const f of findings) {
    const cat = f.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(f);
  }

  // Standard categories first, then responsiveness
  const categoryOrder = ['accessibility', 'performance', 'best-practices', 'seo', 'responsiveness'];
  const categoryLabels: Record<string, string> = {
    accessibility: 'Accessibility',
    performance: 'Performance',
    'best-practices': 'Best Practices',
    seo: 'SEO',
    responsiveness: 'Responsiveness',
  };

  for (const catId of categoryOrder) {
    const catFindings = byCategory.get(catId);
    if (!catFindings || catFindings.length === 0) continue;

    lines.push(`## ${categoryLabels[catId] || catId}`);
    lines.push('');
    for (const f of catFindings) {
      lines.push(`- **${f.title}** (\`${f.auditId}\`) — ${f.count}/${routes.length} routes`);
      lines.push(`  Affected: ${f.affectedRoutes.map((r) => `\`${r}\``).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatScore(score: number | null): string {
  if (score === null) return '-';
  const pct = Math.round(score * 100);
  if (pct >= 90) return `${pct}`;
  if (pct >= 50) return `**${pct}**`;
  return `***${pct}***`;
}

// CLI entry point
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const lhciDir = process.argv[2] || join(process.cwd(), 'lighthouse-reports', 'lhci');
  const reportsDir = process.argv[3] || join(process.cwd(), 'lighthouse-reports');
  aggregate(lhciDir, reportsDir);
}
