/**
 * Per-item confirm/import processing (#1711/#1822). Extracted from
 * `import-orchestration.helpers.ts` to keep that file under the line cap and to keep
 * `confirmImport` a thin bucket-collecting loop. Each confirm item resolves to exactly
 * one outcome — accepted / held / skipped / failed — so a no-op import (everything
 * refused or errored) is a reported disposition, never a silent drop.
 */
import type { FastifyBaseLogger } from 'fastify';
import { OwnedRecordingError, type BookService } from './book.service.js';
import type { HeldReviewItem, ImportSkippedItem, ImportFailedItem } from '../../shared/schemas/library-scan.js';
import { normalizeProductionType } from '../../core/metadata/production-type.js';
import { buildBookCreatePayload } from './enrichment-orchestration.helpers.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import type { ImportConfirmItem, ImportMode } from './library-scan.service.js';
import { serializeError } from '../utils/serialize-error.js';
import type { ManualImportJobPayload } from './import-adapters/types.js';
import type { ImportPipelineDeps } from './import-orchestration.helpers.js';

/** The confirm dedup ASIN (#1662): the explicit top-level `asin`, else the matched metadata's. */
function resolveDedupeAsin(item: ImportConfirmItem): string | undefined {
  return item.asin ?? item.metadata?.asin;
}

/**
 * The outcome of processing a single confirm item — the caller pushes it into the
 * matching `ImportResult` bucket. Exactly one variant per item (conservation).
 */
export type ConfirmItemOutcome =
  | { kind: 'accepted'; bookId: number; item: ImportConfirmItem }
  | { kind: 'held'; held: HeldReviewItem }
  | { kind: 'skipped'; skipped: ImportSkippedItem }
  | { kind: 'failed'; failed: ImportFailedItem };

/**
 * Pre-copy recording-identity classification for a confirm item (#1711). Threads
 * candidate narrators + matched ASIN + duration into the three-way `findDuplicate`:
 *  - `same-recording` → a `SkipClassification` (owned, plain not-accepted skip — NOT
 *    held). Carries the incumbent's id/title (#1822) so the caller can report
 *    "already in your library as '{title}'" instead of a silent drop.
 *  - `review`/no-signal → a `HeldReviewItem` (not copied, not enqueued).
 *  - `different-recording` (or `forceImport`) → `'proceed'`.
 */
type SkipClassification = { skip: true; existingBookId?: number; existingTitle?: string };

