import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { canonicalPath, findOtherPathOwner } from './path-identity.js';
import { generatePublicId } from './public-id.js';
import { inject, mockDbChain } from '../__tests__/helpers.js';

const p = (value: string): string => value.split('\\').join('/');

describe('canonicalPath', () => {
  it('folds backslashes before resolving so a parent segment behind them still collapses', () => {
    // The counterfactual for the fold order: resolve() treats `\` as an ordinary character on
    // POSIX, so folding after resolve would leave `/library/A/../Y` uncollapsed.
    expect(p(canonicalPath('/library\\A\\..\\Y'))).toBe('/library/Y');
    expect(p(canonicalPath('/library/A/../Y'))).toBe('/library/Y');
  });

  it('treats every legacy spelling of one folder as the same value', () => {
    const canonical = p(canonicalPath('/library/Y'));
    for (const spelling of ['/library/Y/', '/library//Y', '/library/./Y', '/library/A/../Y', '/library\\Y']) {
      expect(p(canonicalPath(spelling))).toBe(canonical);
    }
  });

  it('keeps distinct folders distinct, including prefix neighbours', () => {
    const target = p(canonicalPath('/library/Y'));
    expect(p(canonicalPath('/library/Y2'))).not.toBe(target);
    expect(p(canonicalPath('/library/Y/sub'))).not.toBe(target);
    expect(p(canonicalPath('/library/YY'))).not.toBe(target);
  });

  it('does not fold case — the documented limit', () => {
    expect(p(canonicalPath('/library/y'))).not.toBe(p(canonicalPath('/library/Y')));
  });

  it('resolves a relative value against the process cwd, self-consistently on both sides', () => {
    expect(p(canonicalPath('library/Y'))).toBe(p(resolve('library/Y')));
    expect(p(canonicalPath('library/Y'))).toBe(p(canonicalPath('./library/A/../Y')));
  });

  it('is platform-stable — the output never carries a backslash', () => {
    expect(canonicalPath('/library\\Author\\Title')).not.toContain('\\');
  });
});

describe('findOtherPathOwner tie-break', () => {
  // SQLite hands back a full table scan in rowid order, so a real-DB fixture cannot tell
  // "lowest id" apart from "first row returned". Feeding the rows back in DESCENDING id order is
  // the only arm that distinguishes them, and the structured conflict banner depends on the
  // choice being stable.
  it('returns the lowest-id match even when the driver hands rows back highest-id first', async () => {
    const db = inject<Db>({
      select: () => mockDbChain([
        { id: 50, title: 'Higher Id Owner', path: '/library/Y/' },
        { id: 10, title: 'Lower Id Owner', path: '/library/A/../Y' },
      ]),
    });

    await expect(findOtherPathOwner(db, '/library/Y', 99)).resolves.toEqual({
      id: 10,
      title: 'Lower Id Owner',
    });
  });
});

describe('findOtherPathOwner (real DB)', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'path-identity-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; see windows-hostile-test-primitives
    }
  });

  const seed = async (title: string, path: string | null): Promise<number> => {
    const [row] = await db.insert(books).values({ publicId: generatePublicId('bk'), title, path, status: 'imported' }).returning();
    return row!.id;
  };

  it.each([
    ['/library/Y/', 'trailing separator'],
    ['/library//Y', 'repeated separator'],
    ['/library/./Y', 'dot segment'],
    ['/library/A/../Y', 'parent segment — beyond any SQL repair'],
    ['/library\\A\\..\\Y', 'backslash separators plus a parent segment'],
  ])('matches a row stored as %s (%s)', async (stored) => {
    const otherId = await seed('Other Book', stored);
    const renamingId = await seed('Renaming Book', '/library/Wrong/Old');

    await expect(findOtherPathOwner(db, '/library/Y', renamingId)).resolves.toEqual({
      id: otherId,
      title: 'Other Book',
    });
  });

  it('matches when the TARGET carries platform separators and the stored row does not', async () => {
    const otherId = await seed('Other Book', '/library/Y');
    const renamingId = await seed('Renaming Book', '/library/Wrong/Old');

    await expect(findOtherPathOwner(db, '/library\\Y', renamingId)).resolves.toEqual({
      id: otherId,
      title: 'Other Book',
    });
  });

  it('returns the lowest-id owner when two differently spelled rows canonicalise to the target', async () => {
    // Insertion order is deliberately not id order: an unordered first-match implementation
    // would return the row inserted first, which here is the HIGHER id.
    const [higherRow] = await db
      .insert(books)
      .values({ id: 50, publicId: generatePublicId('bk'), title: 'Higher Id Owner', path: '/library/Y/', status: 'imported' })
      .returning();
    const [lowerRow] = await db
      .insert(books)
      .values({ id: 10, publicId: generatePublicId('bk'), title: 'Lower Id Owner', path: '/library/A/../Y', status: 'imported' })
      .returning();
    const higherId = higherRow!.id;
    const lowerId = lowerRow!.id;
    expect(lowerId).toBeLessThan(higherId);
    const renamingId = await seed('Renaming Book', '/library/Wrong/Old');

    await expect(findOtherPathOwner(db, '/library/Y', renamingId)).resolves.toEqual({
      id: lowerId,
      title: 'Lower Id Owner',
    });
  });

  it.each(['/library/Y2', '/library/Y/sub', '/library/YY'])('does not match a row at %s', async (stored) => {
    await seed('Other Book', stored);
    const renamingId = await seed('Renaming Book', '/library/Wrong/Old');

    await expect(findOtherPathOwner(db, '/library/Y', renamingId)).resolves.toBeNull();
  });

  it('excludes the book being renamed, and ignores rows with a null path', async () => {
    const selfId = await seed('Self', '/library/Y');
    await seed('Pathless', null);

    await expect(findOtherPathOwner(db, '/library/Y', selfId)).resolves.toBeNull();
  });

  it('finds any owner when no book is excluded', async () => {
    const selfId = await seed('Self', '/library/Y');

    await expect(findOtherPathOwner(db, '/library/Y')).resolves.toEqual({ id: selfId, title: 'Self' });
  });
});
