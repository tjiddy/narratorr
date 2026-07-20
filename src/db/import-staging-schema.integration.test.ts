import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from './index.js';
import { books, importSubmissions, importSubmissionItems } from './schema.js';
import { generatePublicId } from '../server/utils/public-id.js';

// Real-DB coverage for the #1893 staged-import FK delete actions. libSQL enables
// PRAGMA foreign_keys by default (libsql-foreign-keys-on-by-default), so every
// onDelete clause is enforced. This suite also proves the 0001 migration runs
// from scratch.

describe('import-staging schema — FK delete actions (DB-backed, #1893)', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'staging-schema-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  async function seedBook(title: string): Promise<number> {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title, status: 'imported' })
      .returning();
    return row!.id;
  }

  async function seedSubmission(): Promise<number> {
    const [row] = await db
      .insert(importSubmissions)
      .values({
        clientSubmissionId: generatePublicId('sub'),
        payloadDigest: 'a'.repeat(64),
        source: 'library',
        expectedCount: 1,
        status: 'processing',
      })
      .returning();
    return row!.id;
  }

  it('deleting a submission cascades its items', async () => {
    const submissionId = await seedSubmission();
    await db.insert(importSubmissionItems).values({ submissionId, ordinal: 0, path: '/p', title: 'T' });

    await db.delete(importSubmissions).where(eq(importSubmissions.id, submissionId));

    const items = await db.select().from(importSubmissionItems);
    expect(items).toHaveLength(0);
  });

  it('deleting an accepted placeholder book set-nulls bookId while disposition stays accepted (F50)', async () => {
    const submissionId = await seedSubmission();
    const bookId = await seedBook('Placeholder');
    await db
      .insert(importSubmissionItems)
      .values({ submissionId, ordinal: 0, path: '/p', title: 'T', disposition: 'accepted', bookId });

    await db.delete(books).where(eq(books.id, bookId));

    const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, submissionId));
    expect(item!.bookId).toBeNull();
    expect(item!.disposition).toBe('accepted');
  });

  it('deleting an incumbent book set-nulls existingBookId but keeps existingTitle + item + header', async () => {
    const submissionId = await seedSubmission();
    const incumbentId = await seedBook('Incumbent');
    await db.insert(importSubmissionItems).values({
      submissionId,
      ordinal: 0,
      path: '/p',
      title: 'T',
      disposition: 'skipped',
      reason: 'already-in-library',
      existingBookId: incumbentId,
      existingTitle: 'Incumbent',
    });

    await db.delete(books).where(eq(books.id, incumbentId));

    const [item] = await db.select().from(importSubmissionItems).where(eq(importSubmissionItems.submissionId, submissionId));
    expect(item!.existingBookId).toBeNull();
    expect(item!.existingTitle).toBe('Incumbent');
    const headers = await db.select().from(importSubmissions).where(eq(importSubmissions.id, submissionId));
    expect(headers).toHaveLength(1);
  });

  it('enforces the unique (submissionId, ordinal) index', async () => {
    const submissionId = await seedSubmission();
    await db.insert(importSubmissionItems).values({ submissionId, ordinal: 0, path: '/p', title: 'T' });
    await expect(
      db.insert(importSubmissionItems).values({ submissionId, ordinal: 0, path: '/p2', title: 'T2' }),
    ).rejects.toThrow();
  });
});
