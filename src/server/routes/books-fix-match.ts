import type { FastifyInstance } from 'fastify';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import { idParamSchema, fixMatchRequestSchema, type FixMatchRequest } from '../../shared/schemas.js';
import type { BookMetadata } from '../../core/index.js';
import type { BookRouteDeps } from './books.js';
import type { FixMatchReplacement } from '../services/book.service.js';
import { type z } from 'zod';

type IdParam = z.infer<typeof idParamSchema>;

type FixMatchFailureKind = 'not_found' | 'rate_limited' | 'invalid_record' | 'transient_failure';

function fixMatchHttpStatus(kind: FixMatchFailureKind): number {
  switch (kind) {
    case 'not_found': return 404;
    case 'rate_limited': return 503;
    case 'invalid_record': return 422;
    case 'transient_failure': return 502;
  }
}

function fixMatchErrorMessage(kind: FixMatchFailureKind): string {
  switch (kind) {
    case 'not_found': return 'ASIN not resolved';
    case 'rate_limited': return 'Provider rate limited';
    case 'invalid_record': return 'Incomplete provider record';
    case 'transient_failure': return 'Provider lookup failed';
  }
}

function copyOptional<T extends FixMatchReplacement, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

/** Project a `BookMetadata` into the partial-update payload BookService.fixMatch expects. */
function metadataToFixMatchUpdate(meta: BookMetadata): FixMatchReplacement {
  const primarySeries = meta.seriesPrimary ?? meta.series?.[0];
  const out: FixMatchReplacement = {
    title: meta.title,
    authors: meta.authors,
    seriesProvider: 'audible',
  };
  copyOptional(out, 'asin', meta.asin);
  copyOptional(out, 'subtitle', meta.subtitle);
  copyOptional(out, 'narrators', meta.narrators);
  copyOptional(out, 'description', meta.description);
  copyOptional(out, 'coverUrl', meta.coverUrl);
  copyOptional(out, 'duration', meta.duration);
  copyOptional(out, 'publishedDate', meta.publishedDate);
  copyOptional(out, 'seriesName', primarySeries?.name);
  copyOptional(out, 'seriesPosition', primarySeries?.position);
  copyOptional(out, 'seriesAsin', meta.seriesPrimary?.asin);
  copyOptional(out, 'genres', meta.genres);
  copyOptional(out, 'isbn', meta.isbn);
  return out;
}

function enqueueSeriesRefreshAfterFixMatch(
  deps: BookRouteDeps,
  bookId: number,
  meta: BookMetadata,
  log: { warn: (obj: unknown, msg: string) => void },
): void {
  const primarySeries = meta.seriesPrimary ?? meta.series?.[0];
  if (!deps.seriesRefreshService || !meta.asin || !primarySeries?.name) return;
  try {
    deps.seriesRefreshService.enqueueRefresh(meta.asin, {
      bookId,
      seriesName: primarySeries.name,
      ...(meta.seriesPrimary?.asin !== undefined && { providerSeriesId: meta.seriesPrimary.asin }),
      bookTitle: meta.title,
      ...(primarySeries.position !== undefined && { seriesPosition: primarySeries.position }),
    });
  } catch (error: unknown) {
    log.warn({ id: bookId, error: serializeError(error) }, 'Fix Match: series refresh enqueue failed');
  }
}

async function runPostCommitRenameRetag(
  deps: BookRouteDeps,
  bookId: number,
  hasPath: boolean,
  body: FixMatchRequest,
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<void> {
  if (!hasPath) return;
  if (body.renameFiles) {
    try {
      await deps.renameService.renameBook(bookId);
    } catch (error: unknown) {
      log.warn({ id: bookId, error: serializeError(error) }, 'Fix Match: post-commit rename failed');
    }
  }
  if (body.retagFiles) {
    try {
      await deps.taggingService.retagBook(bookId, new Set(), {});
    } catch (error: unknown) {
      log.warn({ id: bookId, error: serializeError(error) }, 'Fix Match: post-commit retag failed');
    }
  }
}

export function registerFixMatchRoute(app: FastifyInstance, deps: BookRouteDeps) {
  const metadataService = deps.metadataService!;
  app.post<{ Params: IdParam; Body: FixMatchRequest }>(
    '/api/books/:id/fix-match',
    { schema: { params: idParamSchema, body: fixMatchRequestSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;

      const sourceBook = await deps.bookService.getById(id);
      if (!sourceBook) return reply.status(404).send({ error: 'Book not found' });

      const collision = await deps.bookService.findAsinCollision(id, body.asin);
      if (collision) {
        return reply.status(409).send({ error: 'ASIN already in library', ...collision });
      }

      const lookup = await metadataService.lookupForFixMatch(body.asin);
      if (lookup.kind !== 'ok') {
        const payload: Record<string, unknown> = { error: fixMatchErrorMessage(lookup.kind) };
        if (lookup.kind === 'rate_limited') payload.retryAfterMs = lookup.retryAfterMs;
        return reply.status(fixMatchHttpStatus(lookup.kind)).send(payload);
      }

      const meta = lookup.book;
      const oldAsin = sourceBook.asin ?? null;
      const oldTitle = sourceBook.title;

      const updated = await deps.bookService.fixMatch(id, metadataToFixMatchUpdate(meta));
      if (!updated) return reply.status(404).send({ error: 'Book not found' });

      enqueueSeriesRefreshAfterFixMatch(deps, id, meta, request.log);

      if (deps.eventHistory) {
        deps.eventHistory.create({
          bookId: id,
          ...snapshotBookForEvent(updated),
          eventType: 'metadata_fixed',
          source: 'manual',
          reason: { oldAsin, newAsin: meta.asin ?? null, oldTitle, newTitle: meta.title },
        }).catch((err: unknown) => request.log.warn({ error: serializeError(err) }, 'Failed to record metadata_fixed event'));
      }

      await runPostCommitRenameRetag(deps, id, !!updated.path, body, request.log);
      return reply.status(200).send(updated);
    },
  );
}
