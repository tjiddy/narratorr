import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { MetadataService } from '../../services/metadata.service.js';
import type { BookService } from '../../services/book.service.js';
import type { SettingsService } from '../../services/settings.service.js';
import {
  metadataSearchResultV1Schema,
  metadataSearchV1QuerySchema,
  toMetadataSearchResultV1,
  type MetadataSearchResultV1,
} from '@shared/schemas/v1/metadata.js';
import { v1ListResponseSchema, v1ErrorEnvelopeSchema } from '@shared/schemas/v1/common.js';
import { v1ErrorHandler } from './_helpers.js';
import { serializeError } from '../../utils/serialize-error.js';
import type { FastifyBaseLogger } from 'fastify';

export interface V1MetadataRouteDeps {
  metadataService: MetadataService;
  bookService: BookService;
  settingsService: SettingsService;
}

/** Read once per request and fail closed without suppressing library annotation. */
async function readCompanionEnabled(
  settingsService: SettingsService,
  log: FastifyBaseLogger,
): Promise<boolean> {
  try {
    return (await settingsService.get('companionEpub')).enabled;
  } catch (error: unknown) {
    log.warn(
      { error: serializeError(error) },
      'v1 metadata-search companionEpub settings read failed — annotating without companion ebooks',
    );
    return false;
  }
}

/** Best-effort, in-place ASIN annotation; lookup failure must never fail metadata search. */
async function annotateLibraryStatus(
  data: MetadataSearchResultV1[],
  bookService: BookService,
  companionEnabled: boolean,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const asins = data.map((r) => r.asin).filter((a): a is string => a !== undefined);
    if (asins.length === 0) return;
    const statusByAsin = await bookService.findLibraryStatusByAsins(asins, { companionEnabled });
    for (const result of data) {
      const match = result.asin !== undefined ? statusByAsin.get(result.asin.toUpperCase()) : undefined;
      if (match) result.library = match;
    }
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, 'v1 metadata-search library enrichment failed');
  }
}

/** Empty and rate-limited searches return 200 with an empty list. */
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
          const companionEnabled = await readCompanionEnabled(deps.settingsService, request.log);
          await annotateLibraryStatus(data, deps.bookService, companionEnabled, request.log);
          return { data, total: data.length };
        },
      );
    },
    { prefix: '/api/v1' },
  );
}
