import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { authors, books, downloads, narrators, series } from '../../db/schema.js';
import { generatePublicId, resolveByPublicId } from './public-id.js';

describe('generatePublicId()', () => {
  it('returns a string prefixed with the given prefix and an underscore', () => {
    expect(generatePublicId('bk')).toMatch(/^bk_/);
    expect(generatePublicId('au')).toMatch(/^au_/);
  });

  it('returns distinct, non-sequential values on successive calls', () => {
    const ids = Array.from({ length: 100 }, () => generatePublicId('bk'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces a URL-safe body (no characters needing percent-encoding)', () => {
    for (let i = 0; i < 50; i++) {
      const id = generatePublicId('nr');
      expect(id).toBe(encodeURIComponent(id));
      // base64url alphabet only: A-Z a-z 0-9 - _
      expect(id).toMatch(/^nr_[A-Za-z0-9_-]+$/);
    }
  });

  it('produces a stable-length body across calls', () => {
    const a = generatePublicId('sr');
    const b = generatePublicId('sr');
    expect(a.length).toBe(b.length);
    // 16 random bytes -> 22-char base64url body
    expect(a.slice('sr_'.length)).toHaveLength(22);
  });
});

describe('resolveByPublicId()', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'public-id-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the rowid for a row inserted with a known publicId', async () => {
    const publicId = generatePublicId('bk');
    const [row] = await db.insert(books).values({ publicId, title: 'A Book' }).returning();
    await expect(resolveByPublicId(db, books, publicId)).resolves.toBe(row!.id);
  });

  it('returns null when no row matches the publicId', async () => {
    await expect(resolveByPublicId(db, books, 'bk_does-not-exist')).resolves.toBeNull();
  });

  it('resolves correctly across all five entity tables', async () => {
    const auId = generatePublicId('au');
    const [au] = await db.insert(authors).values({ publicId: auId, name: 'Author', slug: 'author' }).returning();
    const nrId = generatePublicId('nr');
    const [nr] = await db.insert(narrators).values({ publicId: nrId, name: 'Narrator', slug: 'narrator' }).returning();
    const srId = generatePublicId('sr');
    const [sr] = await db.insert(series).values({ publicId: srId, name: 'Series', normalizedName: 'series' }).returning();
    const dlId = generatePublicId('dl');
    const [dl] = await db.insert(downloads).values({ publicId: dlId, title: 'Download' }).returning();

    await expect(resolveByPublicId(db, authors, auId)).resolves.toBe(au!.id);
    await expect(resolveByPublicId(db, narrators, nrId)).resolves.toBe(nr!.id);
    await expect(resolveByPublicId(db, series, srId)).resolves.toBe(sr!.id);
    await expect(resolveByPublicId(db, downloads, dlId)).resolves.toBe(dl!.id);
  });

  it('does not cross-match a publicId belonging to a different table', async () => {
    const bookPid = generatePublicId('bk');
    await db.insert(books).values({ publicId: bookPid, title: 'A Book' }).returning();
    // The same string is not present in the authors table.
    await expect(resolveByPublicId(db, authors, bookPid)).resolves.toBeNull();
  });
});
