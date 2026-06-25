import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../../db/index.js';
import { series } from '../../../db/schema.js';
import type { ReferenceReadService } from '../../services/reference-read.service.js';
import {
  seriesV1Schema,
  seriesV1ListQuerySchema,
  toSeriesV1,
} from '../../../shared/schemas/v1/series.js';
import { v1ListResponseSchema, v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';
import { fetchByPublicId, v1ErrorHandler } from './_helpers.js';

export interface V1SeriesRouteDeps {
  referenceReadService: ReferenceReadService;
}

/** `:publicId` path param. `.strict()` per the v1 owned-schema convention. */
const publicIdParamSchema = z.object({ publicId: z.string().min(1) }).strict();

/**
 * Native public API v1 — Series (read). Registers `GET /api/v1/series` and
 * `GET /api/v1/series/:publicId` inside an ENCAPSULATED plugin so the v1-scoped
 * `v1ErrorHandler` does not leak onto internal `/api/*` routes. Mirrors
 * `v1BooksRoutes` (#1449): `.strict()` `response` schemas fail closed on the
 * series table's many internal columns, and auth is inherited from the global
 * `/api/v*` hook. Series sourced from Hardcover that are NOT linked to any local
 * book are in scope — the read service reads the base `series` table.
 */
export async function v1SeriesRoutes(app: FastifyInstance, deps: V1SeriesRouteDeps, db: Db): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/series',
        {
          schema: {
            querystring: seriesV1ListQuerySchema,
            response: { 200: v1ListResponseSchema(seriesV1Schema), 400: v1ErrorEnvelopeSchema },
          },
        },
        async (request) => {
          const { limit, offset } = request.query;
          const pagination = {
            ...(limit !== undefined && { limit }),
            ...(offset !== undefined && { offset }),
          };
          const { data, total } = await deps.referenceReadService.listSeries(pagination);
          return { data: data.map(toSeriesV1), total };
        },
      );

      typed.get(
        '/series/:publicId',
        {
          schema: {
            params: publicIdParamSchema,
            response: { 200: seriesV1Schema, 400: v1ErrorEnvelopeSchema, 404: v1ErrorEnvelopeSchema },
          },
        },
        async (request) =>
          fetchByPublicId(
            db,
            series,
            request.params.publicId,
            (rowid) => deps.referenceReadService.getSeriesById(rowid),
            toSeriesV1,
          ),
      );
    },
    { prefix: '/api/v1' },
  );
}
