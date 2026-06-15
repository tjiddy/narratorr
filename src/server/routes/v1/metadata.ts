import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { MetadataService } from '../../services/metadata.service.js';
import {
  metadataSearchResultV1Schema,
  metadataSearchV1QuerySchema,
  toMetadataSearchResultV1,
} from '../../../shared/schemas/v1/metadata.js';
import { v1ListResponseSchema, v1ErrorEnvelopeSchema } from '../../../shared/schemas/v1/common.js';
import { v1ErrorHandler } from './_helpers.js';

export interface V1MetadataRouteDeps {
  metadataService: MetadataService;
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
 * through `toMetadataSearchResultV1`. No-match — and a rate-limited search
 * (empty `books` + hidden `warnings`) — both yield `{ data: [], total: 0 }` with
 * a `200`, never a 404. The `.strict()` `metadataSearchResultV1Schema` FAILS
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
          return { data, total: data.length };
        },
      );
    },
    { prefix: '/api/v1' },
  );
}
