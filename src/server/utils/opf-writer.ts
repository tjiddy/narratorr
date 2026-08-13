import { extname, join, resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  OPF_FILENAME, OPF_BACKUP_FILENAME, NARRATORR_OPF_MARKER, hasNarratorrMarker,
} from '@core/utils/opf-regex.js';
import { AUDIO_EXTENSIONS } from '@core/utils/audio-constants.js';
import type { EventSource } from '@shared/schemas/event-history.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import { replaceFileAtomically } from './atomic-file-replace.js';
import { buildDivergenceReason, detectSidecarDivergence, type SidecarDivergence } from './opf-divergence.js';
import { claimOpfBackupDestination, OpfBackupClaimError, readOpfEntry } from './opf-entry-policy.js';
import { parseOpfWithDiagnostics, type OpfParseOutcome } from './opf-reader.js';
import { withPathWriteLock } from './path-write-lock.js';
import { serializeError } from './serialize-error.js';

/** XML 1.0 forbids these C0 controls but permits tab, LF, and CR. */
// eslint-disable-next-line no-control-regex
const XML_INVALID_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** Escape XML text and attributes; ampersand must go first to avoid double escaping. */
function escapeXml(value: string): string {
  return value
    // Strip invalid controls before entity escaping.
    .replace(XML_INVALID_CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate the exact OPF 2.0 element, role, scheme, and adjacent-series shapes that
 * Audiobookshelf consumes. Optional fields are omitted; series position zero is valid.
 */
export function generateOpf(book: BookWithAuthor): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
    // Provenance permits later overwrite or managed cleanup.
    `    ${NARRATORR_OPF_MARKER}`,
    `    <dc:title>${escapeXml(book.title)}</dc:title>`,
  ];

  if (book.subtitle) lines.push(`    <dc:subtitle>${escapeXml(book.subtitle)}</dc:subtitle>`);

  for (const author of book.authors) {
    lines.push(`    <dc:creator opf:role="aut">${escapeXml(author.name)}</dc:creator>`);
  }
  for (const narrator of book.narrators) {
    lines.push(`    <dc:creator opf:role="nrt">${escapeXml(narrator.name)}</dc:creator>`);
  }

  if (book.description) lines.push(`    <dc:description>${escapeXml(book.description)}</dc:description>`);
  if (book.publisher) lines.push(`    <dc:publisher>${escapeXml(book.publisher)}</dc:publisher>`);
  if (book.publishedDate) lines.push(`    <dc:date>${escapeXml(book.publishedDate)}</dc:date>`);

  if (book.asin) lines.push(`    <dc:identifier opf:scheme="ASIN">${escapeXml(book.asin)}</dc:identifier>`);
  if (book.isbn) lines.push(`    <dc:identifier opf:scheme="ISBN">${escapeXml(book.isbn)}</dc:identifier>`);

  if (book.seriesName) {
    lines.push(`    <meta name="calibre:series" content="${escapeXml(book.seriesName)}"/>`);
    // Position zero is valid.
    if (book.seriesPosition != null) {
      lines.push(`    <meta name="calibre:series_index" content="${escapeXml(String(book.seriesPosition))}"/>`);
    }
  }

  for (const genre of book.genres ?? []) {
    lines.push(`    <dc:subject>${escapeXml(genre)}</dc:subject>`);
  }

  lines.push('  </metadata>', '</package>', '');
  return lines.join('\n');
}

/**
 * Opt-in at the import call sites only (#2297). `refreshOpfForBook` and `reconcileBookSidecars`
 * omit it: the operator just authored the value there, so a `.bak` beside all 786 books and a
 * sidecar that stops following an edit are the worse failure.
 */
export interface DivergencePreservation {
  /**
   * Recorded on the event. Structurally required so preservation cannot be enabled with nothing
   * valid to pass to `create` — and the writer never infers it, since a divergence must not be
   * attributed to the wrong import path.
   */
  source: EventSource;
  /** `ImportOrchestrator`'s is optional; the backup is written and logged with or without it. */
  eventHistory?: EventHistoryService | undefined;
}

