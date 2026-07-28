import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { OwnedRecordingError, type BookService, type BookWithAuthor } from '../../services/book.service.js';
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
import type { BookMetadata } from '@core/index.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import {
  bookV1Schema,
  bookV1ListQuerySchema,
  createBookV1RequestSchema,
  bookExistsV1Schema,
  toBookV1,
} from '@shared/schemas/v1/books.js';
import { toCompanionEbookV1 } from '@shared/schemas/v1/companion-ebook.js';
import { findCompanionEbooksByBookIds } from '../../services/companion-ebook.repository.js';
import type { CompanionEbookRow } from '../../services/types.js';
import { v1ListResponseSchema, v1PublicIdParamSchema, v1ErrorEnvelopeSchema } from '@shared/schemas/v1/common.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
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
  const primarySeries = pickPrimarySeries(meta);
  const out: CreateBookInput = {
    title: meta.title,
    authors: meta.authors,
    asin: meta.asin ?? requestedAsin,
  };
  copyOptional(out, 'narrators', meta.narrators);
  copyOptional(out, 'subtitle', meta.subtitle);
  copyOptional(out, 'description', meta.description);
  copyOptional(out, 'publisher', meta.publisher);
  copyOptional(out, 'coverUrl', meta.coverUrl);
  copyOptional(out, 'isbn', meta.isbn);
  copyOptional(out, 'seriesName', primarySeries?.name);
  copyOptional(out, 'seriesPosition', primarySeries?.position);
  copyOptional(out, 'duration', meta.duration);
  copyOptional(out, 'publishedDate', meta.publishedDate);
  copyOptional(out, 'genres', meta.genres);
  copyOptional(out, 'providerId', meta.providerId);
  // Recording production form (#1731). Gate on presence: `normalizeProductionType`
  // never returns undefined, so piping it unconditionally would write an explicit
  // 'unknown' for ASINs with no formatType, regressing the absent-input contract.
  if (meta.formatType) copyOptional(out, 'productionType', normalizeProductionType(meta.formatType));
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

/**
 * Read `quality` ONCE, fail-open, for the add-by-ASIN path (#1545). On a
 * successful read, gate the add on reject-words using the SAME predicate the
 * search filter uses (`isRejectedByWords`) so the add gate and the search cannot
 * drift, and capture `searchImmediately` to reuse after create. On a read
 * failure, fail open (a preference, not a security boundary — mirrors the search
 * filter's posture, #1004): proceed to create AND skip the immediate search. The
 * single read is what makes a thrown read unable to create-then-500.
 */
async function resolveQualityGate(
  deps: V1BooksRouteDeps,
  book: BookMetadata,
  asin: string,
  log: FastifyBaseLogger,
): Promise<{ rejected: boolean; searchImmediately: boolean }> {
  try {
    const quality = await deps.settingsService.get('quality');
    if (isRejectedByWords(book, quality.rejectWords)) {
      log.info({ asin }, 'v1 add-by-ASIN: edition rejected by reject-words filter');
      return { rejected: true, searchImmediately: false };
    }
    return { rejected: false, searchImmediately: quality.searchImmediately };
  } catch (err: unknown) {
    log.warn(
      { asin, error: serializeError(err) },
      'v1 add-by-ASIN: failed to read quality settings — proceeding without reject gate, skipping immediate search',
    );
    return { rejected: false, searchImmediately: false };
  }
}

/**
 * Post-create tail: record the `manual` `book_added` event and, when the
 * operator opted in, fire the immediate search. Both are FIRE-AND-FORGET — the
 * caller returns `201` immediately and neither is awaited nor allowed to surface
 * an error. `searchImmediately` is the value captured by the single quality read
 * in `resolveQualityGate`.
 */
function recordCreateAndMaybeSearch(
  book: BookWithAuthor,
  searchImmediately: boolean,
  asin: string,
  deps: V1BooksRouteDeps,
  log: FastifyBaseLogger,
): void {
  deps.eventHistory
    .create({
      bookId: book.id,
      ...snapshotBookForEvent(book),
      eventType: 'book_added',
      source: 'manual',
    })
    .catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record book_added event'));

  log.info({ asin, publicId: book.publicId }, 'v1 add-by-ASIN: book created');

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
      log,
    );
  }
}

/** What `loadCompanionContext` resolves for a page (or a single row): the feature
 *  flag plus the batch-loaded observations keyed by numeric `books.id`. */
interface CompanionContext {
  enabled: boolean;
  byBookId: Map<number, CompanionEbookRow>;
}

