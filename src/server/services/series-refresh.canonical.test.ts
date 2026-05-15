import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books } from '../../db/schema.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { pickCanonical } from './series-refresh.canonical.js';
import {
  normalizePrimaryAuthor,
  normalizeSeriesMemberWorkTitle,
  type CandidateInfo,
  type MatchedSeriesRef,
} from './series-refresh.dedupe.js';

const SERIES_ASIN = 'SILO_SID';

function product(opts: {
  asin: string;
  title: string;
  position: number | null;
  author?: string;
  formatType?: string;
  contentDeliveryType?: string;
  coverUrl?: string;
  duration?: number;
}): BookMetadata {
  const seriesEntry = opts.position === null
    ? { name: 'Series', asin: SERIES_ASIN }
    : { name: 'Series', position: opts.position, asin: SERIES_ASIN };
  return {
    asin: opts.asin,
    title: opts.title,
    authors: [{ name: opts.author ?? 'Hugh Howey' }],
    series: [seriesEntry],
    seriesPrimary: seriesEntry,
    formatType: opts.formatType,
    contentDeliveryType: opts.contentDeliveryType,
    coverUrl: opts.coverUrl,
    duration: opts.duration,
  };
}

function describe_(p: BookMetadata): CandidateInfo {
  const ref: MatchedSeriesRef = {
    name: 'Series',
    asin: SERIES_ASIN,
    position: p.seriesPrimary?.position ?? null,
  };
  return {
    product: p,
    matchedRef: ref,
    normalizedTitle: normalizeSeriesMemberWorkTitle(p.title),
    positionRaw: ref.position !== null ? String(ref.position) : null,
    normalizedAuthor: normalizePrimaryAuthor(p.authors[0]?.name ?? null),
  };
}

describe('pickCanonical — clean-vs-container preference (#1126)', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'series-canonical-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('returns the clean-titled candidate over an omnibus candidate at the same numbered position', async () => {
    const group = [
      describe_(product({ asin: 'B00904FYUI', title: 'Wool Omnibus Edition (Wool 1 - 5)', position: 1 })),
      describe_(product({ asin: 'B0BKR3Y6SP', title: 'Wool', position: 1, formatType: 'unabridged', contentDeliveryType: 'SinglePartBook' })),
    ];
    const canonical = await pickCanonical(db, group, 'B0BKR3Y6SP');
    expect(canonical.product.asin).toBe('B0BKR3Y6SP');
    expect(canonical.product.title).toBe('Wool');
  });

  it('returns the highest-scoring container when ALL candidates are containers (no clean variant)', async () => {
    // No clean row exists — only-container-at-position fallback applies.
    const group = [
      describe_(product({ asin: 'OMNI1', title: 'Some Series Omnibus Edition (Books 1 - 5)', position: 4 })),
      describe_(product({ asin: 'OMNI2', title: 'Some Series Collection', position: 4, formatType: 'abridged' })),
    ];
    const canonical = await pickCanonical(db, group, 'OMNI1');
    // Both are containers (cleanTitleScore: 1, 1); next tiers decide. The
    // unabridged-undefined OMNI1 beats abridged OMNI2 via formatTypePreference,
    // and seed-bias also breaks ties toward OMNI1.
    expect(['OMNI1', 'OMNI2']).toContain(canonical.product.asin);
    expect(canonical.product.asin).toBe('OMNI1');
  });

  it('local-library clean candidate beats a winning-by-default container candidate', async () => {
    // Insert a local book matching the clean candidate's ASIN. The container
    // would otherwise win by seed-bias, but cleanTitleScore (tier 0) already
    // hands the canonical to the clean candidate.
    await db.insert(books).values({ title: 'Wool', asin: 'CLEAN1' });
    const group = [
      describe_(product({ asin: 'OMNI', title: 'Wool Omnibus Edition (Wool 1 - 5)', position: 1 })),
      describe_(product({ asin: 'CLEAN1', title: 'Wool', position: 1, formatType: 'unabridged' })),
    ];
    const canonical = await pickCanonical(db, group, 'OMNI');
    expect(canonical.product.asin).toBe('CLEAN1');
  });

  it('clean-vs-container preference beats seed-bias when seed is a container and a clean sibling exists', async () => {
    // Seed (OMNI) is a container; clean sibling exists. Clean wins.
    const group = [
      describe_(product({ asin: 'OMNI', title: 'Wool Omnibus Edition (Wool 1 - 5)', position: 1 })),
      describe_(product({ asin: 'CLEAN', title: 'Wool', position: 1, formatType: 'unabridged' })),
    ];
    const canonical = await pickCanonical(db, group, 'OMNI');
    expect(canonical.product.asin).toBe('CLEAN');
    expect(canonical.product.title).toBe('Wool');
  });

  it('seed-is-container with no clean sibling: seed (or another container) becomes canonical', async () => {
    // Seed is the only candidate in its group — falls back to seed.
    const group = [
      describe_(product({ asin: 'OMNI', title: 'Wool Omnibus Edition (Wool 1 - 5)', position: 1 })),
    ];
    const canonical = await pickCanonical(db, group, 'OMNI');
    expect(canonical.product.asin).toBe('OMNI');
  });
});
