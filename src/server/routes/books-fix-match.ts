import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { didRenameChangeAnything } from '../services/rename.service.js';
import { triggerCompanionReconcile } from '../services/companion-ebook-trigger.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import { idParamSchema, fixMatchRequestSchema, type FixMatchRequest } from '@shared/schemas.js';
import type { BookMetadata } from '@core/index.js';
import type { BookRouteDeps } from './books.js';
import type { FixMatchReplacement } from '../services/book.service.js';
import { refreshOpfForBook } from '../utils/opf-refresh.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
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

function metadataToFixMatchUpdate(meta: BookMetadata): FixMatchReplacement {
  const primarySeries = pickPrimarySeries(meta);
  const out: FixMatchReplacement = {
    title: meta.title,
    authors: meta.authors,
  };
  copyOptional(out, 'asin', meta.asin);
  copyOptional(out, 'subtitle', meta.subtitle);
  copyOptional(out, 'narrators', meta.narrators);
  copyOptional(out, 'description', meta.description);
  copyOptional(out, 'publisher', meta.publisher);
  copyOptional(out, 'coverUrl', meta.coverUrl);
  copyOptional(out, 'duration', meta.duration);
  copyOptional(out, 'publishedDate', meta.publishedDate);
  copyOptional(out, 'seriesName', primarySeries?.name);
  copyOptional(out, 'seriesPosition', primarySeries?.position);
  copyOptional(out, 'genres', meta.genres);
  copyOptional(out, 'isbn', meta.isbn);
  return out;
}

/** Return whether retagging changed files; RenameService emits its own separate refresh. */
async function runPostCommitRenameRetag(
  deps: BookRouteDeps,
  bookId: number,
  hasPath: boolean,
  body: FixMatchRequest,
  log: FastifyBaseLogger,
): Promise<{ retagged: boolean }> {
  if (!hasPath) return { retagged: false };
  if (body.renameFiles) {
    // Reconcile after changes or failures because the persisted path may move before rename throws.
    const reconcile = (): void => triggerCompanionReconcile(
      deps.companionEbook, bookId, log, 'Companion ebook reconcile failed after Fix Match rename',
    );
    try {
      const result = await deps.renameService.renameBook(bookId);
      if (didRenameChangeAnything(result)) reconcile();
    } catch (error: unknown) {
      log.warn({ id: bookId, error: serializeError(error) }, 'Fix Match: post-commit rename failed');
      reconcile();
    }
  }
  let retagged = false;
  if (body.retagFiles) {
    try {
      const result = await deps.taggingService.retagBook(bookId, new Set(), {});
      retagged = result.tagged > 0;
    } catch (error: unknown) {
      log.warn({ id: bookId, error: serializeError(error) }, 'Fix Match: post-commit retag failed');
    }
  }
  return { retagged };
}

/** Re-read a possibly renamed path, then emit one metadata refresh for retag and OPF writes. */
async function refreshSidecarAndNotify(
  deps: BookRouteDeps,
  bookId: number,
  updated: { title: string; path: string | null; authors?: Array<{ name: string }> | null },
  body: FixMatchRequest,
  retagged: boolean,
  log: FastifyInstance['log'],
): Promise<void> {
  let bookFolder = updated.path ?? null;
  if (body.renameFiles && updated.path) {
    const refreshed = await deps.bookService.getById(bookId).catch(() => null);
    bookFolder = refreshed?.path ?? updated.path;
  }
  const opfOutcome = await refreshOpfForBook({
    settingsService: deps.settingsService,
    bookService: deps.bookService,
    bookId,
    bookFolder,
    log,
  });

  // `bookFolder` is non-null whenever either condition holds (both require an imported path).
  if (retagged || opfOutcome === 'written') {
    enqueueBookRefresh(deps.connectorService, log, 'metadata', {
      bookId, title: updated.title, authorName: updated.authors?.[0]?.name ?? null, libraryPath: bookFolder!,
    });
  }
}

export function registerFixMatchRoute(app: FastifyInstance, deps: BookRouteDeps) {
  const metadataService = deps.metadataService;
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

      if (deps.eventHistory) {
        deps.eventHistory.create({
          bookId: id,
          ...snapshotBookForEvent(updated),
          eventType: 'metadata_fixed',
          source: 'manual',
          reason: { oldAsin, newAsin: meta.asin ?? null, oldTitle, newTitle: meta.title },
        }).catch((err: unknown) => request.log.warn({ error: serializeError(err) }, 'Failed to record metadata_fixed event'));
      }

      const { retagged } = await runPostCommitRenameRetag(deps, id, !!updated.path, body, request.log);
      await refreshSidecarAndNotify(deps, id, updated, body, retagged, request.log);

      return reply.status(200).send(updated);
    },
  );
}
