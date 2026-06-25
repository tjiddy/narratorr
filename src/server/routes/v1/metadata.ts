import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { MetadataService } from '../../services/metadata.service.js';
import type { BookService } from '../../services/book.service.js';
import {
  metadataSearchResultV1Schema,
  metadataSearchV1QuerySchema,
  toMetadataSearchResultV1,
  type MetadataSearchResultV1,
} from '../../../shared/schemas/v1/metadata.js';
import { v1ListResponseSchema, v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';
import { v1ErrorHandler } from './_helpers.js';
import { serializeError } from '../../utils/serialize-error.js';
import type { FastifyBaseLogger } from 'fastify';

export interface V1MetadataRouteDeps {
  metadataService: MetadataService;
  bookService: BookService;
}

/**
 * Best-effort: annotate each result with its current library status (#1537),
 * matched by ASIN. Mutates `data` in place. Wrapped so a lookup failure logs and
 * leaves every result's `library` absent rather than turning the search into a
 * 5xx — enrichment must never fail the search. Casing is normalized in exactly
 * one place: the service keys the map by uppercased ASIN and we look up with
 * `result.asin?.toUpperCase()`. An empty ASIN set issues NO query.
 */
async function annotateLibraryStatus(
  data: MetadataSearchResultV1[],
  bookService: BookService,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const asins = data.map((r) => r.asin).filter((a): a is string => a !== undefined);
    if (asins.length === 0) return;
    const statusByAsin = await bookService.findLibraryStatusByAsins(asins);
    for (const result of data) {
      const match = result.asin !== undefined ? statusByAsin.get(result.asin.toUpperCase()) : undefined;
      if (match) result.library = match;
    }
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, 'v1 metadata-search library enrichment failed');
  }
}

/**
 * Native public API v1 — Metadata search (read). Registers
 * `GET /api/v1/metadata/search?q=<query>` inside an ENCAPSULATED plugin so the
 * v1-scoped `setErrorHandler` (v1 error envelope) does not leak onto internal
 * `/api/*` routes. API-key auth is inherited automatically via the global
 * `/api/v*` `onRequest` hook (`src/server/plugins/auth.ts`).
 *
 * A thin public wrapper over `MetadataService.search()`: it projects ONLY the
 * provider `books` results (top-level `authors`/`series`/`warnings` are dropped)
 * through `toMetadataSearchResultV1`, then annotates each result with its current
 * library status by ASIN (#1537) — a best-effort, additive cross-reference filled
 * AFTER projection so a library-lookup failure never fails the search. No-match —
 * and a rate-limited search (empty `books` + hidden `warnings`) — both yield
 * `{ data: [], total: 0 }` with a `200`, never a 404. The `.strict()`
 * `metadataSearchResultV1Schema` FAILS
 * CLOSED: a leaked internal `BookMetadata` field is rejected at serialization
 * rather than silently stripped. This is a READ route — `q` validation failures
 * throw and are mapped to the 400 v1 envelope by `v1ErrorHandler`, never an
 * inline `reply.send`.
 */
export async function v1MetadataRoutes(app: FastifyInstance, deps: V1MetadataRouteDeps): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/metadata/search',
        {
          schema: {
            querystring: metadataSearchV1QuerySchema,
            response: { 200: v1ListResponseSchema(metadataSearchResultV1Schema), 400: v1ErrorEnvelopeSchema },
          },
        },
        async (request) => {
          const { q } = request.query;
          const { books } = await deps.metadataService.search(q);
          const data = books.map(toMetadataSearchResultV1);
          await annotateLibraryStatus(data, deps.bookService, request.log);
          return { data, total: data.length };
        },
      );
    },
    { prefix: '/api/v1' },
  );
}
