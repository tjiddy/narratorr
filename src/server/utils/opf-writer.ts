import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { OPF_FILENAME } from '../../core/utils/opf-regex.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';
import { serializeError } from './serialize-error.js';

/**
 * Escape a string for safe inclusion in XML text or attribute values.
 *
 * `&` MUST be replaced first — it is the entity-introducer, so escaping it after the others would
 * double-escape the `&` in `&lt;`/`&quot;` etc. There is no XML-escape helper elsewhere in the
 * codebase (no `xmlbuilder`/`entities` dependency), so the writer escapes itself; an unescaped `&`
 * in a title makes the whole OPF malformed.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate an Audiobookshelf-compatible `metadata.opf` (OPF 2.0) from a resolved book record.
 *
 * Element/attribute shapes are fixed to exactly what ABS's `parseOpfMetadata.js` reads:
 * - `dc:title`
 * - one `dc:creator opf:role="aut"` per author and one `opf:role="nrt"` per narrator, in
 *   `BookWithAuthor` source order (ABS reads ALL matching creators into arrays).
 * - `dc:identifier opf:scheme="ASIN"` / `opf:scheme="ISBN"`
 * - series as the adjacent `<meta name="calibre:series">` then `<meta name="calibre:series_index">`
 * - `dc:subtitle`, `dc:description`, `dc:publisher`, `dc:date`, one `dc:subject` per genre.
 *
 * No `dc:language` (the books table has no language column — out of scope this phase) and no cover
 * reference (ABS does not read a cover from OPF). Optional fields that are null/empty are omitted
 * cleanly. `seriesPosition` is guarded with `!= null` so a legitimate position of `0` is emitted.
 */
export function generateOpf(book: BookWithAuthor): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
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
    // `!= null` (not truthy): a legitimate series position of 0 must still be emitted.
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
  /** Gate — the `tagging.writeOpf` setting. When false the helper is a no-op (no fresh load, no write). */
  enabled: boolean;
  bookService: BookService;
  bookId: number;
  /** The book folder the OPF is written into (`result.targetPath` auto / `finalPath` manual). */
  bookFolder: string;
  log: FastifyBaseLogger;
}

/**
 * Shared OPF generate + write helper, invoked from BOTH import surfaces (auto orchestrator and
 * manual/adopt). Loads a FRESH `BookWithAuthor` by id at write time — never a pre-import snapshot —
 * so a narrator (or other field) filled by import enrichment is present in the written file. The
 * OPF is a canonical on-disk artifact, so this is an awaited inline write (NOT the droppable
 * connector queue). Failure is nonfatal: logged at warn, import continues.
 */
export async function writeOpfForImport(args: WriteOpfForImportArgs): Promise<void> {
  const { enabled, bookService, bookId, bookFolder, log } = args;
  if (!enabled) return;

  try {
    const book = await bookService.getById(bookId);
    if (!book) {
      log.warn({ bookId }, 'OPF write skipped — book not found');
      return;
    }
    const opfPath = join(bookFolder, OPF_FILENAME);
    await writeFile(opfPath, generateOpf(book), 'utf-8');
    log.info({ bookId, opfPath }, 'Wrote metadata.opf sidecar');
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), bookId }, 'Failed to write metadata.opf — continuing');
  }
}
