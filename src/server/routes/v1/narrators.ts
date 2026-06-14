import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../../db/index.js';
import { narrators } from '../../../db/schema.js';
import type { ReferenceReadService } from '../../services/reference-read.service.js';
import {
  narratorV1Schema,
  narratorV1ListQuerySchema,
  toNarratorV1,
} from '../../../shared/schemas/v1/narrators.js';
import { v1ListResponseSchema } from '../../../shared/schemas/v1/common.js';
import { fetchByPublicId, v1ErrorHandler } from './_helpers.js';

export interface V1NarratorsRouteDeps {
  referenceReadService: ReferenceReadService;
}

/** `:publicId` path param. `.strict()` per the v1 owned-schema convention. */
const publicIdParamSchema = z.object({ publicId: z.string().min(1) }).strict();

/**
 * Native public API v1 — Narrators (read). Registers `GET /api/v1/narrators` and
 * `GET /api/v1/narrators/:publicId` inside an ENCAPSULATED plugin so the
 * v1-scoped `v1ErrorHandler` does not leak onto internal `/api/*` routes.
 * Mirrors `v1BooksRoutes` (#1449): `.strict()` `response` schemas fail closed on
 * leaked internal fields, and auth is inherited from the global `/api/v*` hook.
 * Narrators are listable regardless of book linkage.
 */
export async function v1NarratorsRoutes(app: FastifyInstance, deps: V1NarratorsRouteDeps, db: Db): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/narrators',
        {
          schema: {
            querystring: narratorV1ListQuerySchema,
            response: { 200: v1ListResponseSchema(narratorV1Schema) },
          },
        },
        async (request) => {
          const { limit, offset } = request.query;
          const pagination = {
            ...(limit !== undefined && { limit }),
            ...(offset !== undefined && { offset }),
          };
          const { data, total } = await deps.referenceReadService.listNarrators(pagination);
          return { data: data.map(toNarratorV1), total };
        },
      );

      typed.get(
        '/narrators/:publicId',
        {
          schema: {
            params: publicIdParamSchema,
            response: { 200: narratorV1Schema },
          },
        },
        async (request) =>
          fetchByPublicId(
            db,
            narrators,
            request.params.publicId,
            (rowid) => deps.referenceReadService.getNarratorById(rowid),
            toNarratorV1,
          ),
      );
    },
    { prefix: '/api/v1' },
  );
}
