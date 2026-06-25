import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../../db/index.js';
import { authors } from '../../../db/schema.js';
import type { ReferenceReadService } from '../../services/reference-read.service.js';
import {
  authorV1Schema,
  authorV1ListQuerySchema,
  toAuthorV1,
} from '../../../shared/schemas/v1/authors.js';
import { v1ListResponseSchema, v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';
import { fetchByPublicId, v1ErrorHandler } from './_helpers.js';

export interface V1AuthorsRouteDeps {
  referenceReadService: ReferenceReadService;
}

/** `:publicId` path param. `.strict()` per the v1 owned-schema convention. */
const publicIdParamSchema = z.object({ publicId: z.string().min(1) }).strict();

/**
 * Native public API v1 — Authors (read). Registers `GET /api/v1/authors` and
 * `GET /api/v1/authors/:publicId` inside an ENCAPSULATED plugin so the v1-scoped
 * `v1ErrorHandler` (v1 error envelope) does not leak onto internal `/api/*`
 * routes. API-key auth is inherited automatically via the global `/api/v*`
 * `onRequest` hook. Mirrors `v1BooksRoutes` (#1449) verbatim: both endpoints
 * declare a `.strict()` Fastify `response` schema and FAIL CLOSED on any leaked
 * internal field at serialization. Authors are listable regardless of book
 * linkage — the read service reads the base table.
 */
export async function v1AuthorsRoutes(app: FastifyInstance, deps: V1AuthorsRouteDeps, db: Db): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/authors',
        {
          schema: {
            querystring: authorV1ListQuerySchema,
            response: { 200: v1ListResponseSchema(authorV1Schema), 400: v1ErrorEnvelopeSchema },
          },
        },
        async (request) => {
          const { limit, offset } = request.query;
          const pagination = {
            ...(limit !== undefined && { limit }),
            ...(offset !== undefined && { offset }),
          };
          const { data, total } = await deps.referenceReadService.listAuthors(pagination);
          return { data: data.map(toAuthorV1), total };
        },
      );

      typed.get(
        '/authors/:publicId',
        {
          schema: {
            params: publicIdParamSchema,
            response: { 200: authorV1Schema, 400: v1ErrorEnvelopeSchema, 404: v1ErrorEnvelopeSchema },
          },
        },
        async (request) =>
          fetchByPublicId(
            db,
            authors,
            request.params.publicId,
            (rowid) => deps.referenceReadService.getAuthorById(rowid),
            toAuthorV1,
          ),
      );
    },
    { prefix: '/api/v1' },
  );
}
