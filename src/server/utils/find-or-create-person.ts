import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { authors, narrators } from '../../db/schema.js';
import { slugify } from '../../shared/utils.js';

/**
 * Find an existing author by slug or create a new one.
 * Handles concurrent creation via try/catch retry on unique constraint violation.
 * Optionally backfills ASIN if the existing author has none.
 *
 * @returns The author's ID (never null — throws on failure).
 */
export async function findOrCreateAuthor(db: DbOrTx, name: string, asin?: string): Promise<number> {
  const slug = slugify(name);
  const existing = await db.select().from(authors).where(eq(authors.slug, slug)).limit(1);

  if (existing.length > 0) {
    if (asin && !existing[0].asin) {
      await db.update(authors).set({ asin }).where(eq(authors.id, existing[0].id));
    }
    return existing[0].id;
  }

  try {
    const inserted = await db.insert(authors).values({ name, slug, asin }).returning();
    return inserted[0].id;
  } catch {
    const retry = await db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    if (retry.length > 0) {
      if (asin && !retry[0].asin) {
        await db.update(authors).set({ asin }).where(eq(authors.id, retry[0].id));
      }
      return retry[0].id;
    }
    throw new Error(`Failed to find or create author: ${name}`);
  }
}

/**
 * Find an existing narrator by slug or create a new one.
 * Handles concurrent creation via try/catch retry on unique constraint violation.
 *
 * @returns The narrator's ID (never null — throws on failure).
 */
export async function findOrCreateNarrator(db: DbOrTx, name: string): Promise<number> {
  const slug = slugify(name);
  const existing = await db.select().from(narrators).where(eq(narrators.slug, slug)).limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  try {
    const inserted = await db.insert(narrators).values({ name, slug }).returning();
    return inserted[0].id;
  } catch {
    const retry = await db.select().from(narrators).where(eq(narrators.slug, slug)).limit(1);
    if (retry.length > 0) {
      return retry[0].id;
    }
    throw new Error(`Failed to find or create narrator: ${name}`);
  }
}
