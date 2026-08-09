import { readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { OPF_FILENAME, NARRATORR_OPF_MARKER, hasNarratorrMarker } from '@core/utils/opf-regex.js';
import { AUDIO_EXTENSIONS } from '@core/utils/audio-constants.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';
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

export interface WriteOpfForImportArgs {
  /** The `tagging.writeOpf` gate. */
  enabled: boolean;
  bookService: BookService;
  bookId: number;
  bookFolder: string;
  log: FastifyBaseLogger;
  /** Receives the original caught value when the string outcome is `failed`. */
  onFailure?: ((cause: unknown) => void) | undefined;
}

/** Write only absent or narratorr-marked OPFs; unreadable ownership fails safe. */
async function mayWriteOpf(opfPath: string, log: FastifyBaseLogger): Promise<boolean> {
  let existing: string;
  try {
    existing = await readFile(opfPath, 'utf-8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    log.warn({ opfPath, error: serializeError(error) }, 'Could not read existing metadata.opf — skipping OPF write to avoid clobbering a foreign file');
    return false;
  }
  if (hasNarratorrMarker(existing)) return true;
  log.warn({ opfPath }, 'Existing metadata.opf is foreign (no narratorr marker) — skipping OPF write to preserve it');
  return false;
}

export type OpfWriteOutcome = 'written' | 'skipped' | 'failed';

/**
 * Load fresh metadata and await the canonical sidecar write. Return an outcome instead of
 * throwing, and never overwrite a foreign OPF.
 */
export async function writeOpfSidecar(args: WriteOpfForImportArgs): Promise<OpfWriteOutcome> {
  const { enabled, bookService, bookId, bookFolder, log, onFailure } = args;
  if (!enabled) return 'skipped';

  // A pointer import has no dedicated folder; writing beside it could clobber shared metadata.
  if (AUDIO_EXTENSIONS.has(extname(bookFolder).toLowerCase())) {
    log.warn({ bookId, bookFolder }, 'OPF write skipped — pointer single-file import has no dedicated book folder');
    return 'skipped';
  }

  try {
    const book = await bookService.getById(bookId);
    if (!book) {
      log.warn({ bookId }, 'OPF write skipped — book not found');
      return 'skipped';
    }
    const opfPath = join(bookFolder, OPF_FILENAME);
    if (!(await mayWriteOpf(opfPath, log))) return 'skipped';
    await writeFile(opfPath, generateOpf(book), 'utf-8');
    log.info({ bookId, opfPath }, 'Wrote metadata.opf sidecar');
    return 'written';
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId }, 'Failed to write metadata.opf — continuing');
    onFailure?.(error);
    return 'failed';
  }
}

/** Preserve the nonfatal void contract used by imports and per-book edits. */
export async function writeOpfForImport(args: WriteOpfForImportArgs): Promise<void> {
  await writeOpfSidecar(args);
}
