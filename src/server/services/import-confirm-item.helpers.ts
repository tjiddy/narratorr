import type { FastifyBaseLogger } from 'fastify';
import { type BookService } from './book.service.js';
import { decideIntake } from './book-intake/index.js';
import type { HeldReviewItem } from '@shared/schemas/library-scan.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import { isAttachableStatus } from '@shared/attach-eligibility.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { ImportConfirmItem } from './library-scan.service.js';

function resolveDedupeAsin(item: ImportConfirmItem): string | undefined {
  return item.asin ?? item.metadata?.asin;
}

/** Omitted fields must stay omitted all the way to the candidate, so each is spread conditionally. */
function toIntakeItem(item: ImportConfirmItem) {
  const dedupeAsin = resolveDedupeAsin(item);
  return {
    title: item.title,
    ...(item.authorName ? { authors: [{ name: item.authorName }] } : {}),
    ...(dedupeAsin !== undefined && { asin: dedupeAsin }),
    ...(item.narrators !== undefined && { narrators: item.narrators }),
    ...(item.metadata?.duration !== undefined && { duration: item.metadata.duration }),
    // Preserve abridged/unabridged review when duration cannot decide.
    ...(item.metadata?.formatType ? { productionType: normalizeProductionType(item.metadata.formatType) } : {}),
  };
}

/** Owned duplicate result, optionally naming the incumbent for reporting. */
export type SkipClassification = { skip: true; existingBookId?: number; existingTitle?: string };

/** #2435: the incumbent owns no file, so this item fulfils it rather than duplicating it.
 * `status` is the OBSERVED prior status; the runner's guarded transition keys on it so a status
 * that moved between classification and the transaction rolls the attach back. */
export type AttachClassification = { attach: true; bookId: number; title: string; status: BookStatus };

/** Read-only classification: attach fileless same recordings, skip owned ones, hold ambiguous ones,
 * and proceed otherwise. */
export async function classifyConfirmItem(
  item: ImportConfirmItem,
  bookService: Pick<BookService, 'findDuplicate'>,
  log: FastifyBaseLogger,
): Promise<SkipClassification | AttachClassification | 'proceed' | HeldReviewItem> {
  // Force bypasses bibliographic dedup only; the copy-time collision fence still forbids overwrite.
  // Ordering is load-bearing: the decision module always queries, so the bypass must precede it.
  if (item.forceImport) return 'proceed';
  // No try/catch: a failure belongs to the runner's item-level boundary, which writes a terminal row.
  const decision = await decideIntake({ bookService }, { item: toIntakeItem(item) });
  if (decision.kind === 'same-recording') {
    // A fileless incumbent in an attachable status is what this file is for. Logged at info: an
    // attach changes an existing book, so it must be visible without enabling debug.
    if (decision.incumbent && !decision.incumbentHoldsFile && isAttachableStatus(decision.incumbent.status)) {
      log.info(
        { title: item.title, existingBookId: decision.incumbent.id, status: decision.incumbent.status },
        'Attaching import item to a fileless incumbent (same recording)',
      );
      return {
        attach: true,
        bookId: decision.incumbent.id,
        title: decision.incumbent.title,
        status: decision.incumbent.status,
      };
    }
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
