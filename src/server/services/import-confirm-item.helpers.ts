import type { FastifyBaseLogger } from 'fastify';
import { type BookService } from './book.service.js';
import type { HeldReviewItem } from '@shared/schemas/library-scan.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import type { ImportConfirmItem } from './library-scan.service.js';

function resolveDedupeAsin(item: ImportConfirmItem): string | undefined {
  return item.asin ?? item.metadata?.asin;
}

/** Owned duplicate result, optionally naming the incumbent for reporting. */
export type SkipClassification = { skip: true; existingBookId?: number; existingTitle?: string };

/** Read-only classification: skip same recordings, hold ambiguous ones, and proceed otherwise. */
export async function classifyConfirmItem(
  item: ImportConfirmItem,
  bookService: BookService,
  log: FastifyBaseLogger,
): Promise<SkipClassification | 'proceed' | HeldReviewItem> {
  // Force bypasses bibliographic dedup only; the copy-time collision fence still forbids overwrite.
  if (item.forceImport) return 'proceed';
  const dedupeAsin = resolveDedupeAsin(item);
  const resolution = await bookService.findDuplicate({
    title: item.title,
    ...(item.authorName ? { authors: [{ name: item.authorName }] } : {}),
    ...(dedupeAsin !== undefined && { asin: dedupeAsin }),
    ...(item.narrators !== undefined && { narrators: item.narrators }),
    ...(item.metadata?.duration !== undefined && { duration: item.metadata.duration }),
    // Preserve abridged/unabridged review when duration cannot decide.
    ...(item.metadata?.formatType ? { productionType: normalizeProductionType(item.metadata.formatType) } : {}),
  });
  if (resolution.verdict === 'same-recording') {
    log.debug({ title: item.title, existingBookId: resolution.book?.id }, 'Skipping owned duplicate during import (same recording)');
    return {
      skip: true,
      ...(resolution.book ? { existingBookId: resolution.book.id, existingTitle: resolution.book.title } : {}),
    };
  }
  if (resolution.verdict === 'review') {
    log.info({ title: item.title, existingBookId: resolution.book?.id }, 'Holding import item for recording review');
    return {
      path: item.path,
      title: item.title,
      reason: 'recording-review-required',
      ...(resolution.book ? { existingBookId: resolution.book.id } : {}),
    };
  }
  return 'proceed';
}
