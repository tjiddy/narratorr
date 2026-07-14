import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  AMBER_STROKE,
  VIOLET_STROKE,
  applyTitlePrefix,
  computeBadgeEffect,
  normalizeBadge,
  recolorFaviconDataUri,
} from './instance-badge.js';

// Mirrors src/client/public/favicon.svg (intentionally NOT imported — the pure helpers
// operate on whatever SVG source the effect hands them at runtime).
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">\n' +
  '  <path d="M3 18v-6a9 9 0 0 1 18 0v6" />\n' +
  '  <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />\n' +
  '</svg>';

describe('normalizeBadge', () => {
  it('returns undefined for null/undefined/empty/whitespace', () => {
    expect(normalizeBadge(undefined)).toBeUndefined();
    expect(normalizeBadge(null)).toBeUndefined();
    expect(normalizeBadge('')).toBeUndefined();
    expect(normalizeBadge('   ')).toBeUndefined();
  });

  it('trims a set value', () => {
    expect(normalizeBadge('  dev  ')).toBe('dev');
  });
});

describe('applyTitlePrefix', () => {
  it('prefixes a set badge', () => {
    expect(applyTitlePrefix('dev', 'Narratorr')).toBe('[dev] Narratorr');
  });

  it('is idempotent — does not double the prefix', () => {
    const once = applyTitlePrefix('dev', 'Narratorr');
    expect(applyTitlePrefix('dev', once)).toBe('[dev] Narratorr');
  });

  it('returns identity when the badge is unset', () => {
    expect(applyTitlePrefix(undefined, 'Narratorr')).toBe('Narratorr');
    expect(applyTitlePrefix('   ', 'Narratorr')).toBe('Narratorr');
  });
});

describe('recolorFaviconDataUri', () => {
  // The recolor is a string replace of AMBER_STROKE in whatever SVG the live icon link
  // serves. The literal lives in unlinked homes (this constant, the asset, the fixture
  // above) — if the served favicon's stroke ever changes, the replace silently becomes an
  // identity transform and the dev badge favicon reverts to prod-identical while every
  // fixture-based test stays green. This assertion binds the constant to the real asset so
  // that drift fails loudly instead of shipping.
  it('AMBER_STROKE matches the served favicon asset', () => {
    // path.join from cwd, not new URL(import.meta.url): under the jsdom test
    // environment import.meta.url is not a file: URL and new URL() throws.
    const svg = readFileSync(join(process.cwd(), 'src/client/public/favicon.svg'), 'utf8');
    expect(svg).toContain(AMBER_STROKE);
  });

  it('produces a valid data URI whose decoded SVG is recolored violet', () => {
    const uri = recolorFaviconDataUri(FAVICON_SVG);
    expect(uri.startsWith('data:image/svg+xml,')).toBe(true);

    const decoded = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(decoded).toContain(VIOLET_STROKE);
    expect(decoded).not.toContain(AMBER_STROKE);
    // Glyph path data is retained.
    expect(decoded).toContain('<path d="M3 18v-6a9 9 0 0 1 18 0v6"');
  });

  it('percent-encodes the # so no bare fragment separator leaks into the URI', () => {
    const uri = recolorFaviconDataUri(FAVICON_SVG);
    expect(uri).not.toContain(VIOLET_STROKE); // must be %238b5cf6, never a bare #8b5cf6
    expect(uri).toContain('%238b5cf6');
  });

  it('honors a caller-supplied color', () => {
    const decoded = decodeURIComponent(
      recolorFaviconDataUri(FAVICON_SVG, '#123456').slice('data:image/svg+xml,'.length),
    );
    expect(decoded).toContain('#123456');
    expect(decoded).not.toContain(AMBER_STROKE);
  });
});

describe('computeBadgeEffect', () => {
  it('returns null (no-op) when the badge is unset', () => {
    expect(computeBadgeEffect(undefined, 'Narratorr', FAVICON_SVG)).toBeNull();
    expect(computeBadgeEffect('  ', 'Narratorr', FAVICON_SVG)).toBeNull();
  });

  it('returns the prefixed title and violet favicon href when set', () => {
    const effect = computeBadgeEffect('dev', 'Narratorr', FAVICON_SVG);
    expect(effect).not.toBeNull();
    expect(effect!.title).toBe('[dev] Narratorr');
    expect(effect!.faviconHref).toContain('%238b5cf6');
  });
});
