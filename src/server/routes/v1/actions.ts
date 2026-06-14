import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../../db/index.js';
import { books, downloads } from '../../../db/schema.js';
import type { BookService } from '../../services/book.service.js';
import type { IndexerSearchService } from '../../services/indexer-search.service.js';
import type { DownloadOrchestrator, GrabParams } from '../../services/download-orchestrator.js';
import type { DownloadService } from '../../services/download.service.js';
import { DuplicateDownloadError } from '../../services/download.service.js';
import { DownloadClientError, DownloadClientAuthError, DownloadClientTimeoutError } from '../../../core/download-clients/errors.js';
import { buildSearchQuery } from '../../services/search-pipeline.js';
import { resolveByPublicId } from '../../utils/public-id.js';
import { downloadV1Schema, toDownloadV1 } from '../../../shared/schemas/v1/downloads.js';
import { v1ListResponseSchema, v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';
import {
  releaseV1Schema,
  grabV1RequestSchema,
  toReleaseV1,
  decodeReleaseId,
  type ReleaseTokenPayload,
} from '../../../shared/schemas/v1/actions.js';
import { V1NotFoundError, v1ErrorHandler } from './_helpers.js';

// ============================================================================
// Public API v1 — Action endpoints: search + grab (idempotent) (S6 — #1452)
// ============================================================================
//
// The request-app write path is search-THEN-grab (NOT entity-POST). Both
// endpoints map onto the existing internal `IndexerSearchService` +
// `DownloadOrchestrator` services — no new download/grab core logic. The
// load-bearing requirement is GRAB IDEMPOTENCY: a public client that retries on
// a timeout (the response was lost, not the grab) must not produce a second
// download. The internal grab path has only the per-book active-download guard,
// which is neither release-level nor race-safe, so this layer adds an explicit
// release-level dedup + an in-process keyed mutex (see below). The download
// services are NOT modified.

export interface V1ActionsRouteDeps {
  bookService: BookService;
  indexerSearchService: IndexerSearchService;
  downloadOrchestrator: DownloadOrchestrator;
  downloadService: DownloadService;
}

/** `:publicId` path param. `.strict()` per the v1 owned-schema convention. */
const publicIdParamSchema = z.object({ publicId: z.string().min(1) }).strict();

/** Build a v1 error envelope body (`{ error: { code, message } }`). */
function envelope(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

// ----------------------------------------------------------------------------
// Idempotency — release identity, dedup lookup, in-process keyed mutex
// ----------------------------------------------------------------------------

/**
 * Canonical release identity for the dedup key, by the SAME precedence as the
 * matching predicate below: `guid` (scoped to `indexerId` when present) →
 * search-time `infoHash` (normalized lowercase) → raw `downloadUrl`. Combined
 * with the resolved `bookId` it forms the mutex key, so two retries of the same
 * release for the same book serialize against one critical section.
 */
function canonicalReleaseIdentity(payload: ReleaseTokenPayload): string {
  if (payload.guid) return `guid:${payload.indexerId ?? ''}:${payload.guid}`;
  if (payload.infoHash) return `hash:${payload.infoHash.toLowerCase()}`;
  return `url:${payload.downloadUrl}`;
}

/**
 * Find an existing download for `bookId` that matches the decoded release token,
 * returning its rowid or `null`. Matches against the persisted `downloads`
 * columns in precedence order:
 *   1. `guid` (scoped to `indexerId` when the token carries one — strict equality,
 *      so a persisted null/different indexerId does NOT match) — primary,
 *      reliable: `guid` is stored verbatim from the grab params and is available
 *      at search time.
 *   2. search-time `infoHash` (normalized lowercase) vs stored `info_hash` —
 *      secondary. The stored hash is computed late from the resolved artifact, so
 *      it only matches once that row's grab reached artifact resolution; it is a
 *      supplement to, not a replacement for, the `guid` match.
 *   3. raw search-time `downloadUrl` vs stored `download_url` — last-resort
 *      fallback, only when neither `guid` nor `infoHash` is present. KNOWN
 *      DEGRADATION: the stored URL is the *effective* (adapter-rewritten) URL, so
 *      this can miss when the adapter rewrites it. Accepted because real indexer
 *      results carry a `guid` (the only current rewrite path, MAM, emits one), so
 *      this fallback never decides identity for a real public response — the
 *      same-release idempotency guarantee holds for reachable real results.
 */
async function findExistingDownloadId(db: Db, bookId: number, payload: ReleaseTokenPayload): Promise<number | null> {
  const rows = await db
    .select({ id: downloads.id, guid: downloads.guid, infoHash: downloads.infoHash, downloadUrl: downloads.downloadUrl, indexerId: downloads.indexerId })
    .from(downloads)
    .where(eq(downloads.bookId, bookId));

  if (payload.guid) {
    // Scope guid to indexerId when the token carries one: require strict
    // equality, so a token with `{ guid, indexerId: 3 }` does NOT dedup against a
    // persisted same-guid row whose indexerId is null or a different indexer. A
    // token with no indexerId matches on guid alone.
    const match = rows.find(
      (r) => r.guid === payload.guid && (payload.indexerId === undefined || r.indexerId === payload.indexerId),
    );
    if (match) return match.id;
  }

  if (payload.infoHash) {
    const norm = payload.infoHash.toLowerCase();
    const match = rows.find((r) => r.infoHash !== null && r.infoHash.toLowerCase() === norm);
    if (match) return match.id;
  }

  if (!payload.guid && !payload.infoHash && payload.downloadUrl) {
    const match = rows.find((r) => r.downloadUrl === payload.downloadUrl);
    if (match) return match.id;
  }

  return null;
}

/**
 * In-process async keyed mutex. Serializes `lookup → (on miss) grab+insert →
 * return` per `(bookId, canonicalReleaseIdentity)` so concurrent identical grabs
 * resolve to exactly one download row: the loser awaits the winner, then its
 * post-lock lookup finds the just-inserted row. Sufficient and migration-free
 * BECAUSE narratorr runs as a single Node process (the documented single-user
 * self-hosted threat model). The tail stored per key never rejects, so a failing
 * critical section does not poison the next caller; the key is evicted once its
 * section settles and no successor has queued behind it.
 */
const releaseLocks = new Map<string, Promise<unknown>>();

async function withReleaseLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = releaseLocks.get(key) ?? Promise.resolve();
  // Run our section after the predecessor settles (resolve OR reject).
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  releaseLocks.set(key, tail);
  void tail.then(() => {
    if (releaseLocks.get(key) === tail) releaseLocks.delete(key);
  });
  return run;
}

/** Reconstruct `GrabParams` from a decoded release token + resolved bookId. */
function buildGrabParams(payload: ReleaseTokenPayload, bookId: number): GrabParams {
  return {
    downloadUrl: payload.downloadUrl,
    title: payload.title,
    protocol: payload.protocol,
    bookId,
    source: 'manual',
    ...(payload.guid !== undefined && { guid: payload.guid }),
    ...(payload.indexerId !== undefined && { indexerId: payload.indexerId }),
    ...(payload.size !== undefined && { size: payload.size }),
    ...(payload.seeders !== undefined && { seeders: payload.seeders }),
    ...(payload.isFreeleech !== undefined && { isFreeleech: payload.isFreeleech }),
  };
}

/**
 * Map the typed grab errors the route must shape itself into a v1 envelope.
 * `v1ErrorHandler` maps not-found/validation/generic only, so the route handles
 * `DuplicateDownloadError` (→ 409) and `DownloadClientError` subclasses
 * (→ 401/502/504) inline, mirroring the internal `/api/search/grab` mapping but
 * re-shaped to the v1 envelope. Fixed messages keep any client URL out of the
 * envelope. Returns `null` for errors it does not own (rethrown → 500 envelope).
 */
function mapGrabError(error: unknown, reply: FastifyReply): FastifyReply | null {
  if (error instanceof DuplicateDownloadError) {
    return reply.status(409).send(envelope(error.code, 'Book already has an active download'));
  }
  if (error instanceof DownloadClientAuthError) {
    return reply.status(401).send(envelope('DOWNLOAD_CLIENT_AUTH_FAILED', 'Download client authentication failed'));
  }
  if (error instanceof DownloadClientTimeoutError) {
    return reply.status(504).send(envelope('DOWNLOAD_CLIENT_TIMEOUT', 'Download client request timed out'));
  }
  if (error instanceof DownloadClientError) {
    return reply.status(502).send(envelope('DOWNLOAD_CLIENT_ERROR', 'Download client error'));
  }
  return null;
}

/**
 * Native public API v1 — action endpoints (search + grab). Registered inside an
 * ENCAPSULATED plugin so the v1-scoped `v1ErrorHandler` (v1 error envelope) does
 * not leak onto internal `/api/*` routes. API-key auth is inherited via the
 * global `/api/v*` `onRequest` hook. The opaque `releaseId` is carried in the
 * request BODY, never a path param (keeps it clear of Fastify's 100-char
 * `maxParamLength` cap; learning `fastify-max-param-length-100-default`).
 */
export async function v1ActionsRoutes(app: FastifyInstance, deps: V1ActionsRouteDeps, db: Db): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      // POST /api/v1/books/:publicId/search — candidate releases for the book.
      typed.post(
        '/books/:publicId/search',
        {
          schema: {
            params: publicIdParamSchema,
            response: { 200: v1ListResponseSchema(releaseV1Schema), 400: v1ErrorEnvelopeSchema, 404: v1ErrorEnvelopeSchema },
          },
        },
        async (request, reply) => {
          const book = await resolveBookOr404(db, deps, request.params.publicId);

          // `searchAll` returns `[]` for a query that normalizes away, so we can't
          // distinguish "no matches" from "bad query" downstream — pre-check the
          // derived query and 400 before calling it (mirrors the internal
          // /api/search/stream empty-query guard).
          const query = buildSearchQuery(book);
          if (!query) {
            return reply.status(400).send(envelope('BAD_REQUEST', 'Search query is empty after normalization'));
          }

          const author = book.authors?.[0]?.name;
          const results = await deps.indexerSearchService.searchAll(query, {
            title: book.title,
            ...(author !== undefined && { author }),
          });
          return { data: results.map(toReleaseV1), total: results.length };
        },
      );

      // POST /api/v1/books/:publicId/grab — grab a release from the search list.
      typed.post(
        '/books/:publicId/grab',
        {
          schema: {
            params: publicIdParamSchema,
            body: grabV1RequestSchema,
            response: {
              200: downloadV1Schema,
              201: downloadV1Schema,
              400: v1ErrorEnvelopeSchema,
              401: v1ErrorEnvelopeSchema,
              404: v1ErrorEnvelopeSchema,
              409: v1ErrorEnvelopeSchema,
              500: v1ErrorEnvelopeSchema,
              502: v1ErrorEnvelopeSchema,
              504: v1ErrorEnvelopeSchema,
            },
          },
        },
        async (request, reply) => {
          const book = await resolveBookOr404(db, deps, request.params.publicId);

          const payload = decodeReleaseId(request.body.releaseId);
          if (!payload) {
            return reply.status(400).send(envelope('BAD_REQUEST', 'Invalid releaseId'));
          }

          const key = `${book.id}::${canonicalReleaseIdentity(payload)}`;
          try {
            const { download, created } = await withReleaseLock(key, async () => {
              const existingId = await findExistingDownloadId(db, book.id, payload);
              if (existingId !== null) {
                const existing = await deps.downloadService.getById(existingId);
                if (existing) return { download: existing, created: false };
              }
              const grabbed = await deps.downloadOrchestrator.grab(buildGrabParams(payload, book.id));
              return { download: grabbed, created: true };
            });
            return await reply.status(created ? 201 : 200).send(toDownloadV1(download));
          } catch (error: unknown) {
            const mapped = mapGrabError(error, reply);
            if (mapped) return mapped;
            throw error; // V1NotFoundError / generic → v1ErrorHandler (404 / 500)
          }
        },
      );
    },
    { prefix: '/api/v1' },
  );
}

/** Resolve `:publicId` → hydrated book, or throw `V1NotFoundError` (→ 404). */
async function resolveBookOr404(db: Db, deps: V1ActionsRouteDeps, publicId: string) {
  const rowid = await resolveByPublicId(db, books, publicId);
  if (rowid === null) throw new V1NotFoundError();
  const book = await deps.bookService.getById(rowid);
  if (!book) throw new V1NotFoundError();
  return book;
}
