import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../../db/index.js';
import { books } from '../../../db/schema.js';
import type { BookService } from '../../services/book.service.js';
import type { BookListService } from '../../services/book-list.service.js';
import type {
  MetadataService,
  SettingsService,
  EventHistoryService,
  IndexerSearchService,
  IndexerService,
} from '../../services/index.js';
import { isRejectedByWords } from '../../services/index.js';
import type { BlacklistService } from '../../services/blacklist.service.js';
import type { DownloadOrchestrator } from '../../services/download-orchestrator.js';
import type { EventBroadcasterService } from '../../services/event-broadcaster.service.js';
import type { FixMatchLookupResult } from '../../services/metadata-fix-match.js';
import { triggerImmediateSearch } from '../../services/trigger-immediate-search.js';
import { snapshotBookForEvent } from '../../utils/event-helpers.js';
import { serializeError } from '../../utils/serialize-error.js';
import type { BookMetadata } from '../../../core/index.js';
import {
  bookV1Schema,
  bookV1ListQuerySchema,
  createBookV1RequestSchema,
  bookExistsV1Schema,
  toBookV1,
} from '../../../shared/schemas/v1/books.js';
import { v1ListResponseSchema, v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';
import { fetchByPublicId, v1ErrorHandler } from './_helpers.js';

export interface V1BooksRouteDeps {
  bookService: BookService;
  bookListService: BookListService;
  // Add-by-ASIN (POST) deps — the same set the internal `POST /api/books` route
  // takes (`src/server/routes/books.ts`): hydrate the ASIN, create the book,
  // record the event, and (operator-gated) fire the immediate search.
  metadataService: MetadataService;
  downloadOrchestrator: DownloadOrchestrator;
  indexerSearchService: IndexerSearchService;
  indexerService: IndexerService;
  blacklistService: BlacklistService;
  settingsService: SettingsService;
  eventHistory: EventHistoryService;
  eventBroadcaster?: EventBroadcasterService | undefined;
}

/** The exact input shape `BookService.create` accepts — derived from the
 *  service so the metadata→create mapping stays in lockstep with it. */
type CreateBookInput = Parameters<BookService['create']>[0];

/** Build a v1 error envelope body (`{ error: { code, message } }`). */
function envelope(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** Copy an optional field onto the create payload only when defined, so a
 *  `.optional()` create field stays ABSENT rather than explicit-`undefined`
 *  (exactOptionalPropertyTypes). Mirrors the Fix Match mapper's `copyOptional`. */
function copyOptional<K extends keyof CreateBookInput>(
  target: CreateBookInput,
  key: K,
  value: CreateBookInput[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Project an ok `BookMetadata` into the `BookService.create` payload. Mirrors
 * the Fix Match series/field logic (`metadataToFixMatchUpdate`) but targets the
 * create shape, NOT `FixMatchReplacement`. Key divergence: persist the REQUESTED
 * ASIN as a fallback (`meta.asin ?? requestedAsin`) — `BookMetadata.asin` is
 * optional, and storing a NULL asin would defeat the partial unique index on
 * `books.asin`, breaking the find-by-ASIN retry-safety guarantee.
 */
function metadataToCreatePayload(meta: BookMetadata, requestedAsin: string): CreateBookInput {
  const primarySeries = meta.seriesPrimary ?? meta.series?.[0];
  const out: CreateBookInput = {
    title: meta.title,
    authors: meta.authors,
    asin: meta.asin ?? requestedAsin,
    seriesProvider: 'audible',
  };
  copyOptional(out, 'narrators', meta.narrators);
  copyOptional(out, 'description', meta.description);
  copyOptional(out, 'coverUrl', meta.coverUrl);
  copyOptional(out, 'isbn', meta.isbn);
  copyOptional(out, 'seriesName', primarySeries?.name);
  copyOptional(out, 'seriesPosition', primarySeries?.position);
  copyOptional(out, 'seriesAsin', meta.seriesPrimary?.asin);
  copyOptional(out, 'duration', meta.duration);
  copyOptional(out, 'publishedDate', meta.publishedDate);
  copyOptional(out, 'genres', meta.genres);
  copyOptional(out, 'providerId', meta.providerId);
  return out;
}

/** Map a non-ok `lookupForFixMatch` outcome to its v1 HTTP status + envelope
 *  fields: `not_found`/`invalid_record` → 422, `rate_limited` → 429,
 *  `transient_failure` → 502. */
function mapLookupFailure(
  lookup: Exclude<FixMatchLookupResult, { kind: 'ok' }>,
): { status: 422 | 429 | 502; code: string; message: string } {
  switch (lookup.kind) {
    case 'not_found':
      return { status: 422, code: 'asin_not_resolved', message: 'ASIN not resolved' };
    case 'invalid_record':
      return { status: 422, code: 'invalid_record', message: 'Incomplete provider record' };
    case 'rate_limited':
      return { status: 429, code: 'rate_limited', message: 'Provider rate limited' };
    case 'transient_failure':
      return { status: 502, code: 'provider_unavailable', message: 'Provider lookup failed' };
  }
}

/** `:publicId` path param. `.strict()` per the v1 owned-schema convention. */
const publicIdParamSchema = z.object({ publicId: z.string().min(1) }).strict();

/**
 * Native public API v1 — Books (read). Registers `GET /api/v1/books` and
 * `GET /api/v1/books/:publicId` inside an ENCAPSULATED plugin so the v1-scoped
 * `setErrorHandler` (v1 error envelope) does not leak onto internal `/api/*`
 * routes. API-key auth is inherited automatically via the global `/api/v*`
 * `onRequest` hook (`src/server/plugins/auth.ts`).
 *
 * The list reuses `BookListService.getAll()` with `exactStatus: true` so the v1
 * `status` filter matches the EXACT canonical state (e.g. `downloading` returns
 * only exactly-`downloading` books, NOT the library `searching+downloading`
 * bucket). Both endpoints declare a Fastify `response` schema and FAIL CLOSED:
 * the `.strict()` `bookV1Schema` rejects any leaked internal field at
 * serialization rather than silently stripping it.
 */
export async function v1BooksRoutes(app: FastifyInstance, deps: V1BooksRouteDeps, db: Db): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/books',
        {
          schema: {
            querystring: bookV1ListQuerySchema,
            response: { 200: v1ListResponseSchema(bookV1Schema), 400: v1ErrorEnvelopeSchema },
          },
        },
        async (request) => {
          const { limit, offset, status, author, series, narrator, sortField, sortDirection } = request.query;
          // Conditional spreads (not explicit `undefined`) to satisfy
          // exactOptionalPropertyTypes, mirroring the internal /api/books route.
          const pagination = {
            ...(limit !== undefined && { limit }),
            ...(offset !== undefined && { offset }),
          };
          const options = {
            exactStatus: true,
            ...(author !== undefined && { author }),
            ...(series !== undefined && { series }),
            ...(narrator !== undefined && { narrator }),
            ...(sortField !== undefined && { sortField }),
            ...(sortDirection !== undefined && { sortDirection }),
          };
          const { data, total } = await deps.bookListService.getAll(status, pagination, options);
          return { data: data.map(toBookV1), total };
        },
      );

      typed.get(
        '/books/:publicId',
        {
          schema: {
            params: publicIdParamSchema,
            response: { 200: bookV1Schema, 400: v1ErrorEnvelopeSchema, 404: v1ErrorEnvelopeSchema },
          },
        },
        async (request) =>
          fetchByPublicId(
            db,
            books,
            request.params.publicId,
            (rowid) => deps.bookService.getById(rowid),
            toBookV1,
          ),
      );

      // POST /api/v1/books — add a book to the library by ASIN. Sonarr-style
      // `POST /series`: find-by-ASIN → 409 (with `existingId`) if present, else
      // hydrate the ASIN via the metadata provider, create the book, record a
      // `manual` `book_added` event, and (operator-gated on
      // `quality.searchImmediately`) fire a fire-and-forget immediate search.
      // 422 outcomes: `asin_not_resolved` (provider miss) and `edition_rejected`
      // (the hydrated edition matches the owner's reject-words filter — the same
      // gate the search applies, enforced here so an out-of-band ASIN can't bypass
      // it).
      typed.post(
        '/books',
        {
          schema: {
            body: createBookV1RequestSchema,
            response: {
              201: bookV1Schema,
              400: v1ErrorEnvelopeSchema,
              409: bookExistsV1Schema,
              422: v1ErrorEnvelopeSchema,
              429: v1ErrorEnvelopeSchema,
              502: v1ErrorEnvelopeSchema,
            },
          },
        },
        async (request, reply) => {
          const { asin } = request.body;

          // Find-by-ASIN first. The ASIN (third arg) short-circuits findDuplicate
          // on its ASIN branch; empty title + no authors are never read on that path.
          const existing = await deps.bookService.findDuplicate('', undefined, asin);
          if (existing) {
            request.log.info({ asin, existingId: existing.publicId }, 'v1 add-by-ASIN: book already in library');
            return reply.status(409).send({
              error: { code: 'book_exists', message: 'A book with this ASIN already exists' },
              existingId: existing.publicId,
            });
          }

          const lookup = await deps.metadataService.lookupForFixMatch(asin);
          if (lookup.kind !== 'ok') {
            const mapped = mapLookupFailure(lookup);
            if (lookup.kind === 'rate_limited') {
              reply.header('Retry-After', Math.ceil(lookup.retryAfterMs / 1000));
            }
            return reply.status(mapped.status).send(envelope(mapped.code, mapped.message));
          }

          // Read `quality` ONCE here, fail-open. On a successful read, gate the
          // add on reject-words using the SAME predicate the search filter uses
          // (`isRejectedByWords`) so the add gate and the search can't drift, and
          // capture `searchImmediately` to reuse after create. On a read failure,
          // fail open (preference, not a security boundary — mirrors the search
          // filter's posture, #1004): proceed to create AND skip the immediate
          // search. Single read ⇒ a thrown read can never create-then-500.
          let searchImmediately = false;
          try {
            const quality = await deps.settingsService.get('quality');
            if (isRejectedByWords(lookup.book, quality.rejectWords)) {
              request.log.info({ asin }, 'v1 add-by-ASIN: edition rejected by reject-words filter');
              return await reply
                .status(422)
                .send(envelope('edition_rejected', "This edition is excluded by the library owner's reject-words filter"));
            }
            searchImmediately = quality.searchImmediately;
          } catch (err: unknown) {
            request.log.warn(
              { asin, error: serializeError(err) },
              'v1 add-by-ASIN: failed to read quality settings — proceeding without reject gate, skipping immediate search',
            );
          }

          const book = await deps.bookService.create(metadataToCreatePayload(lookup.book, asin));

          deps.eventHistory
            .create({
              bookId: book.id,
              ...snapshotBookForEvent(book),
              eventType: 'book_added',
              source: 'manual',
            })
            .catch((err: unknown) =>
              request.log.warn({ error: serializeError(err) }, 'Failed to record book_added event'),
            );

          request.log.info({ asin, publicId: book.publicId }, 'v1 add-by-ASIN: book created');

          // Operator-gated, fire-and-forget — return 201 immediately; never await
          // the search nor surface its error. Mirrors the import-list path. Reuses
          // the `searchImmediately` captured from the single quality read above.
          if (searchImmediately && book.status === 'wanted') {
            triggerImmediateSearch(
              book,
              {
                indexerSearchService: deps.indexerSearchService,
                indexerService: deps.indexerService,
                downloadOrchestrator: deps.downloadOrchestrator,
                settingsService: deps.settingsService,
                blacklistService: deps.blacklistService,
                eventHistory: deps.eventHistory,
                eventBroadcaster: deps.eventBroadcaster,
              },
              request.log,
            );
          }

          return reply.status(201).send(toBookV1(book));
        },
      );
    },
    { prefix: '/api/v1' },
  );
}
