import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '@db/index.js';
import type { authors, books, downloads, narrators, series } from '@db/schema.js';

// Public APIs expose opaque ids; internal FKs, routes, and SSE keep numeric rowids.

// 128 random bits encode to a fixed 22-character base64url body.
const ID_RANDOM_BYTES = 16;

export function generatePublicId(prefix: string): string {
  return `${prefix}_${randomBytes(ID_RANDOM_BYTES).toString('base64url')}`;
}

type PublicIdTable = typeof books | typeof authors | typeof narrators | typeof series | typeof downloads;

export async function resolveByPublicId(
  db: DbOrTx,
  table: PublicIdTable,
  publicId: string,
): Promise<number | null> {
  // Shared column shapes need one representative table to resolve Drizzle's overload.
  const t = table as typeof books;
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(eq(t.publicId, publicId))
    .limit(1);
  return rows[0]?.id ?? null;
}
