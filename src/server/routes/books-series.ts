import type { FastifyInstance } from 'fastify';
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
import type { BookService, SeriesCardService } from '../services/index.js';

type IdParam = z.infer<typeof idParamSchema>;

const seriesSearchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Query is required').max(500),
});
type SeriesSearchQuery = z.infer<typeof seriesSearchQuerySchema>;

const bindSeriesBodySchema = z.object({
  hardcoverSeriesId: z.number().int().positive(),
});
type BindSeriesBody = z.infer<typeof bindSeriesBodySchema>;

export function registerSeriesRoutes(app: FastifyInstance, bookService: BookService, seriesCardService: SeriesCardService) {
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
      const card = await seriesCardService.bindHardcoverSeries(id, request.body.hardcoverSeriesId);
      if (!card) {
        return reply.status(502).send({ error: 'Failed to bind Hardcover series' });
      }
      request.log.info({ id, hardcoverSeriesId: request.body.hardcoverSeriesId }, 'Series bound to book');
      return { series: card };
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
