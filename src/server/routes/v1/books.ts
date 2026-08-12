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
import { decideIntake } from '../../services/book-intake/index.js';
import type { BlacklistService } from '../../services/blacklist.service.js';
import type { DownloadOrchestrator } from '../../services/download-orchestrator.js';
import type { EventBroadcasterService } from '../../services/event-broadcaster.service.js';
import type { FixMatchLookupResult } from '../../services/metadata-fix-match.js';
import { triggerImmediateSearch } from '../../services/trigger-immediate-search.js';
import { announceBookAdded, bookAddedSnapshotEvent } from '../../utils/event-helpers.js';
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
  metadataService: MetadataService;
  downloadOrchestrator: DownloadOrchestrator;
  indexerSearchService: IndexerSearchService;
  indexerService: IndexerService;
  blacklistService: BlacklistService;
  settingsService: SettingsService;
  eventHistory: EventHistoryService;
  eventBroadcaster?: EventBroadcasterService | undefined;
}

/** Derived from BookService.create so the metadata mapping stays in sync. */
type CreateBookInput = Parameters<BookService['create']>[0];

function envelope(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** exactOptionalPropertyTypes requires absent fields, not explicit undefined. */
function copyOptional<K extends keyof CreateBookInput>(
  target: CreateBookInput,
  key: K,
  value: CreateBookInput[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Mirrors the Fix Match field mapping for the create shape. Fall back to the requested ASIN:
 * a null stored ASIN bypasses the partial unique index and breaks retry safety.
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
  // Normalize only a present formatType; absence must not become explicit unknown.
  if (meta.formatType) copyOptional(out, 'productionType', normalizeProductionType(meta.formatType));
  return out;
}

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
 * Read quality once and use the search predicate so reject-word behavior cannot drift.
 * Preference failures fail open for creation but skip search; reading before create prevents create-then-500.
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

/** Event recording and the captured immediate-search preference are fire-and-forget. */
function recordCreateAndMaybeSearch(
  book: BookWithAuthor,
  searchImmediately: boolean,
  asin: string,
  deps: V1BooksRouteDeps,
  log: FastifyBaseLogger,
): void {
  announceBookAdded(() => deps.eventHistory.create(bookAddedSnapshotEvent(book, 'manual')), book.id, log);

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

interface CompanionContext {
  enabled: boolean;
  byBookId: Map<number, CompanionEbookRow>;
}

/**
 * Companion enrichment is best-effort: either read failing degrades the whole page to disabled/empty.
 * Core book-query failures remain fatal. Disabled or empty pages skip the companion query; the repository chunks ids.
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
 * Encapsulation keeps the v1 error handler off internal routes. Status filters use exact canonical
 * states rather than library buckets, and strict response schemas fail closed on internal-field leaks.
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
          // exactOptionalPropertyTypes requires conditional spreads, not explicit undefined.
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
          // Do not pass toBookV1 directly: Array.map supplies its index as companionEbook.
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
        // Load companions in async fetch so the shared project contract stays synchronous; null still maps to 404.
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

      // Apply the same reject-word gate as search so an out-of-band ASIN cannot bypass it.
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

          // v1 adopts the shared decision but not the shared pipeline: the probe stays AHEAD of the
          // lookup so an owned ASIN 409s while the provider is down, and the arms below keep v1's
          // own five-way failure taxonomy and its reject-word gate, which `addBook` has no seam for.
          // An incumbent-less non-admit arm falls through: the 409 body has no `existingId` to send.
          const decision = await decideIntake({ bookService: deps.bookService }, { item: { title: '', asin } });
          if (decision.kind !== 'admit' && decision.incumbent) {
            request.log.info({ asin, existingId: decision.incumbent.publicId }, 'v1 add-by-ASIN: book already in library');
            return reply.status(409).send({
              error: { code: 'book_exists', message: 'A book with this ASIN already exists' },
              existingId: decision.incumbent.publicId,
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
            // A concurrent same-ASIN create means the recording is already owned.
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

          // Freshly created wanted books force null without companion reads.
          return reply.status(201).send(toBookV1(book, null));
        },
      );
    },
    { prefix: '/api/v1' },
  );
}
