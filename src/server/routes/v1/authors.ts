import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '@db/index.js';
import { authors } from '@db/schema.js';
import type { ReferenceReadService } from '../../services/reference-read.service.js';
import {
  authorV1Schema,
  authorV1ListQuerySchema,
  toAuthorV1,
} from '@shared/schemas/v1/authors.js';
import { v1ListResponseSchema, v1PublicIdParamSchema, v1ErrorEnvelopeSchema } from '@shared/schemas/v1/common.js';
import { fetchByPublicId, v1ErrorHandler } from './_helpers.js';

export interface V1AuthorsRouteDeps {
  referenceReadService: ReferenceReadService;
}

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
            params: v1PublicIdParamSchema,
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
