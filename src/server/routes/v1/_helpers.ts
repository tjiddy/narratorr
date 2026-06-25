import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { DbOrTx } from '../../../db/index.js';
import type { authors, books, downloads, narrators, series } from '../../../db/schema.js';
import { resolveByPublicId } from '../../utils/public-id.js';

// ============================================================================
// Public API v1 — shared route helpers (S3 — #1449)
// ============================================================================
//
// The `:publicId -> rowid -> service -> DTO` plumbing and the v1-scoped error
// handler the encapsulated v1 plugin installs. Everything S4/S5 read endpoints
// build inherits this: opaque-key resolution that 404s the v1 envelope on a
// miss, and an error handler that maps the v1 routes' own validation/not-found
// failures to the canonical `{ error: { code, message } }` envelope (the global
// `/api/*` handler's `{ statusCode, error, message }` shape must NOT leak here).

/** The tables that carry an opaque public id (mirrors `public-id.ts`). */
type PublicIdTable = typeof books | typeof authors | typeof narrators | typeof series | typeof downloads;

/**
 * Thrown by v1 route handlers when an opaque `publicId` resolves to nothing (or
 * a resolved rowid has no matching row). The v1-scoped error handler maps it to
 * a `404` v1 error envelope. Centralizing the not-found signal here keeps the
 * envelope shaping in one place instead of scattered `reply.status(404)` calls.
 */
export class V1NotFoundError extends Error {
  constructor(message = 'Resource not found') {
    super(message);
    this.name = 'V1NotFoundError';
  }
}

/**
 * Resolve an opaque `publicId` to its internal rowid, fetch the row through the
 * supplied service call, and project it through the DTO. Throws
 * `V1NotFoundError` (→ 404 envelope) when the publicId does not resolve or the
 * row is gone. A numeric rowid passed as a publicId never resolves (opaque-key
 * only), so it 404s too.
 */
export async function fetchByPublicId<TRow, TDto>(
  db: DbOrTx,
  table: PublicIdTable,
  publicId: string,
  fetch: (rowid: number) => Promise<TRow | null>,
  project: (row: TRow) => TDto,
): Promise<TDto> {
  const rowid = await resolveByPublicId(db, table, publicId);
  if (rowid === null) throw new V1NotFoundError();
  const row = await fetch(rowid);
  if (row === null) throw new V1NotFoundError();
  return project(row);
}

/**
 * v1-scoped error handler. Maps the failures the v1 routes themselves raise to
 * the canonical `v1ErrorEnvelopeSchema` shape (`{ error: { code, message } }`):
 *   - `V1NotFoundError`            → 404 `NOT_FOUND`
 *   - Fastify validation errors    → 400 `BAD_REQUEST` (unknown param, bounds)
 *   - anything else                → 500 `INTERNAL_ERROR` (no internal leak)
 *
 * Registered inside the encapsulated v1 plugin via `setErrorHandler`, so it is
 * scoped to v1 routes ONLY — internal `/api/*` error shapes are unchanged.
 * Auth `401`s never reach here: the global `onRequest` auth hook replies
 * directly before any route handler runs. The hook now shapes its own envelope
 * for native v1 rejected-key failures — a 401 there carries the v1 envelope
 * `{ error: { code: 'INVALID_API_KEY', message } }` built inline in the auth
 * plugin (#1472), matching `v1ErrorEnvelopeSchema` even though it bypasses this
 * handler. The missing/absent-credential path stays ambient (not a v1 envelope).
 */
export function v1ErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof V1NotFoundError) {
    request.log.warn({ code: 'NOT_FOUND' }, error.message);
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: error.message } });
  }

  if ('validation' in error && error.validation) {
    request.log.warn({ code: 'BAD_REQUEST' }, error.message);
    return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: error.message } });
  }

  request.log.error(error, error.message || 'Unhandled v1 error');
  return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