/**
 * Resolve `{ enabled, byBookId }` for a set of numeric book ids — the ONE
 * best-effort guard for both book GETs (#1961 AC 23a).
 *
 * `GET /api/v1/books` and `GET /api/v1/books/:publicId` read no settings at all
 * today (only `POST` does). Adding two dependencies to a working read endpoint
 * without a guard would let a transient `SettingsService` DB failure or a
 * companion-repository rejection propagate to `v1ErrorHandler`'s catch-all `500`
 * and turn two previously-working reads into 500s — "purely additive" has to hold
 * on the failure path too. So BOTH reads sit inside ONE try/catch: any rejection
 * logs exactly one warn and degrades to `{ enabled: false, byBookId: empty }`,
 * projecting `companionEbook: null` on every row and leaving the rest of the
 * response byte-identical to today's.
 *
 * Scope limit: this covers the companion enrichment ONLY. A failure of the core
 * book query still surfaces exactly as it does today.
 *
 * When the feature is disabled — or there are no rows — NO companion query is
 * issued. Otherwise `findCompanionEbooksByBookIds` chunks at 480, so a max-page
 * request (`limit=500`) costs two companion selects, not 500.
 */
async function loadCompanionContext(
  db: Db,
  settingsService: SettingsService,
  bookIds: number[],
  log: FastifyBaseLogger,
): Promise<CompanionContext> {
  try {
    const { enabled } = await settingsService.get('companionEpub');
    if (!enabled || bookIds.length === 0) return { enabled, byBookId: new Map() };
    return { enabled, byBookId: await findCompanionEbooksByBookIds(db, bookIds) };
  } catch (error: unknown) {
    log.warn(
      { error: serializeError(error) },
      'v1 books: companion-ebook enrichment failed — projecting companionEbook: null',
    );
    return { enabled: false, byBookId: new Map() };
  }
}

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
          const { enabled, byBookId } = await loadCompanionContext(
            db,
            deps.settingsService,
            data.map((row) => row.id),
            request.log,
          );
          // An explicit closure, NOT `data.map(toBookV1)`: `Array.map` passes the
          // array INDEX as the second argument, which would ship a numeric
          // `companionEbook`.
          return {
            data: data.map((row) =>
              toBookV1(
                row,
                toCompanionEbookV1({ enabled, bookStatus: row.status, observation: byBookId.get(row.id) }),
              ),
            ),
            total,
          };
        },
      );

      typed.get(
        '/books/:publicId',
        {
          schema: {
            params: v1PublicIdParamSchema,
            response: { 200: bookV1Schema, 400: v1ErrorEnvelopeSchema, 404: v1ErrorEnvelopeSchema },
          },
        },
        // The companion load happens inside the ASYNC `fetch` callback, which
        // returns a tuple; `project` then stays trivially synchronous. That is
        // why `_helpers.ts`'s `project: (row) => TDto` contract — shared by five
        // v1 routes — needs no change at all. A missing book still returns `null`
        // from `fetch`, so the 404 behaviour is untouched.
        async (request) =>
          fetchByPublicId(
            db,
            books,
            request.params.publicId,
            async (rowid) => {
              const book = await deps.bookService.getById(rowid);
              if (book === null) return null;
              const { enabled, byBookId } = await loadCompanionContext(
                db,
                deps.settingsService,
                [book.id],
                request.log,
              );
              return {
                book,
                companionEbook: toCompanionEbookV1({
                  enabled,
                  bookStatus: book.status,
                  observation: byBookId.get(book.id),
                }),
              };
            },
            ({ book, companionEbook }) => toBookV1(book, companionEbook),
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

          // Find-by-ASIN first (#1711). Add-by-ASIN is ASIN-only; an exact-ASIN
          // incumbent resolves to `same-recording` (the resolver's authoritative
          // ASIN-equal rule) → 409. A free ASIN gathers no incumbent →
          // `different-recording` (book: null) → proceed.
          const resolution = await deps.bookService.findDuplicate({ title: '', asin });
          if (resolution.verdict !== 'different-recording' && resolution.book) {
            request.log.info({ asin, existingId: resolution.book.publicId }, 'v1 add-by-ASIN: book already in library');
            return reply.status(409).send({
              error: { code: 'book_exists', message: 'A book with this ASIN already exists' },
              existingId: resolution.book.publicId,
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

          const gate = await resolveQualityGate(deps, lookup.book, asin, request.log);
          if (gate.rejected) {
            return reply
              .status(422)
              .send(envelope('edition_rejected', "This edition is excluded by the library owner's reject-words filter"));
          }

          let book;
          try {
            book = await deps.bookService.create(metadataToCreatePayload(lookup.book, asin));
          } catch (error: unknown) {
            // Same-ASIN create-time race (#1711) — the recording is already owned.
            if (error instanceof OwnedRecordingError) {
              const owner = await deps.bookService.getById(error.existingBookId);
              if (owner) {
                request.log.info({ asin, existingId: owner.publicId }, 'v1 add-by-ASIN: book already in library (ASIN race)');
                return reply.status(409).send({
                  error: { code: 'book_exists', message: 'A book with this ASIN already exists' },
                  existingId: owner.publicId,
                });
              }
            }
            throw error;
          }

          recordCreateAndMaybeSearch(book, gate.searchImmediately, asin, deps, request.log);

          // Explicit `null`: a freshly created book is `wanted`, so the mapper's
          // `imported` term forces `null` regardless of feature state. No
          // settings read and no companion query is added to the create path.
          return reply.status(201).send(toBookV1(book, null));
        },
      );
    },
    { prefix: '/api/v1' },
  );
}
