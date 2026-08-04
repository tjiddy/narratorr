import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParamSchema, titleVariantsDebugBodySchema } from '@shared/schemas.js';
import type {
  TitleVariantsDebugBody,
  TitleVariantsDebugResponse,
  TitleVariantsDebugSide,
} from '@shared/schemas.js';
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

  // GET /api/books/:id/series/search?q= — proxy HardcoverClient.searchSeries
  // for the manual Fix Series picker. Degrades to an empty list when no key
  // is configured (never a 500).
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

  // POST /api/books/:id/series/bind — persist the chosen Hardcover series id
  // and sync the book display fields. Returns the rebuilt (id-sourced) card.
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
      // AFTER the transaction resolved (#2098): a bind rewrites series_name /
      // series_position on every matched sibling, so every one of them needs the
      // same post-mutation treatment Fix Match gives the single book it edits.
      await runPostBindRefresh(deps, id, bound.syncedIds, request.log);
      return { series: bound.card };
    },
  );

  // POST /api/series/title-variants-debug — the member-matcher parse tester
  // (#2096), the series-side counterpart to `POST /api/library/scan-debug`.
  //
  // Take a bare title, return everything the acceptance rule keys on for that
  // side: the FULL normalized form, the Unicode-preserving `lossless` form, the
  // `degenerateFull` verdict, and the tagged variant array (each variant now
  // carrying its own `lossy` flag).
  //
  // Supply `other` as well and the response also carries the PRODUCTION verdict
  // — `{ pairs, arm, reason }` straight from `explainTitlePairing`, the same
  // function the matcher runs. That delegation is the point (#2110): the
  // endpoint used to return `{ input, full, variants }` and document the rule as
  // "FULL≡FULL, or one side's DERIVED variant equalling the other's FULL", which
  // omitted the degeneracy, lossy and empty-form conditions entirely. On the
  // live class (two franchise siblings whose non-Latin subtitles both fold away,
  // so both sides report `full: 'world of warcraft'`) that stated rule predicts
  // MATCH and production refuses — the diagnostic reached the opposite
  // conclusion from the matcher on exactly the hardest class to eyeball. The
  // rule now lives in ONE place; this route re-implements no part of it.
  //
  // The real rule, in evaluation order:
  //   1. both FULL forms empty, both lossless non-empty and equal
  //                                                     → lossless-equals-lossless
  //   2. both FULL forms empty, otherwise                → none
  //   3. exactly one FULL form empty                     → none
  //   4. FULLs equal, neither side degenerate            → full-equals-full
  //   5. FULLs equal, either degenerate, lossless equal  → full-equals-full
  //   6. FULLs equal, either degenerate, lossless differ → none
  //   7. FULLs differ, some non-lossy DERIVED variant of one side equals the
  //      other side's FULL, and that other side is not degenerate
  //                                                      → derived-equals-full
  //   8. otherwise                                       → none
  //
  // Deliberately NOT under the `/api/books/:id/...` prefix every other route in
  // this file uses — the input is a bare title, not a book. A title that
  // validates but yields no variants (e.g. '[ ]') is a 200 with an empty array:
  // the empty result IS the diagnostic answer, not an error.
  app.post<{ Body: TitleVariantsDebugBody }>(
    '/api/series/title-variants-debug',
    { schema: { body: titleVariantsDebugBodySchema } },
    (request): TitleVariantsDebugResponse => {
      const { title, other } = request.body;
      // `comparison` is ABSENT, not null, when `other` is omitted — the
      // single-title response keeps exactly the five top-level keys it has
      // always had, so this widening is a strict superset of the old shape.
      if (other === undefined) return debugSide(title);
      return {
        ...debugSide(title),
        comparison: { ...explainTitlePairing(title, other), other: debugSide(other) },
      };
    },
  );
}

/** What the post-bind pass recorded for ONE synced book. `failed` is per BOOK, never per operation. */
interface BoundBookOutcome {
  eligible: boolean;
  retagged: boolean;
  opfWritten: boolean;
  failed: boolean;
}

const INELIGIBLE: BoundBookOutcome = { eligible: false, retagged: false, opfWritten: false, failed: false };
const INELIGIBLE_FAILURE: BoundBookOutcome = { ...INELIGIBLE, failed: true };

