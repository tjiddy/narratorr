import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../../db/index.js';
import { downloads } from '../../../db/schema.js';
import type { DownloadService } from '../../services/download.service.js';
import {
  downloadV1Schema,
  downloadV1ListQuerySchema,
  toDownloadV1,
} from '../../../shared/schemas/v1/downloads.js';
import { v1ListResponseSchema, v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';
import { fetchByPublicId, v1ErrorHandler } from './_helpers.js';

export interface V1DownloadsRouteDeps {
  downloadService: DownloadService;
}

/** `:publicId` path param. `.strict()` per the v1 owned-schema convention. */
const publicIdParamSchema = z.object({ publicId: z.string().min(1) }).strict();

/**
 * Native public API v1 — Downloads / activity (read). Registers
 * `GET /api/v1/downloads` and `GET /api/v1/downloads/:publicId` inside an
 * ENCAPSULATED plugin so the v1-scoped `v1ErrorHandler` (v1 error envelope) does
 * not leak onto internal `/api/*` routes. API-key auth is inherited
 * automatically via the global `/api/v*` `onRequest` hook. Mirrors `v1BooksRoutes`
 * (#1449) verbatim: both endpoints declare a `.strict()` Fastify `response`
 * schema and FAIL CLOSED on any leaked internal field at serialization.
 *
 * The list reuses `DownloadService.getAll()`, which already left-joins the full
 * `books` row so `download.book.publicId` is available for the `bk_` cross-ref.
 * A download with no linked book (`bookId` null / book deleted via
 * `onDelete: 'set null'`) lists normally with `book: null`.
 */
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
          // Conditional spreads (not explicit `undefined`) to satisfy
          // exactOptionalPropertyTypes, mirroring the v1 Books/Authors routes.
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
            params: publicIdParamSchema,
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
