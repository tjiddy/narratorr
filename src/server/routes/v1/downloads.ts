import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '@db/index.js';
import { downloads } from '@db/schema.js';
import type { DownloadService } from '../../services/download.service.js';
import {
  downloadV1Schema,
  downloadV1ListQuerySchema,
  toDownloadV1,
} from '@shared/schemas/v1/downloads.js';
import { v1ListResponseSchema, v1PublicIdParamSchema, v1ErrorEnvelopeSchema } from '@shared/schemas/v1/common.js';
import { fetchByPublicId, v1ErrorHandler } from './_helpers.js';

export interface V1DownloadsRouteDeps {
  downloadService: DownloadService;
}

export async function v1DownloadsRoutes(app: FastifyInstance, deps: V1DownloadsRouteDeps, db: Db): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/downloads',
        {
          schema: {
            querystring: downloadV1ListQuerySchema,
            response: { 200: v1ListResponseSchema(downloadV1Schema), 400: v1ErrorEnvelopeSchema },
          },
        },
        async (request) => {
          const { limit, offset } = request.query;
          // Conditional spreads satisfy exactOptionalPropertyTypes.
          const pagination = {
            ...(limit !== undefined && { limit }),
            ...(offset !== undefined && { offset }),
          };
          const { data, total } = await deps.downloadService.getAll(undefined, pagination);
          return { data: data.map(toDownloadV1), total };
        },
      );

      typed.get(
        '/downloads/:publicId',
        {
          schema: {
            params: v1PublicIdParamSchema,
            response: { 200: downloadV1Schema, 400: v1ErrorEnvelopeSchema, 404: v1ErrorEnvelopeSchema },
          },
        },
        async (request) =>
          fetchByPublicId(
            db,
            downloads,
            request.params.publicId,
            (rowid) => deps.downloadService.getById(rowid),
            toDownloadV1,
          ),
      );
    },
    { prefix: '/api/v1' },
  );
}
