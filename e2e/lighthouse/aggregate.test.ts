import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregate,
  isFailingAudit,
  buildAuditCategoryMap,
  type LighthouseAudit,
  type LighthouseResult,
} from './aggregate.ts';

function makeLhr(overrides: Partial<LighthouseResult> = {}): LighthouseResult {
  return {
    requestedUrl: 'http://localhost:3199/library',
    finalUrl: 'http://localhost:3199/library',
    categories: {
      accessibility: {
        id: 'accessibility',
        title: 'Accessibility',
        score: 0.92,
        auditRefs: [{ id: 'color-contrast' }, { id: 'image-alt' }],
      },
      performance: {
        id: 'performance',
        title: 'Performance',
        score: 0.85,
        auditRefs: [{ id: 'first-contentful-paint' }, { id: 'viewport' }],
      },
      'best-practices': {
        id: 'best-practices',
        title: 'Best Practices',
        score: 1.0,
        auditRefs: [{ id: 'is-on-https' }],
      },
      seo: {
        id: 'seo',
        title: 'SEO',
        score: 0.9,
        auditRefs: [{ id: 'meta-description' }, { id: 'tap-targets' }],
      },
    },
    audits: {
      'color-contrast': {
        id: 'color-contrast',
        title: 'Background and foreground colors have sufficient contrast ratio',
        description: '',
        score: 0.5,
        scoreDisplayMode: 'binary',
      },
      'image-alt': {
        id: 'image-alt',
        title: 'Image elements have [alt] attributes',
        description: '',
        score: 1,
        scoreDisplayMode: 'binary',
      },
      'first-contentful-paint': {
        id: 'first-contentful-paint',
        title: 'First Contentful Paint',
        description: '',
        score: 0.8,
        scoreDisplayMode: 'numeric',
      },
      viewport: {
        id: 'viewport',
        title: 'Has a `<meta name="viewport">` tag',
        description: '',
        score: 1,
        scoreDisplayMode: 'binary',
      },
      'tap-targets': {
        id: 'tap-targets',
        title: 'Tap targets are sized appropriately',
        description: '',
        score: 0.5,
        scoreDisplayMode: 'binary',
      },
      'meta-description': {
        id: 'meta-description',
        title: 'Document has a meta description',
        description: '',
        score: 0,
        scoreDisplayMode: 'binary',
      },
      'is-on-https': {
        id: 'is-on-https',
        title: 'Uses HTTPS',
        description: '',
        score: 1,
        scoreDisplayMode: 'binary',
      },
      'robots-txt': {
        id: 'robots-txt',
        title: 'robots.txt is valid',
        description: '',
        score: null,
        scoreDisplayMode: 'informative',
      },
      'manual-audit': {
        id: 'manual-audit',
        title: 'Some manual check',
        description: '',
        score: 0,
        scoreDisplayMode: 'manual',
      },
    },
    ...overrides,
  };
}

describe('isFailingAudit', () => {
  it('returns true for audits with score < 1 and binary display mode', () => {
    const audit: LighthouseAudit = {
      id: 'test', title: 'Test', description: '', score: 0.5, scoreDisplayMode: 'binary',
    };
    expect(isFailingAudit(audit)).toBe(true);
  });

  it('returns false for passing audits (score = 1)', () => {
    const audit: LighthouseAudit = {
      id: 'test', title: 'Test', description: '', score: 1, scoreDisplayMode: 'binary',
    };
    expect(isFailingAudit(audit)).toBe(false);
  });

  it('returns false for informative audits regardless of score', () => {
    const audit: LighthouseAudit = {
      id: 'test', title: 'Test', description: '', score: null, scoreDisplayMode: 'informative',
    };
    expect(isFailingAudit(audit)).toBe(false);
  });

  it('returns false for manual audits', () => {
    const audit: LighthouseAudit = {
      id: 'test', title: 'Test', description: '', score: 0, scoreDisplayMode: 'manual',
    };
    expect(isFailingAudit(audit)).toBe(false);
  });

  it('returns false for notApplicable audits', () => {
    const audit: LighthouseAudit = {
      id: 'test', title: 'Test', description: '', score: 0, scoreDisplayMode: 'notApplicable',
    };
    expect(isFailingAudit(audit)).toBe(false);
  });

  it('returns true for score of 0', () => {
    const audit: LighthouseAudit = {
      id: 'test', title: 'Test', description: '', score: 0, scoreDisplayMode: 'binary',
    };
    expect(isFailingAudit(audit)).toBe(true);
  });
});

describe('buildAuditCategoryMap', () => {
  it('maps audits to their category based on auditRefs', () => {
    const lhr = makeLhr();
    const map = buildAuditCategoryMap(lhr);

    expect(map.get('color-contrast')).toBe('accessibility');
    expect(map.get('image-alt')).toBe('accessibility');
    expect(map.get('first-contentful-paint')).toBe('performance');
    expect(map.get('meta-description')).toBe('seo');
  });

  it('first category wins when audit appears in multiple categories', () => {
    const lhr = makeLhr();
    // viewport appears in performance auditRefs
    const map = buildAuditCategoryMap(lhr);
    expect(map.get('viewport')).toBe('performance');
  });

  it('handles categories without auditRefs', () => {
    const lhr = makeLhr({
      categories: {
        accessibility: { id: 'accessibility', title: 'Accessibility', score: 1 },
      },
    });
    const map = buildAuditCategoryMap(lhr);
    expect(map.size).toBe(0);
  });
});