export interface WriteOpfForImportArgs {
  /** The `tagging.writeOpf` gate. */
  enabled: boolean;
  bookService: BookService;
  bookId: number;
  bookFolder: string;
  log: FastifyBaseLogger;
  /**
   * Fires exactly once on every `failed` outcome, with the original caught value — except for a
   * refused `metadata.opf.bak` claim, which has no caught cause and passes an
   * {@link OpfBackupClaimError} naming the destination and the state it refused.
   */
  onFailure?: ((cause: unknown) => void) | undefined;
  preserve?: DivergencePreservation | undefined;
}

export type OpfWriteOutcome = 'written' | 'skipped' | 'failed';

/** The lock key every sidecar writer — and the cross-volume rename fallback — agrees on. */
export function sidecarLockKey(bookFolder: string): string {
  return resolve(join(bookFolder, OPF_FILENAME));
}

/**
 * Load fresh metadata and await the canonical sidecar write. Return an outcome instead of
 * throwing, and never overwrite a foreign OPF.
 */
export async function writeOpfSidecar(args: WriteOpfForImportArgs): Promise<OpfWriteOutcome> {
  const { enabled, bookId, bookFolder, log } = args;
  if (!enabled) return 'skipped';

  // A pointer import has no dedicated folder; writing beside it could clobber shared metadata.
  // It returns before acquiring anything.
  if (AUDIO_EXTENSIONS.has(extname(bookFolder).toLowerCase())) {
    log.warn({ bookId, bookFolder }, 'OPF write skipped — pointer single-file import has no dedicated book folder');
    return 'skipped';
  }

  // All four writers serialize, including the two that never preserve: those are exactly the
  // writers that would otherwise land inside an import's read-to-write window and make the
  // backup capture bytes that were never the ones replaced.
  return withPathWriteLock(sidecarLockKey(bookFolder), () => runSidecarWrite(args));
}

function ownsFolder(book: BookWithAuthor, bookFolder: string): boolean {
  // `books.path` is stored POSIX-normalized while a caller's value can carry platform separators
  // or a trailing slash; a raw string comparison would silently disable sidecar writes everywhere.
  return book.path != null && resolve(book.path) === resolve(bookFolder);
}

async function runSidecarWrite(args: WriteOpfForImportArgs): Promise<OpfWriteOutcome> {
  const { bookService, bookId, bookFolder, log, onFailure } = args;
  const opfPath = join(bookFolder, OPF_FILENAME);

  try {
    const book = await bookService.getById(bookId);
    if (!book) {
      log.warn({ bookId }, 'OPF write skipped — book not found');
      return 'skipped';
    }
    // Ahead of every disk touch: a writer queued behind a completed deletion, rejection, or
    // re-import cleanup must skip rather than resurrect a sidecar in a folder it no longer owns.
    if (!ownsFolder(book, bookFolder)) {
      log.warn({ bookId, bookFolder, bookPath: book.path }, 'OPF write skipped — the book no longer owns this folder');
      return 'skipped';
    }

    const generated = generateOpf(book);
    const existing = await readOpfEntry(opfPath);

    if (existing.kind === 'non-regular') {
      log.warn({ opfPath }, 'Existing metadata.opf is not a regular file — skipping OPF write to preserve it');
      return 'skipped';
    }
    if (existing.kind === 'unreadable') {
      log.warn({ opfPath, error: serializeError(existing.error) }, 'Could not read existing metadata.opf — skipping OPF write to avoid clobbering a foreign file');
      return 'skipped';
    }
    if (existing.kind === 'absent') {
      // Nothing to preserve, so this stays a plain write; the parse warning still fires.
      parseGeneratedWithWarning(generated, bookId, log);
      await replaceFileAtomically(opfPath, generated);
      log.info({ bookId, opfPath }, 'Wrote metadata.opf sidecar');
      return 'written';
    }
    if (!hasNarratorrMarker(existing.text)) {
      log.warn({ opfPath }, 'Existing metadata.opf is foreign (no narratorr marker) — skipping OPF write to preserve it');
      return 'skipped';
    }

    await replaceMarkedSidecar(args, opfPath, book, generated, existing.bytes, existing.text);
    return 'written';
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId }, 'Failed to write metadata.opf — continuing');
    onFailure?.(error);
    return 'failed';
  }
}

