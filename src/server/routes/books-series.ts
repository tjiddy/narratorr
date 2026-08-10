import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addAllSeriesBodySchema, idParamSchema, titleVariantsDebugBodySchema } from '@shared/schemas.js';
import type {
  AddAllSeriesBody,
  TitleVariantsDebugBody,
  TitleVariantsDebugResponse,
  TitleVariantsDebugSide,
} from '@shared/schemas.js';
import { ADD_ALL_IN_FLIGHT_MESSAGE } from '@shared/series-add-all.js';
import { SeriesAddAllService } from '../services/series-add-all.service.js';
import {
  titleVariants,
  normalizeTitleForVariantMatch,
  normalizeTitleLosslessly,
  hasDegenerateFullForm,
} from '@core/utils/title-variants.js';
import { explainTitlePairing } from '../services/series-title-match.js';
import { RetagError } from '../services/tagging.service.js';
import type { RetagResult } from '../services/tagging.service.js';
import type { BookDetail } from '../services/book.service.js';
import type { BookRouteDeps } from './books.js';
import { refreshOpfForBook } from '../utils/opf-refresh.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';
import { serializeError } from '../utils/serialize-error.js';

type IdParam = z.infer<typeof idParamSchema>;

const seriesSearchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Query is required').max(500),
});
type SeriesSearchQuery = z.infer<typeof seriesSearchQuerySchema>;

const bindSeriesBodySchema = z.object({
  hardcoverSeriesId: z.number().int().positive(),
});
type BindSeriesBody = z.infer<typeof bindSeriesBodySchema>;

export function registerSeriesRoutes(app: FastifyInstance, deps: BookRouteDeps) {
  const bookService = deps.bookService;
  const seriesCardService = deps.seriesCardService;
  // One instance per registered app, which is one per process: the admission guard's state must
  // outlive a request but is deliberately not shared beyond this process.
  const addAllService = buildSeriesAddAllService(deps);

  app.get<{ Params: IdParam }>(
    '/api/books/:id/series',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const card = await seriesCardService.getSeriesForBook(id);
      return { series: card };
    },
  );

  app.post<{ Params: IdParam }>(
    '/api/books/:id/series/refresh',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const card = await seriesCardService.refreshSeriesForBook(id);
      return { series: card };
    },
  );

  app.get<{ Params: IdParam; Querystring: SeriesSearchQuery }>(
    '/api/books/:id/series/search',
    { schema: { params: idParamSchema, querystring: seriesSearchQuerySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const candidates = await seriesCardService.searchSeriesCandidates(request.query.q);
      return { candidates };
    },
  );

  app.post<{ Params: IdParam; Body: BindSeriesBody }>(
    '/api/books/:id/series/bind',
    { schema: { params: idParamSchema, body: bindSeriesBodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const bound = await seriesCardService.bindHardcoverSeries(id, request.body.hardcoverSeriesId);
      if (!bound) {
        return reply.status(502).send({ error: 'Failed to bind Hardcover series' });
      }
      request.log.info({ id, hardcoverSeriesId: request.body.hardcoverSeriesId }, 'Series bound to book');
      // Binding updates every matched sibling; refresh their sidecars only after the transaction commits.
      await runPostBindRefresh(deps, id, bound.syncedIds, request.log);
      return { series: bound.card };
    },
  );

  app.post<{ Params: IdParam; Body: AddAllSeriesBody }>(
    '/api/books/:id/series/add-all',
    { schema: { params: idParamSchema, body: addAllSeriesBodySchema } },
    async (request, reply) => {
      const { id } = request.params;
      const book = await bookService.getById(id);
      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }
      const result = await addAllService.addAll(id, { searchImmediately: request.body.searchImmediately }, request.log);
      if (result.outcome === 'in-flight') {
        return reply.status(409).send({ error: ADD_ALL_IN_FLIGHT_MESSAGE });
      }
      const { requested, created, owned, held, failed } = result.response;
      request.log.info({ id, requested, created, owned, held, failed }, 'Series Add All complete');
      return result.response;
    },
  );

  // Delegate comparisons to the production matcher; lossy, degenerate, and empty-form rules must not drift here.
  app.post<{ Body: TitleVariantsDebugBody }>(
    '/api/series/title-variants-debug',
    { schema: { body: titleVariantsDebugBodySchema } },
    (request): TitleVariantsDebugResponse => {
      const { title, other } = request.body;
      // Preserve the single-title shape by omitting, rather than nulling, comparison.
      if (other === undefined) return debugSide(title);
      return {
        ...debugSide(title),
        comparison: { ...explainTitlePairing(title, other), other: debugSide(other) },
      };
    },
  );
}

function buildSeriesAddAllService(deps: BookRouteDeps): SeriesAddAllService {
  const { bookService, eventHistory, seriesCardService, indexerSearchService, indexerService,
    downloadOrchestrator, settingsService, blacklistService, eventBroadcaster } = deps;
  return new SeriesAddAllService({
    bookService,
    eventHistory,
    seriesCardService,
    search: { indexerSearchService, indexerService, downloadOrchestrator, settingsService, blacklistService, eventHistory, eventBroadcaster },
  });
}

/** A per-book outcome; `failed` is never an operation count. */
interface BoundBookOutcome {
  eligible: boolean;
  retagged: boolean;
  opfWritten: boolean;
  failed: boolean;
}