async function classifyConfirmItem(
  item: ImportConfirmItem,
  bookService: BookService,
  log: FastifyBaseLogger,
): Promise<SkipClassification | 'proceed' | HeldReviewItem> {
  // Force contract (#1736), confirm-time half: `forceImport` means "bypass the confirm-time
  // BIBLIOGRAPHIC dedup (skip/hold) and proceed to copy". It does NOT promise an overwrite — the
  // copy-time on-disk collision fence in `resolveOccupiedTarget` is independent and still fails
  // closed for an occupied target (never overwrites). The two agree: force gets you past confirm,
  // but an ambiguous on-disk target is refused LOUDLY via the worker's refused terminal disposition
  // (a structured `forced-import-refused` failure + placeholder cleanup), not silently swapped.
  if (item.forceImport) return 'proceed';
  const dedupeAsin = resolveDedupeAsin(item);
  const resolution = await bookService.findDuplicate({
    title: item.title,
    ...(item.authorName ? { authors: [{ name: item.authorName }] } : {}),
    ...(dedupeAsin !== undefined && { asin: dedupeAsin }),
    ...(item.narrators !== undefined && { narrators: item.narrators }),
    ...(item.metadata?.duration !== undefined && { duration: item.metadata.duration }),
    // Production form (#1728): pass the normalized matched format so an
    // abridged-vs-unabridged confirm with no usable duration holds for review.
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

/** Map a `same-recording` skip classification onto a reported `already-in-library` skip. */
function ownedSkip(item: ImportConfirmItem, c: SkipClassification): ConfirmItemOutcome {
  return {
    kind: 'skipped',
    skipped: {
      path: item.path,
      title: item.title,
      reason: 'already-in-library',
      ...(c.existingBookId !== undefined && { existingBookId: c.existingBookId }),
      ...(c.existingTitle !== undefined && { existingTitle: c.existingTitle }),
    },
  };
}

/**
 * Process a single confirm item into exactly one bucket outcome (#1822). Creates the
 * import placeholder + enqueues the job for a proceeding item, and cleans up the
 * placeholder on any created-but-not-accepted exit so no orphaned `importing` row is
 * stranded. Failure messages are user-facing — the raw error stays in the logs.
 */
export async function processConfirmItem(
  item: ImportConfirmItem,
  deps: ImportPipelineDeps,
  mode: ImportMode | undefined,
): Promise<ConfirmItemOutcome> {
  const { log, bookService, bookImportService, eventHistory } = deps;
  // Track a placeholder created below so any created-but-not-accepted exit cleans it up.
  let createdBookId: number | undefined;
  try {
    const classification = await classifyConfirmItem(item, bookService, log);
    if (classification !== 'proceed' && 'skip' in classification) return ownedSkip(item, classification);
    if (classification !== 'proceed') return { kind: 'held', held: classification };

    log.debug(
      { title: item.title, author: item.authorName, hasMetadata: !!item.metadata, asin: item.asin || item.metadata?.asin },
      'Creating import placeholder',
    );

    const book = await bookService.create(buildBookCreatePayload(item, item.metadata ?? null, 'importing'));
    createdBookId = book.id;

    // Build the persisted payload — mode omitted for pointer mode
    const payload: ManualImportJobPayload = { ...item };
    if (mode) payload.mode = mode;

    const enqueued = await bookImportService.enqueue({ bookId: book.id, type: 'manual', metadata: JSON.stringify(payload) });

    if ('error' in enqueued) {
      // Rare/defensive: the freshly-created placeholder bookId already has an active job.
      // Report an already-importing skip and delete the orphaned placeholder.
      log.warn({ bookId: book.id, title: item.title }, 'Manual import skipped — active job already exists for book');
      await bookService.delete(book.id).catch(err =>
        log.warn({ error: serializeError(err), bookId: book.id }, 'Failed to delete orphaned placeholder after enqueue conflict'));
      return { kind: 'skipped', skipped: { path: item.path, title: item.title, reason: 'already-importing' } };
    }

    eventHistory.create({ bookId: book.id, ...snapshotBookForEvent(book), eventType: 'book_added', source: 'manual' })
      .catch(err => log.warn({ error: serializeError(err) }, 'Failed to record book_added event'));

    return { kind: 'accepted', bookId: book.id, item };
  } catch (error: unknown) {
    // Same-ASIN create-time race (#1711): the recording is already owned — a plain
    // not-accepted skip carrying the incumbent (#1822), NOT a hard failure. The create
    // threw, so no placeholder exists to clean up here.
    if (error instanceof OwnedRecordingError) {
      log.debug({ title: item.title, existingBookId: error.existingBookId }, 'Skipping owned duplicate during import (ASIN race)');
      return {
        kind: 'skipped',
        skipped: { path: item.path, title: item.title, reason: 'already-in-library', existingBookId: error.existingBookId, existingTitle: error.bookTitle },
      };
    }
    log.error({ error: serializeError(error), title: item.title }, 'Failed to create placeholder for import');
    // A non-`active-job-exists` throw after the placeholder was created leaves it orphaned
    // in `importing` — delete it (#1822). Best-effort; the failure is reported regardless.
    if (createdBookId !== undefined) {
      await bookService.delete(createdBookId).catch(err =>
        log.warn({ error: serializeError(err), bookId: createdBookId }, 'Failed to delete orphaned placeholder after import failure'));
    }
    return { kind: 'failed', failed: { path: item.path, title: item.title, message: 'Import failed — see server logs for details.' } };
  }
}