/** `generateOpf` emitting `<dc:title>` does not guarantee the document parses — a title of a lone
 * C0 control is accepted by the book schema, stripped by `escapeXml`, and recovered as `null`. */
function parseGeneratedWithWarning(generated: string, bookId: number, log: FastifyBaseLogger): OpfParseOutcome {
  const outcome = parseOpfWithDiagnostics(generated);
  if (outcome.metadata === null) {
    log.warn({ bookId }, 'Generated metadata.opf yields no recoverable metadata — writing it anyway');
  }
  return outcome;
}

async function replaceMarkedSidecar(
  args: WriteOpfForImportArgs,
  opfPath: string,
  book: BookWithAuthor,
  generated: string,
  existingBytes: Buffer,
  existingText: string,
): Promise<void> {
  const { bookId, bookFolder, log, preserve } = args;

  // Byte-equal is quiet and short-circuits before any parse, so two identical unparseable files
  // are silent. The comparison is on BUFFERS: it makes "byte-equal" literal, and a malformed
  // sidecar that merely decodes to the same text still fails it and is preserved.
  let preserved = false;
  if (!existingBytes.equals(Buffer.from(generated, 'utf-8'))) {
    const generatedParse = parseGeneratedWithWarning(generated, bookId, log);
    if (preserve) {
      const verdict = detectSidecarDivergence(parseOpfWithDiagnostics(existingText), generatedParse);
      if (verdict.diverged) {
        await preserveExistingSidecar(args, bookFolder, book, verdict.divergence, existingBytes, preserve);
        preserved = true;
      }
    }
  }

  await replaceFileAtomically(opfPath, generated);
  log.info({ bookId, opfPath, preserved }, 'Wrote metadata.opf sidecar');
}

/** Claim, back up, record — in that order, so the signal exists before the current file is gone. */
async function preserveExistingSidecar(
  args: WriteOpfForImportArgs,
  bookFolder: string,
  book: BookWithAuthor,
  divergence: SidecarDivergence,
  existingBytes: Buffer,
  preserve: DivergencePreservation,
): Promise<void> {
  const { bookId, log } = args;
  const backupPath = join(bookFolder, OPF_BACKUP_FILENAME);

  const claim = await claimOpfBackupDestination(backupPath);
  if (!claim.claimed) {
    log.warn(
      { bookId, backupPath, state: claim.state },
      'Refusing to claim metadata.opf.bak for the sidecar backup — leaving metadata.opf unchanged',
    );
    throw new OpfBackupClaimError(backupPath, claim.state);
  }

  await replaceFileAtomically(backupPath, existingBytes);
  await recordDivergence(args, book, divergence, preserve, backupPath);
}

/** Best-effort signal, never a precondition for the write (precedent: download-side-effects). */
async function recordDivergence(
  args: WriteOpfForImportArgs,
  book: BookWithAuthor,
  divergence: SidecarDivergence,
  preserve: DivergencePreservation,
  backupPath: string,
): Promise<void> {
  const { bookId, log } = args;
  if (!preserve.eventHistory) {
    log.warn(
      { bookId, backupPath, changed_fields: divergence.changedFields },
      'metadata.opf diverged and was preserved, but no event history service is wired to record it',
    );
    return;
  }

  try {
    await preserve.eventHistory.create({
      bookId,
      bookTitle: book.title,
      authorName: book.authors[0]?.name ?? null,
      narratorName: book.narrators[0]?.name ?? null,
      eventType: 'sidecar_diverged',
      source: preserve.source,
      reason: buildDivergenceReason(divergence),
    });
  } catch (error: unknown) {
    log.warn(
      { error: serializeError(error), bookId },
      'Failed to record the sidecar_diverged event — continuing with the sidecar replacement',
    );
  }
}

/** Preserve the nonfatal void contract used by imports and per-book edits. */
export async function writeOpfForImport(args: WriteOpfForImportArgs): Promise<void> {
  await writeOpfSidecar(args);
}
