import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../../db/index.js';
import { books } from '../../../db/schema.js';
import type { BookService } from '../../services/book.service.js';
import type { BookListService } from '../../services/book-list.service.js';
import {
  bookV1Schema,
  bookV1ListQuerySchema,
  toBookV1,
} from '../../../shared/schemas/v1/books.js';
import { v1ListResponseSchema } from '../../../shared/schemas/v1/common.js';
import { fetchByPublicId, v1ErrorHandler } from './_helpers.js';

export interface V1BooksRouteDeps {
  bookService: BookService;
  bookListService: BookListService;
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
            response: { 200: v1ListResponseSchema(bookV1Schema) },
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
            response: { 200: bookV1Schema },
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
    },
    { prefix: '/api/v1' },
  );
}
