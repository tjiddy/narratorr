import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import type { authors, books, downloads, narrators, series } from '../../db/schema.js';

/**
 * Opaque public identity for API-exposed entities (#1443).
 *
 * `publicId` is the stable, non-enumerable key the public `/api/v1` boundary
 * exposes instead of leaking autoincrement rowids. It is identity for the
 * public boundary ONLY — internal FK joins, routing, params, and SSE keep using
 * numeric rowid forever. This module owns generation (at insert) and resolution
 * (opaque key -> rowid) so future serializer/route layers have one entry point.
 */

/**
 * Number of random bytes behind each id body. 16 bytes (128 bits) encodes to a
 * 22-char base64url string — ample collision resistance, URL-safe, fixed length.
 */
const ID_RANDOM_BYTES = 16;

/**
 * Generate a prefixed opaque public id: `<prefix>_<random>`.
 *
 * The body is cryptographically random (not derived from rowid or type), so ids
 * are neither enumerable nor leak insert order. base64url encoding is URL-safe
 * (no characters needing percent-encoding) and produces a stable-length body.
 *
 * Prefixes per entity: books `bk_`, authors `au_`, narrators `nr_`, series
 * `sr_`, downloads `dl_`.
 */
export function generatePublicId(prefix: string): string {
  return `${prefix}_${randomBytes(ID_RANDOM_BYTES).toString('base64url')}`;
}

/** The five entities that carry an opaque public id. */
type PublicIdTable = typeof books | typeof authors | typeof narrators | typeof series | typeof downloads;

/**
 * Resolve an opaque `publicId` back to its internal rowid for the given table,
 * or `null` when no row matches. This is the single resolution entry point a
 * future `/api/v1` serializer/route layer maps an opaque key through.
 *
 * The contract in this story is the rowid-or-null return only; turning a
 * no-match into an HTTP 404 belongs to the route boundary in S3 (#1449).
 */
export async function resolveByPublicId(
  db: DbOrTx,
  table: PublicIdTable,
  publicId: string,
): Promise<number | null> {
  // All five tables share identical { id, publicId } column shapes; narrow to a
  // single representative table so the Drizzle query builder resolves one overload.
  const t = table as typeof books;
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(eq(t.publicId, publicId))
    .limit(1);
  return rows[0]?.id ?? null;
}