/**
 * Post-commit sidecar + tag refresh for a Fix Series bind (#2098).
 *
 * A bind rewrites `books.series_name`/`series_position` for the initiating book AND every
 * member-matched sibling, and those two fields are exactly what `metadata.opf`'s
 * `calibre:series`/`calibre:series_index` carry — the artifact the Audiobookshelf handoff reads
 * (#1668). Without this pass every bound book's sidecar (and its embedded `series`/`seriesPart`
 * tags) keeps the STALE series until some unrelated flow happens to rewrite it.
 *
 * Runs AFTER `bindHardcoverSeries` resolves — i.e. after its transaction committed — sequentially
 * over the ids the transaction reported, and opens no transaction of its own (a nested
 * `db.transaction` on the shared libSQL connection rejects outright, and the per-book ffmpeg/fs work
 * has no business inside one).
 *
 * Wholly best-effort: the DB write already landed, so nothing here may turn a successful bind into a
 * failure. Every per-book failure is caught, and the response stays `200 { series }` regardless of
 * how many books could not be refreshed — per-book warnings are log-only (no `warnings` key is added
 * to the response shape). Emits exactly one `info` summary once every id has settled.
 */
async function runPostBindRefresh(
  deps: BookRouteDeps,
  initiatingBookId: number,
  syncedIds: number[],
  log: FastifyBaseLogger,
): Promise<void> {
  if (syncedIds.length === 0) {
    // A non-null bind always rewrote at least the initiating book, so an empty list is a bug
    // (most likely a stale test double resolving the pre-#2098 bare-card shape) — never silently
    // pass it off as a zero-book pass.
    log.warn({ bookId: initiatingBookId }, 'Series bind: the bind reported no synced books — sidecars were left untouched');
  }

  // ONE pass-level decision, not one per book. `retagBook` has no `enabled` gate of its own (same
  // as `merge-post-tag.ts`), so Tag Embedding is gated here; a rejecting read degrades the gate to
  // OFF for the whole pass and is reported by `taggingGateDegraded`, never by `failed`.
  // `refreshOpfForBook` performs its own independent `tagging` read per book and owns the
  // `writeOpf` gate — this read predicts nothing about those.
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

/**
 * One synced book's refresh: preload → (gated) re-tag → OPF, mirroring Fix Match's order.
 *
 * The preload has four outcomes and only the last is ELIGIBLE — it rejected, it resolved `null`
 * (the row was deleted between the commit and this read), it resolved a book with `path === null`
 * (never imported), or it resolved a book with a usable folder. A rejection and a vanished row are
 * treated identically: a refresh this pass owed could not be attempted, so both warn and count as a
 * failure. A never-imported book is the ordinary wanted-but-undownloaded series member — silent, and
 * not a failure. `book.path` is never dereferenced before the `null` book is narrowed away.
 */
async function refreshBoundBook(
  deps: BookRouteDeps,
  bookId: number,
  retagEnabled: boolean,
  log: FastifyBaseLogger,
): Promise<BoundBookOutcome> {
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
  const bookFolder = book.path;
  if (!bookFolder) return INELIGIBLE; // never imported — nothing on disk to refresh

  const retag = retagEnabled ? await retagBoundBook(deps, bookId, log) : null;
  // The OPF step runs even when the re-tag threw: the two artifacts are independent, and the
  // sidecar is the one Audiobookshelf actually reads. `refreshOpfForBook` applies the `writeOpf`
  // gate itself and logs its own failures — this pass adds no second record for them.
  const opfOutcome = await refreshOpfForBook({
    settingsService: deps.settingsService, bookService: deps.bookService, bookId, bookFolder, log,
  });

  const retagged = (retag?.result?.tagged ?? 0) > 0;
  if (retagged || opfOutcome === 'written') {
    // Exactly one 'metadata' refresh per book covering both writers, preferring the retag's
    // pre-tag-write item (captured before the irreversible in-place rewrite).
    enqueueBookRefresh(deps.connectorService, log, 'metadata', retag?.result?.refreshItem ?? {
      bookId, title: book.title, authorName: book.authors[0]?.name ?? null, libraryPath: bookFolder,
    });
  }
  return { eligible: true, retagged, opfWritten: opfOutcome === 'written', failed: (retag?.failed ?? false) || opfOutcome === 'failed' };
}

/**
 * The gated re-tag for one book. Called with NO `excludeFields` and NO overrides — the same
 * no-argument call the bulk re-tag job and `retagMergedOutput` make — so a bind introduces no third
 * tag-projection policy. `RetagError`/`NO_PATH` is skipped silently (the book has nothing on disk to
 * tag), matching the bulk job; every other throw, and a resolved `failed > 0`, marks the BOOK failed
 * exactly once however many individual files were involved.
 */
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

/** One side of the diagnostic, from the same three pure functions the matcher derives from. */
function debugSide(title: string): TitleVariantsDebugSide {
  return {
    input: title,
    full: normalizeTitleForVariantMatch(title),
    lossless: normalizeTitleLosslessly(title),
    degenerateFull: hasDegenerateFullForm(title),
    variants: titleVariants(title),
  };
}
