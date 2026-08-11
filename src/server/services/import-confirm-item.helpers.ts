import type { FastifyBaseLogger } from 'fastify';
import { type BookService } from './book.service.js';
import { decideIntake } from './book-intake/index.js';
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
  bookService: Pick<BookService, 'findDuplicate'>,
  log: FastifyBaseLogger,
): Promise<SkipClassification | 'proceed' | HeldReviewItem> {
  // Force bypasses bibliographic dedup only; the copy-time collision fence still forbids overwrite.
  // Ordering is load-bearing: the decision module always queries, so the bypass must precede it.
  if (item.forceImport) return 'proceed';
  const dedupeAsin = resolveDedupeAsin(item);
  // No try/catch: a failure belongs to the runner's item-level boundary, which writes a terminal row.
  const decision = await decideIntake({ bookService }, {
    item: {
      title: item.title,
      ...(item.authorName ? { authors: [{ name: item.authorName }] } : {}),
      ...(dedupeAsin !== undefined && { asin: dedupeAsin }),
      ...(item.narrators !== undefined && { narrators: item.narrators }),
      ...(item.metadata?.duration !== undefined && { duration: item.metadata.duration }),
      // Preserve abridged/unabridged review when duration cannot decide.
      ...(item.metadata?.formatType ? { productionType: normalizeProductionType(item.metadata.formatType) } : {}),
    },
  });
  if (decision.kind === 'same-recording') {
    log.debug({ title: item.title, existingBookId: decision.incumbent?.id }, 'Skipping owned duplicate during import (same recording)');
    return {
      skip: true,
      ...(decision.incumbent ? { existingBookId: decision.incumbent.id, existingTitle: decision.incumbent.title } : {}),
    };
  }
  if (decision.kind === 'review') {
    log.info({ title: item.title, existingBookId: decision.incumbent?.id }, 'Holding import item for recording review');
    return {
      path: item.path,
      title: item.title,
      reason: 'recording-review-required',
      ...(decision.incumbent ? { existingBookId: decision.incumbent.id } : {}),
    };
  }
  return 'proceed';
}
