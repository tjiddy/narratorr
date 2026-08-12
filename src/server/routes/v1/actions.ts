import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import { books, downloads } from '@db/schema.js';
import type { BookService } from '../../services/book.service.js';
import type { IndexerSearchService } from '../../services/indexer-search.service.js';
import type { IndexerService } from '../../services/indexer.service.js';
import type { BlacklistService } from '../../services/blacklist.service.js';
import type { SettingsService } from '../../services/settings.service.js';
import type { DownloadOrchestrator, GrabParams } from '../../services/download-orchestrator.js';
import type { DownloadService } from '../../services/download.service.js';
import { DuplicateDownloadError } from '../../services/download-errors.js';
import { DownloadClientError, DownloadClientAuthError, DownloadClientTimeoutError } from '@core/download-clients/errors.js';
import { resolveBookQualityInputs } from '@core/utils/index.js';
import { buildSearchQuery, postProcessSearchResults } from '../../services/search-pipeline.js';
import { buildQueryLadder, runQueryLadder } from '../../services/search-query-ladder.js';
import { createAggregateExecutor } from '../../services/search-ladder-execution.js';
import { resolveByPublicId } from '../../utils/public-id.js';
import { downloadV1Schema, toDownloadV1 } from '@shared/schemas/v1/downloads.js';
import { v1ListResponseSchema, v1PublicIdParamSchema, v1ErrorEnvelopeSchema } from '@shared/schemas/v1/common.js';
import {
  releaseV1Schema,
  grabV1RequestSchema,
  toReleaseV1,
  type ReleaseTokenPayload,
} from '@shared/schemas/v1/actions.js';
import { signReleaseId, verifyReleaseId } from '../../services/grab-token.js';
import { V1NotFoundError, v1ErrorHandler } from './_helpers.js';

// V1 grab retries are release-idempotent: lookup and grab serialize by book and release identity.

export interface V1ActionsRouteDeps {
  bookService: BookService;
  indexerSearchService: IndexerSearchService;
  downloadOrchestrator: DownloadOrchestrator;
  downloadService: DownloadService;
  // Search fan-out and NZB-fetch allowlisting are separate services despite their similar names.
  blacklistService: BlacklistService;
  settingsService: SettingsService;
  indexerService: IndexerService;
}