const INELIGIBLE: BoundBookOutcome = { eligible: false, retagged: false, opfWritten: false, failed: false };
const INELIGIBLE_FAILURE: BoundBookOutcome = { ...INELIGIBLE, failed: true };

/** Post-commit and best-effort: filesystem work cannot roll back a successful series bind. */
async function runPostBindRefresh(
  deps: BookRouteDeps,
  initiatingBookId: number,
  syncedIds: number[],
  log: FastifyBaseLogger,
): Promise<void> {
  if (syncedIds.length === 0) {
    // A successful bind must report at least the initiating book.
    log.warn({ bookId: initiatingBookId }, 'Series bind: the bind reported no synced books — sidecars were left untouched');
  }

  // Read the retag gate once; a failed settings read disables retagging but not OPF refresh.
  let retagEnabled = false;
  let taggingGateDegraded = false;
  try {
    retagEnabled = (await deps.settingsService.get('tagging')).enabled;
  } catch (error: unknown) {
    taggingGateDegraded = true;
    log.warn(
      { bookId: initiatingBookId, error: serializeError(error) },
      'Series bind: could not read the tagging settings — skipping the re-tag step for this bind',
    );
  }

  const summary = { bookId: initiatingBookId, synced: syncedIds.length, eligible: 0, retagged: 0, opfWritten: 0, failed: 0, taggingGateDegraded };
  for (const id of syncedIds) {
    const outcome = await refreshBoundBook(deps, id, retagEnabled, log);
    if (outcome.eligible) summary.eligible += 1;
    if (outcome.retagged) summary.retagged += 1;
    if (outcome.opfWritten) summary.opfWritten += 1;
    if (outcome.failed) summary.failed += 1;
  }
  log.info(summary, 'Series bind: post-bind sidecar refresh complete');
}

/** Missing or unreadable rows fail; never-imported books are silently ineligible. */
async function preloadBoundBook(
  deps: BookRouteDeps,
  bookId: number,
  log: FastifyBaseLogger,
): Promise<{ book: BookDetail; bookFolder: string } | BoundBookOutcome> {
  let book: BookDetail | null;
  try {
    book = await deps.bookService.getById(bookId);
  } catch (error: unknown) {
    log.warn({ bookId, error: serializeError(error) }, 'Series bind: could not load a synced book to refresh its sidecar');
    return INELIGIBLE_FAILURE;
  }
  if (!book) {
    log.warn({ bookId }, 'Series bind: a synced book no longer exists — its sidecar was not refreshed');
    return INELIGIBLE_FAILURE;
  }
  if (!book.path) return INELIGIBLE;
  return { book, bookFolder: book.path };
}

async function refreshBoundBook(
  deps: BookRouteDeps,
  bookId: number,
  retagEnabled: boolean,
  log: FastifyBaseLogger,
): Promise<BoundBookOutcome> {
  const preloaded = await preloadBoundBook(deps, bookId, log);
  if ('eligible' in preloaded) return preloaded;
  const { book, bookFolder } = preloaded;

  const retag = retagEnabled ? await retagBoundBook(deps, bookId, log) : null;
  // OPF refresh is independent of retagging and still runs when retagging fails.
  const opfOutcome = await refreshOpfForBook({
    settingsService: deps.settingsService, bookService: deps.bookService, bookId, bookFolder, log,
  });

  const retagged = (retag?.result?.tagged ?? 0) > 0;
  if (retagged || opfOutcome === 'written') {
    notifyBoundBookRefresh(deps, log, book, bookFolder, retag?.result ?? null);
  }
  return { eligible: true, retagged, opfWritten: opfOutcome === 'written', failed: (retag?.failed ?? false) || opfOutcome === 'failed' };
}

/** Emit at most one connector refresh; prefer `retagBook`'s pre-write snapshot. */
function notifyBoundBookRefresh(
  deps: BookRouteDeps,
  log: FastifyBaseLogger,
  book: BookDetail,
  bookFolder: string,
  retagResult: RetagResult | null,
): void {
  enqueueBookRefresh(deps.connectorService, log, 'metadata', retagResult?.refreshItem ?? {
    bookId: book.id, title: book.title, authorName: book.authors[0]?.name ?? null, libraryPath: bookFolder,
  });
}

/** `NO_PATH` is an expected skip; other throws or per-file failures fail the book once. */
async function retagBoundBook(
  deps: BookRouteDeps,
  bookId: number,
  log: FastifyBaseLogger,
): Promise<{ result: RetagResult | null; failed: boolean }> {
  try {
    const result = await deps.taggingService.retagBook(bookId);
    return { result, failed: result.failed > 0 };
  } catch (error: unknown) {
    if (error instanceof RetagError && error.code === 'NO_PATH') return { result: null, failed: false };
    log.warn({ bookId, error: serializeError(error) }, 'Series bind: post-bind re-tag failed');
    return { result: null, failed: true };
  }
}

function debugSide(title: string): TitleVariantsDebugSide {
  return {
    input: title,
    full: normalizeTitleForVariantMatch(title),
    lossless: normalizeTitleLosslessly(title),
    degenerateFull: hasDegenerateFullForm(title),
    variants: titleVariants(title),
  };
}
