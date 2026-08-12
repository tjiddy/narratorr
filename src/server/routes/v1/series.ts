import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '@db/index.js';
import { series } from '@db/schema.js';
import type { ReferenceReadService } from '../../services/reference-read.service.js';
import {
  seriesV1Schema,
  seriesV1ListQuerySchema,
  toSeriesV1,
} from '@shared/schemas/v1/series.js';
import { v1ListResponseSchema, v1PublicIdParamSchema, v1ErrorEnvelopeSchema } from '@shared/schemas/v1/common.js';
import { fetchByPublicId, v1ErrorHandler } from './_helpers.js';

export interface V1SeriesRouteDeps {
  referenceReadService: ReferenceReadService;
}

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
            params: v1PublicIdParamSchema,
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