function envelope(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** Keep identity precedence aligned with lookup: scoped GUID, normalized hash, then raw URL. */
function canonicalReleaseIdentity(payload: ReleaseTokenPayload): string {
  if (payload.guid) return `guid:${payload.indexerId ?? ''}:${payload.guid}`;
  if (payload.infoHash) return `hash:${payload.infoHash.toLowerCase()}`;
  return `url:${payload.downloadUrl}`;
}

/** Hash may not persist until artifact resolution. Raw-URL fallback can miss adapter rewrites;
 * reachable rewritten results currently carry a GUID. */
async function findExistingDownloadId(db: Db, bookId: number, payload: ReleaseTokenPayload): Promise<number | null> {
  const rows = await db
    .select({ id: downloads.id, guid: downloads.guid, infoHash: downloads.infoHash, downloadUrl: downloads.downloadUrl, indexerId: downloads.indexerId })
    .from(downloads)
    .where(eq(downloads.bookId, bookId));

  if (payload.guid) {
    // A token-supplied indexer must match strictly; an absent indexer leaves GUID unscoped.
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

/** Serialize lookup-to-grab per release; this relies on the documented single-process deployment.
 * Store a non-rejecting tail so failures cannot poison successors, and evict only the latest tail. */
const releaseLocks = new Map<string, Promise<unknown>>();

async function withReleaseLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = releaseLocks.get(key) ?? Promise.resolve();
  // Run after the predecessor whether it fulfilled or rejected.
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  releaseLocks.set(key, tail);
  void tail.then(() => {
    if (releaseLocks.get(key) === tail) releaseLocks.delete(key);
  });
  return run;
}

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

/** Map typed grab failures to fixed, URL-free v1 messages; unknown errors go to `v1ErrorHandler`. */
function mapGrabError(error: unknown, reply: FastifyReply): FastifyReply | null {
  if (error instanceof DuplicateDownloadError) {
    // PIPELINE_ACTIVE may mean QG-completed work or a pending auto import, not only a download row.
    const message = error.code === 'ACTIVE_DOWNLOAD_EXISTS'
      ? 'Book already has an active download'
      : 'Book already has a download in the import pipeline';
    return reply.status(409).send(envelope(error.code, message));
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

/** Keep the v1 error handler encapsulated away from internal routes. `releaseId` stays in the body
 * because Fastify path params default to a 100-character limit. */
export async function v1ActionsRoutes(app: FastifyInstance, deps: V1ActionsRouteDeps, db: Db): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.post(
        '/books/:publicId/search',
        {
          schema: {
            params: v1PublicIdParamSchema,
            response: { 200: v1ListResponseSchema(releaseV1Schema), 400: v1ErrorEnvelopeSchema, 404: v1ErrorEnvelopeSchema },
          },
        },
        async (request, reply) => {
          const book = await resolveBookOr404(db, deps, request.params.publicId);

          // Downstream treats an empty normalized query as no matches, so reject it here.
          const query = buildSearchQuery(book);
          if (!query) {
            return reply.status(400).send(envelope('BAD_REQUEST', 'Search query is empty after normalization'));
          }

          // Discovery runs the full relaxation ladder without exposing rung metadata.
          const author = book.authors?.[0]?.name;
          const ladder = buildQueryLadder({ title: book.title, author, query });
          const { results: allResults } = await runQueryLadder(
            ladder,
            createAggregateExecutor(book, deps.indexerSearchService),
          );

          // Match UI filtering/ranking; `total` counts filtered results and duration uses the shared resolver.
          // This is presentation parity, not enforcement: stable no-TTL tokens are not re-searched on grab.
          const { durationSeconds } = resolveBookQualityInputs(book);
          const processed = await postProcessSearchResults(
            allResults,
            durationSeconds ?? undefined,
            deps.blacklistService,
            deps.settingsService,
            deps.indexerService,
            request.log,
          );
          return { data: processed.results.map((r) => toReleaseV1(r, signReleaseId)), total: processed.results.length };
        },
      );

      typed.post(
        '/books/:publicId/grab',
        {
          schema: {
            params: v1PublicIdParamSchema,
            body: grabV1RequestSchema,
            response: {
              200: downloadV1Schema,
              201: downloadV1Schema,
              400: v1ErrorEnvelopeSchema,
              401: v1ErrorEnvelopeSchema,
              404: v1ErrorEnvelopeSchema,
              409: v1ErrorEnvelopeSchema.describe(
                'Conflict — the book already has a blocking download. `code` is `ACTIVE_DOWNLOAD_EXISTS` when a replaceable client-stage download exists, or `PIPELINE_ACTIVE` when a download has entered the import pipeline (checking, pending_review, importing), a completed download is awaiting the quality gate, or an auto import job is pending.',
              ),
              500: v1ErrorEnvelopeSchema,
              502: v1ErrorEnvelopeSchema,
              504: v1ErrorEnvelopeSchema,
            },
          },
        },
        async (request, reply) => {
          const book = await resolveBookOr404(db, deps, request.params.publicId);

          const payload = verifyReleaseId(request.body.releaseId);
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
            throw error;
          }
        },
      );
    },
    { prefix: '/api/v1' },
  );
}

async function resolveBookOr404(db: Db, deps: V1ActionsRouteDeps, publicId: string) {
  const rowid = await resolveByPublicId(db, books, publicId);
  if (rowid === null) throw new V1NotFoundError();
  const book = await deps.bookService.getById(rowid);
  if (!book) throw new V1NotFoundError();
  return book;
}
