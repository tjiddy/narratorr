import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { authors, narrators } from '../../db/schema.js';
import { slugify } from '../../shared/utils.js';

/** Table reference for authors or narrators — both have id + slug columns. */
type PersonTable = typeof authors | typeof narrators;

/**
 * Core find-or-create-by-slug algorithm. Handles concurrent creation
 * via try/catch retry on unique constraint violation.
 *
 * @param onFound - Optional callback invoked when an existing row is found (initial or retry).
 *                  Use for side effects like ASIN backfill.
 * @returns The row's ID (never null — throws on failure).
 */
async function findOrCreateBySlug(
  db: DbOrTx,
  table: PersonTable,
  entityLabel: string,
  name: string,
  slug: string,
  values: Record<string, unknown>,
  onFound?: (db: DbOrTx, row: { id: number }) => Promise<void>,
): Promise<number> {
  const existing = await db.select().from(table).where(eq(table.slug, slug)).limit(1);

  if (existing.length > 0) {
    if (onFound) await onFound(db, existing[0]);
    return existing[0].id;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inserted = await db.insert(table as any).values(values as any).returning() as { id: number }[];
    return inserted[0].id;
  } catch (_error: unknown) {
    const retry = await db.select().from(table).where(eq(table.slug, slug)).limit(1);
    if (retry.length > 0) {
      if (onFound) await onFound(db, retry[0]);
      return retry[0].id;
    }
    throw new Error(`Failed to find or create ${entityLabel}: ${name}`);
  }
}

/**
 * Find an existing author by slug or create a new one.
 * Optionally backfills ASIN if the existing author has none.
 *
 * @returns The author's ID (never null — throws on failure).
 */
export async function findOrCreateAuthor(db: DbOrTx, name: string, asin?: string): Promise<number> {
  const slug = slugify(name);
  return findOrCreateBySlug(
    db,
    authors,
    'author',
    name,
    slug,
    { name, slug, asin },
    asin
      ? async (dbHandle, row) => {
            const full = row as { id: number; asin: string | null };
            if (!full.asin) {
              await dbHandle.update(authors).set({ asin }).where(eq(authors.id, full.id));
            }
          }
      : undefined,
  );
}

/**
 * Find an existing narrator by slug or create a new one.
 *
 * @returns The narrator's ID (never null — throws on failure).
 */
export async function findOrCreateNarrator(db: DbOrTx, name: string): Promise<number> {
  const slug = slugify(name);
  return findOrCreateBySlug(db, narrators, 'narrator', name, slug, { name, slug });
}