describe('aggregate', () => {
  let tmpDir: string;
  let lhciDir: string;
  let reportsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `lhci-test-${Date.now()}`);
    lhciDir = join(tmpDir, 'lhci');
    reportsDir = join(tmpDir, 'reports');
    mkdirSync(lhciDir, { recursive: true });
    mkdirSync(reportsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it('generates summary.md and results.json from Lighthouse reports', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeFileSync(join(lhciDir, 'lhr-library.json'), JSON.stringify(makeLhr()));

    aggregate(lhciDir, reportsDir);

    expect(existsSync(join(reportsDir, 'summary.md'))).toBe(true);
    expect(existsSync(join(reportsDir, 'results.json'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('classifies responsiveness audits under Responsiveness heading', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeFileSync(join(lhciDir, 'lhr-library.json'), JSON.stringify(makeLhr()));

    aggregate(lhciDir, reportsDir);

    const summary = readFileSync(join(reportsDir, 'summary.md'), 'utf-8');
    // tap-targets is a responsiveness audit with score 0.5 — should appear under Responsiveness
    expect(summary).toContain('## Responsiveness');
    expect(summary).toContain('`tap-targets`');
    vi.restoreAllMocks();
  });

  it('classifies non-responsiveness audits under their actual Lighthouse category', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeFileSync(join(lhciDir, 'lhr-library.json'), JSON.stringify(makeLhr()));

    aggregate(lhciDir, reportsDir);

    const summary = readFileSync(join(reportsDir, 'summary.md'), 'utf-8');
    // color-contrast is accessibility, meta-description is SEO
    expect(summary).toContain('## Accessibility');
    expect(summary).toContain('`color-contrast`');
    expect(summary).toContain('## SEO');
    expect(summary).toContain('`meta-description`');
    vi.restoreAllMocks();
  });

  it('does not include informative or manual audits in findings', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeFileSync(join(lhciDir, 'lhr-library.json'), JSON.stringify(makeLhr()));

    aggregate(lhciDir, reportsDir);

    const results = JSON.parse(readFileSync(join(reportsDir, 'results.json'), 'utf-8'));
    const findingIds = results.findings.map((f: { auditId: string }) => f.auditId);
    expect(findingIds).not.toContain('robots-txt');
    expect(findingIds).not.toContain('manual-audit');
    vi.restoreAllMocks();
  });

  it('deduplicates findings across multiple routes', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const lhr1 = makeLhr({ requestedUrl: 'http://localhost:3199/library' });
    const lhr2 = makeLhr({ requestedUrl: 'http://localhost:3199/settings' });

    writeFileSync(join(lhciDir, 'lhr-library.json'), JSON.stringify(lhr1));
    writeFileSync(join(lhciDir, 'lhr-settings.json'), JSON.stringify(lhr2));

    aggregate(lhciDir, reportsDir);

    const results = JSON.parse(readFileSync(join(reportsDir, 'results.json'), 'utf-8'));
    const colorContrast = results.findings.find((f: { auditId: string }) => f.auditId === 'color-contrast');
    expect(colorContrast.count).toBe(2);
    expect(colorContrast.affectedRoutes).toContain('/library');
    expect(colorContrast.affectedRoutes).toContain('/settings');
    vi.restoreAllMocks();
  });

  it('results.json includes per-route category scores and responsiveness key', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeFileSync(join(lhciDir, 'lhr-library.json'), JSON.stringify(makeLhr()));

    aggregate(lhciDir, reportsDir);

    const results = JSON.parse(readFileSync(join(reportsDir, 'results.json'), 'utf-8'));
    expect(results.routes).toHaveLength(1);
    expect(results.routes[0].categories.accessibility).toBe(0.92);
    expect(results.routes[0].categories.performance).toBe(0.85);
    expect(results.routes[0].responsiveness).toBeDefined();
    expect(results.routes[0].responsiveness['tap-targets']).toBeDefined();
    vi.restoreAllMocks();
  });

  it('reads from manifest.json when no lhr-*.json files exist', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const lhrPath = join(lhciDir, 'some-hash.json');
    writeFileSync(lhrPath, JSON.stringify(makeLhr()));
    writeFileSync(join(lhciDir, 'manifest.json'), JSON.stringify([{ jsonPath: lhrPath }]));

    aggregate(lhciDir, reportsDir);

    expect(existsSync(join(reportsDir, 'results.json'))).toBe(true);
    vi.restoreAllMocks();
  });

  it('summary includes scores table with all routes', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeFileSync(join(lhciDir, 'lhr-library.json'), JSON.stringify(makeLhr()));

    aggregate(lhciDir, reportsDir);

    const summary = readFileSync(join(reportsDir, 'summary.md'), 'utf-8');
    expect(summary).toContain('## Scores by Route');
    expect(summary).toContain('`/library`');
    expect(summary).toContain('1 routes audited');
    vi.restoreAllMocks();
  });
});
